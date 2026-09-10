import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, rename, unlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { EnvHttpProxyAgent, request } from "undici";
import { FILE_LIMIT, GEOMETRY_CACHE_LIMIT, TOTAL_LIMIT } from "./limits.js";
import { checkUrl, sha256 } from "./source.js";

export const GEOMETRY_CACHE=fileURLToPath(new URL("../../../.local/city-build/geometry/",import.meta.url));
type GeometryFile={path:string;digest:string;bytes:number;hit:boolean};
export type GeometryDownload=(url:string,limit:number)=>Promise<GeometryFile>;
type Consume=(bytes:number)=>void;
type FetchGeometry=(url:string,path:string,limit:number,consume:Consume)=>Promise<{digest:string;bytes:number}>;
const TTL=86_400_000;

/** Backpressure keeps only stream chunks in memory. Partial responses are never published. */
export async function fetchGeometry(url:string,path:string,limit:number,consume:Consume=()=>{},transport=request):Promise<{digest:string;bytes:number}>{
  const dispatcher=new EnvHttpProxyAgent(),signal=AbortSignal.timeout(90_000);
  const temporary=`${path}.${randomUUID()}.partial`;
  try{
    let destination=checkUrl(url);
    for(let redirects=0;redirects<=5;redirects++){
      const response=await transport(destination,{dispatcher,signal,headersTimeout:25_000,bodyTimeout:25_000,
        headers:{"user-agent":"dopagaki-town-city-demo/2.0","accept-encoding":"identity"}});
      response.body.on("error",()=>{});
      if([301,302,303,307,308].includes(response.statusCode)){
        response.body.destroy();const location=response.headers.location;
        if(typeof location!=="string")throw new Error("SOURCE_UNAVAILABLE");
        destination=checkUrl(new URL(location,destination).href);continue;
      }
      try{
        if(response.statusCode!==200)throw new Error("SOURCE_UNAVAILABLE");
        const rawSize=response.headers["content-length"];
        const expected=rawSize===undefined?undefined:Number(rawSize);
        if(expected!==undefined&&(!Number.isSafeInteger(expected)||expected<1||expected>limit))throw new Error("SOURCE_TOO_LARGE");
        if(response.headers["content-encoding"]&&response.headers["content-encoding"]!=="identity")throw new Error("SOURCE_UNAVAILABLE");
        const hash=createHash("sha256");let bytes=0;
        await pipeline(response.body,async function*(chunks){
          for await(const raw of chunks){
            const chunk=raw as Buffer;bytes+=chunk.length;
            if(bytes>limit)throw new Error("SOURCE_TOO_LARGE");
            consume(chunk.length);hash.update(chunk);yield chunk;
          }
        },createWriteStream(temporary,{flags:"wx"}),{signal});
        if(!bytes||(expected!==undefined&&bytes!==expected))throw new Error("SOURCE_UNAVAILABLE");
        await rename(temporary,path);
        return {digest:hash.digest("hex"),bytes};
      }finally{response.body.destroy();}
    }
    throw new Error("SOURCE_REDIRECT_LIMIT");
  }catch(error){
    if(error instanceof Error&&/^[A-Z_]{3,60}$/.test(error.message))throw error;
    throw new Error(signal.aborted?"SOURCE_TIMEOUT":"SOURCE_UNAVAILABLE",{cause:error});
  }finally{await unlink(temporary).catch(()=>{});await dispatcher.destroy();}
}

/** One client per build; reserve disk space before starting its two download streams. */
export async function geometryClient(urls:readonly string[],directory=GEOMETRY_CACHE,fetchSource:FetchGeometry=fetchGeometry):Promise<GeometryDownload>{
  const protectedNames=new Set(urls.map(url=>sha256(checkUrl(url))));
  await mkdir(directory,{recursive:true});
  const files=(await Promise.all((await readdir(directory)).map(async name=>{
    try{return {name,path:join(directory,name),info:await lstat(join(directory,name))};}catch{return undefined;}
  }))).filter(file=>file!==undefined).filter(file=>file.info.isFile()).sort((a,b)=>a.info.mtimeMs-b.info.mtimeMs);
  let diskBytes=files.reduce((n,file)=>n+file.info.size,0);
  for(const file of files){
    const age=Date.now()-file.info.mtimeMs;
    const stalePartial=file.name.endsWith(".partial")&&age>300_000;
    const unused=/^[a-f0-9]{64}$/.test(file.name)&&!protectedNames.has(file.name);
    if(stalePartial||(unused&&(age>=TTL||diskBytes>GEOMETRY_CACHE_LIMIT-TOTAL_LIMIT))){
      await unlink(file.path);diskBytes-=file.info.size;
    }
  }
  if(diskBytes>GEOMETRY_CACHE_LIMIT-TOTAL_LIMIT)throw new Error("SOURCE_CACHE_FULL");
  let received=0;
  const consume:Consume=bytes=>{received+=bytes;if(received>TOTAL_LIMIT)throw new Error("SOURCE_TOO_LARGE");};
  return async(url,limit)=>{
    const name=sha256(checkUrl(url));if(!protectedNames.has(name))throw new Error("SOURCE_URL_REJECTED");
    limit=Math.min(limit,FILE_LIMIT);const path=join(directory,name);
    const info=await lstat(path).catch(()=>undefined);
    if(info?.isFile()&&info.size>0&&info.size<=limit&&Date.now()-info.mtimeMs<TTL){
      const hash=createHash("sha256");let bytes=0;
      for await(const raw of createReadStream(path)){
        const chunk=raw as Buffer;bytes+=chunk.length;if(bytes>limit)throw new Error("SOURCE_TOO_LARGE");
        consume(chunk.length);hash.update(chunk);
      }
      if(bytes!==info.size)throw new Error("SOURCE_CHANGED");
      // Keep acquisition time for the 24-hour TTL; cache hits do not extend freshness.
      await utimes(path,new Date(),info.mtime);
      return {path,digest:hash.digest("hex"),bytes,hit:true};
    }
    const result=await fetchSource(url,path,limit,consume);
    return {...result,path,hit:false};
  };
}
