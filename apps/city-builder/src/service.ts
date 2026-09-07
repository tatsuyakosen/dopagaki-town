import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { z } from "zod";
import { CityManifestSchema } from "../../../packages/contracts/src/city.js";
import { CatalogSchema, type Catalog, type Quality } from "./contracts.js";
import { cityPlannerEnabled, planCity } from "../../director-api/src/city-planner.js";

const root=fileURLToPath(new URL("../../../",import.meta.url));
const stages=`${root}.local/city-build/stages`;
const catalogDirectory=`${root}.local/city-build/catalogs`;
const TTL=24*60*60*1000;
const hash=(text:string)=>createHash("sha256").update(text).digest("hex").slice(0,24);
const BuildResultSchema=z.object({manifest:CityManifestSchema,stats:z.record(z.string(),z.number().finite())});
type Progress={phase:string;completed?:number;total?:number;bytes?:number};
export interface Job {id:string;state:"running"|"ready"|"failed"|"cancelled";phase:string;createdAt:number;updatedAt:number;progress:Progress;provider:string;stageId?:string;stats?:Record<string,number>;code?:string}
type Entry={catalog:Catalog;createdAt:number};

export function runWorker(request:unknown, signal:AbortSignal, progress:(value:Progress)=>void=()=>{}):Promise<unknown> {
  return new Promise((resolve,reject)=>{
    signal.throwIfAborted();
    const environment:NodeJS.ProcessEnv={PATH:process.env.PATH ?? "",TSX_DISABLE_CACHE:"1"};
    // Preserve configured network transport, while keeping AI keys out of the converter.
    for(const name of ["HTTP_PROXY","HTTPS_PROXY","NO_PROXY","http_proxy","https_proxy","no_proxy","SSL_CERT_FILE","SSL_CERT_DIR","NODE_EXTRA_CA_CERTS","SystemRoot","TEMP","TMP"]){if(process.env[name])environment[name]=process.env[name];}
    const child=spawn(process.execPath,["--import",fileURLToPath(import.meta.resolve("tsx")),`${root}scripts/city-worker.ts`],{cwd:root,stdio:["pipe","pipe","ignore"],env:environment});
    let buffer="",bytes=0,result:unknown,code="WORKER_FAILED";
    const stop=()=>{child.kill("SIGKILL");};
    const timer=setTimeout(()=>{code="BUILD_TIMEOUT";stop();},240_000);
    signal.addEventListener("abort",stop,{once:true});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data",(chunk:string)=>{
      bytes+=Buffer.byteLength(chunk);
      if(bytes>8*1024*1024){code="GEOMETRY_BUDGET";stop();return;}
      buffer+=chunk;
      for(let at=buffer.indexOf("\n");at>=0;at=buffer.indexOf("\n")){
        const line=buffer.slice(0,at);buffer=buffer.slice(at+1);
        try{
          const message=z.object({event:z.string(),code:z.string().optional(),value:z.unknown().optional(),phase:z.string().optional(),completed:z.number().optional(),total:z.number().optional(),bytes:z.number().optional()}).passthrough().parse(JSON.parse(line) as unknown);
          if(message.event==="result")result=message.value;
          else if(message.event==="error")code=message.code??"WORKER_FAILED";
          else if(message.event==="progress")progress({phase:message.phase??"build",...(message.completed===undefined?{}:{completed:message.completed}),...(message.total===undefined?{}:{total:message.total}),...(message.bytes===undefined?{}:{bytes:message.bytes})});
        }catch{code="WORKER_OUTPUT_INVALID";stop();}
      }
    });
    child.on("error",()=>{clearTimeout(timer);signal.removeEventListener("abort",stop);reject(new Error("DEPENDENCIES_MISSING"));});
    child.on("close",exitCode=>{clearTimeout(timer);signal.removeEventListener("abort",stop);if(signal.aborted)reject(new Error("CANCELLED"));else if(exitCode===0&&result!==undefined)resolve(result);else reject(new Error(code));});
    child.stdin.on("error",()=>{});
    child.stdin.end(JSON.stringify(request));
  });
}

export class CityBuilder {
  constructor(private worker=runWorker,private planner=planCity){}
  private catalogs=new Map<string,Entry>();
  private jobs=new Map<string,Job>();
  private completed=new Map<string,string>();
  private active:{id:string;controller:AbortController}|undefined;
  private discovering=false;
  status():{planner:string;busy:boolean}{return {planner:cityPlannerEnabled()?"gemini-adk":"rules",busy:Boolean(this.active)};}
  async discover(latitude:number,longitude:number):Promise<{id:string;catalog:Catalog}> {
    if(this.discovering)throw new Error("BUSY");
    const key=hash(JSON.stringify([latitude,longitude]));const previous=this.catalogs.get(key);
    if(previous && Date.now()-previous.createdAt<15*60*1000)return {id:key,catalog:previous.catalog};
    this.discovering=true;
    try{
      if(this.worker===runWorker)try{
        const path=`${catalogDirectory}/${key}.json`;const info=await stat(path);
        if(Date.now()-info.mtimeMs<15*60*1000 && info.size<16*1024){
          const catalog=CatalogSchema.parse(JSON.parse(await readFile(path,"utf8")) as unknown);
          if(catalog.latitude===latitude && catalog.longitude===longitude){this.catalogs.set(key,{catalog,createdAt:info.mtimeMs});return {id:key,catalog};}
        }
      }catch{/* A missing/expired cache requires a new catalog check. */}
      const catalog=CatalogSchema.parse(await this.worker({action:"discover",latitude,longitude},AbortSignal.timeout(90_000)));
      this.catalogs.delete(key);this.catalogs.set(key,{catalog,createdAt:Date.now()});
      while(this.catalogs.size>16)this.catalogs.delete(this.catalogs.keys().next().value!);
      if(this.worker===runWorker){
        await mkdir(catalogDirectory,{recursive:true});
        await writeFile(`${catalogDirectory}/${key}.tmp`,JSON.stringify(catalog));await rename(`${catalogDirectory}/${key}.tmp`,`${catalogDirectory}/${key}.json`);
        const files=await Promise.all((await readdir(catalogDirectory)).map(async name=>({name,time:(await stat(`${catalogDirectory}/${name}`)).mtimeMs})));
        for(const file of files.sort((a,b)=>b.time-a.time).slice(16))await unlink(`${catalogDirectory}/${file.name}`);
      }
      return {id:key,catalog};
    }finally{this.discovering=false;}
  }
  start(catalogId:string,quality:Quality):Job {
    const entry=this.catalogs.get(catalogId);
    if(!entry || Date.now()-entry.createdAt>15*60*1000)throw new Error("CATALOG_EXPIRED");
    const key=hash(JSON.stringify(["converter-ts-v1",entry.catalog,quality,this.status().planner]));
    const previous=this.jobs.get(this.completed.get(key)??"");
    if(previous?.stageId && Date.now()-previous.createdAt<TTL && existsSync(`${stages}/${previous.stageId}.json`) && existsSync(`${stages}/${previous.stageId}.gz`))return previous;
    if(this.active)throw new Error("BUSY");
    const id=randomBytes(12).toString("hex");const controller=new AbortController();
    const job:Job={id,state:"running",phase:"plan",provider:this.status().planner,createdAt:Date.now(),updatedAt:Date.now(),progress:{phase:"plan"}};
    this.jobs.set(id,job);this.active={id,controller};
    while(this.jobs.size>16)this.jobs.delete(this.jobs.keys().next().value!);
    void this.execute(job,key,entry.catalog,quality,controller);
    return job;
  }
  private async execute(job:Job,key:string,catalog:Catalog,quality:Quality,controller:AbortController):Promise<void> {
    let timedOut=false;
    const temporaryFiles:string[]=[];
    const timeout=setTimeout(()=>{timedOut=true;controller.abort();},240_000);
    try{
      const plan=await this.planner(catalog,quality,AbortSignal.any([controller.signal,AbortSignal.timeout(30_000)]));
      job.provider=plan.provider;
      const raw=await this.worker({action:"build",catalog,lod:plan.lod},controller.signal,p=>{job.progress=p;job.phase=p.phase;job.updatedAt=Date.now();});
      controller.signal.throwIfAborted();
      const result=BuildResultSchema.parse(raw);
      if(result.manifest.mode!=="survey")throw new Error("SURVEY_REQUIRED");
      const vertices=result.manifest.meshes.reduce((n,m)=>n+m.positions.length/3,0);
      if(vertices>(plan.lod===1?40_000:80_000)||result.manifest.meshes.length>600)throw new Error("GEOMETRY_BUDGET");
      const json=JSON.stringify(result.manifest);if(Buffer.byteLength(json)>4*1024*1024)throw new Error("GEOMETRY_BUDGET");
      const stageId=hash(json);const compressed=await promisify(gzip)(json);
      await mkdir(stages,{recursive:true});
      temporaryFiles.push(`${stages}/${stageId}.tmp`,`${stages}/${stageId}.gz.tmp`);
      await writeFile(`${stages}/${stageId}.tmp`,json);await writeFile(`${stages}/${stageId}.gz.tmp`,compressed);
      controller.signal.throwIfAborted();
      await rename(`${stages}/${stageId}.tmp`,`${stages}/${stageId}.json`);await rename(`${stages}/${stageId}.gz.tmp`,`${stages}/${stageId}.gz`);
      controller.signal.throwIfAborted();
      job.stageId=stageId;job.stats={...result.stats,gzipBytes:compressed.length,totalSeconds:(Date.now()-job.createdAt)/1000,lod:plan.lod};
      job.state="ready";job.phase="ready";this.completed.set(key,job.id);
      while(this.completed.size>16)this.completed.delete(this.completed.keys().next().value!);
      await pruneStages();
    }catch(error){
      job.state=controller.signal.aborted&&!timedOut?"cancelled":"failed";
      const code=error instanceof Error?error.message:"BUILD_FAILED";
      job.code=timedOut?"BUILD_TIMEOUT":/^[A-Z_]{3,60}$/.test(code)?code:"BUILD_FAILED";
    }finally{clearTimeout(timeout);await Promise.allSettled(temporaryFiles.map(path=>unlink(path)));job.updatedAt=Date.now();if(this.active?.id===job.id)this.active=undefined;}
  }
  get(id:string):Job|undefined{return this.jobs.get(id);}
  cancel(id:string):void{if(this.active?.id===id){this.active.controller.abort();const job=this.jobs.get(id);if(job)job.state="cancelled";}}
}

async function pruneStages():Promise<void>{
  const files=await Promise.all((await readdir(stages)).map(async name=>({name,info:await stat(`${stages}/${name}`)})));
  let total=files.reduce((n,f)=>n+f.info.size,0);
  for(const file of files.sort((a,b)=>a.info.mtimeMs-b.info.mtimeMs)){
    if(Date.now()-file.info.mtimeMs>TTL || total>64*1024*1024){await unlink(`${stages}/${file.name}`);total-=file.info.size;}
  }
}

export async function readStage(id:string,compressed:boolean):Promise<Buffer>{
  if(!/^[a-f0-9]{24}$/.test(id))throw new Error("NOT_FOUND");
  const path=`${stages}/${id}.${compressed?"gz":"json"}`;const info=await stat(path);
  if(info.size>4*1024*1024 || Date.now()-info.mtimeMs>TTL)throw new Error("NOT_FOUND");
  return readFile(path);
}
