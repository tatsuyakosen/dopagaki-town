import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EnvHttpProxyAgent, request } from "undici";
import { fromBuffer, type Entry } from "yauzl";
import { z } from "zod";
import { CatalogSchema, SelectionSchema, type Catalog } from "./contracts.js";
import { content, descendants, readXml, type XmlNode } from "./xml.js";

export const FILE_LIMIT=32*1024*1024,TOTAL_LIMIT=64*1024*1024;
export const CACHE=fileURLToPath(new URL("../../../.local/city-build/sources/",import.meta.url));
export const sha256=(value:string|Uint8Array):string=>createHash("sha256").update(value).digest("hex");
export type Download=(url:string,limit:number,cache?:boolean)=>Promise<{data:Buffer;hit:boolean}>;

export function checkUrl(value:string):string{
  let url:URL;try{url=new URL(value);}catch{throw new Error("SOURCE_URL_REJECTED");}
  if(url.protocol!=="https:"||!["api.plateauview.mlit.go.jp","assets.cms.plateau.reearth.io","cyberjapandata.gsi.go.jp"].includes(url.hostname)||url.port||url.username||url.password||url.hash)throw new Error("SOURCE_URL_REJECTED");
  if(url.hostname==="cyberjapandata.gsi.go.jp"&&(url.search||!/^\/xyz\/dem\/14\/\d{1,5}\/\d{1,5}\.txt$/.test(url.pathname)))throw new Error("SOURCE_URL_REJECTED");
  if(url.hostname==="assets.cms.plateau.reearth.io"&&(url.search||!url.pathname.startsWith("/assets/")))throw new Error("SOURCE_URL_REJECTED");
  return url.href;
}

/** Check every redirect before opening its destination; enforce size during streaming. */
export async function fetchBytes(url:string,limit:number,transport=request):Promise<Buffer>{
  const dispatcher=new EnvHttpProxyAgent();
  const signal=AbortSignal.timeout(60_000);
  try{
    let destination=checkUrl(url);
    for(let redirects=0;redirects<=5;redirects++){
      const response=await transport(destination,{dispatcher,signal,headersTimeout:25_000,bodyTimeout:25_000,
        headers:{"user-agent":"dopagaki-town-city-demo/2.0","accept-encoding":"identity"}});
      response.body.on("error",()=>{}); // Intentional cancellation can emit after destroy().
      if([301,302,303,307,308].includes(response.statusCode)){
        response.body.destroy();
        const location=response.headers.location;
        if(typeof location!=="string")throw new Error("SOURCE_UNAVAILABLE");
        destination=checkUrl(new URL(location,destination).href);continue;
      }
      try{
        if(response.statusCode!==200)throw new Error("SOURCE_UNAVAILABLE");
        const size=response.headers["content-length"];
        if(size!==undefined&&(!Number.isFinite(Number(size))||Number(size)>limit))throw new Error("SOURCE_TOO_LARGE");
        if(response.headers["content-encoding"]&&response.headers["content-encoding"]!=="identity")throw new Error("SOURCE_UNAVAILABLE");
        const chunks:Buffer[]=[];let bytes=0;
        for await(const raw of response.body){
          const chunk=raw as Buffer;bytes+=chunk.length;
          if(bytes>limit)throw new Error("SOURCE_TOO_LARGE");chunks.push(chunk);
        }
        return Buffer.concat(chunks,bytes);
      }finally{response.body.destroy();}
    }
    throw new Error("SOURCE_REDIRECT_LIMIT");
  }catch(error){
    if(error instanceof Error&&/^[A-Z_]{3,60}$/.test(error.message))throw error;
    throw new Error(signal.aborted?"SOURCE_TIMEOUT":"SOURCE_UNAVAILABLE",{cause:error});
  }finally{await dispatcher.destroy();}
}

/** Metadata-only size lookup for older catalogs; never download an unbounded body. */
export async function sourceSize(url:string,limit:number,transport=request):Promise<number>{
  const dispatcher=new EnvHttpProxyAgent(),signal=AbortSignal.timeout(30_000);
  try{
    let destination=checkUrl(url);
    for(let redirects=0;redirects<=5;redirects++){
      const response=await transport(destination,{method:"HEAD",dispatcher,signal,headersTimeout:15_000,bodyTimeout:15_000,headers:{"accept-encoding":"identity"}});
      response.body.on("error",()=>{});
      response.body.destroy();
      if([301,302,303,307,308].includes(response.statusCode)){
        const location=response.headers.location;if(typeof location!=="string")throw new Error("SOURCE_SIZE_UNKNOWN");destination=checkUrl(new URL(location,destination).href);continue;
      }
      if(response.statusCode!==200)throw new Error("SOURCE_SIZE_UNKNOWN");
      const raw=response.headers["content-length"];
      if(typeof raw!=="string"||!/^\d+$/.test(raw))throw new Error("SOURCE_SIZE_UNKNOWN");
      const size=Number(raw);if(!Number.isSafeInteger(size)||size<1)throw new Error("SOURCE_SIZE_UNKNOWN");
      if(size>limit)throw new Error("SOURCE_TOO_LARGE");return size;
    }throw new Error("SOURCE_REDIRECT_LIMIT");
  }catch(error){if(error instanceof Error&&/^[A-Z_]{3,60}$/.test(error.message))throw error;throw new Error("SOURCE_SIZE_UNKNOWN",{cause:error});}
  finally{await dispatcher.destroy();}
}

export function sourceClient(directory=CACHE,fetchSource=fetchBytes):Download{
  return async(url,limit,cache=true)=>{
    checkUrl(url);await mkdir(directory,{recursive:true});const path=join(directory,sha256(url));
    if(cache)try{
      const info=await stat(path);
      if(Date.now()-info.mtimeMs<86_400_000&&info.size<=limit)return {data:await readFile(path),hit:true};
    }catch{/* Missing cache entries are fetched again. */}
    const files=await Promise.all((await readdir(directory)).map(async name=>{
      try{return {path:join(directory,name),info:await stat(join(directory,name))};}catch{return undefined;}
    }));
    const present=files.filter(f=>f!==undefined).sort((a,b)=>a.info.mtimeMs-b.info.mtimeMs);
    let size=present.reduce((n,f)=>n+f.info.size,0);
    for(const file of present){if(size<=256*1024*1024-2*limit)break;await unlink(file.path).catch(()=>{});size-=file.info.size;}
    const data=await fetchSource(url,limit);
    if(data.length>limit)throw new Error("SOURCE_TOO_LARGE");
    if(cache){
      const temporary=`${path}.${process.pid}.partial`;
      try{await writeFile(temporary,data);await rename(temporary,path);}finally{await unlink(temporary).catch(()=>{});}
    }
    return {data,hit:false};
  };
}

/** Read exactly one general license record; never extract archive paths to disk. */
export function licenseXml(data:Buffer,cityCode:string,year:number):Promise<Buffer>{
  if(data.length>8*1024*1024||!/^\d{5}$/.test(cityCode)||!Number.isInteger(year))return Promise.reject(new Error("LICENSE_REVIEW_REQUIRED"));
  return new Promise((resolve,reject)=>{
    fromBuffer(data,{lazyEntries:true,validateEntrySizes:true,strictFileNames:true},(error,archive)=>{
      if(error||!archive){reject(new Error("LICENSE_REVIEW_REQUIRED"));return;}
      let result:Buffer|undefined,count=0,failed=false;
      const fail=()=>{failed=true;archive.close();reject(new Error("LICENSE_REVIEW_REQUIRED"));};
      archive.on("error",fail);
      archive.on("entry",(entry:Entry)=>{
        if(failed)return;
        if(++count>10_000){fail();return;}
        const basename=entry.fileName.split("/").at(-1);
        if(basename!==`udx_${cityCode}_city_${year}_op.xml`){archive.readEntry();return;}
        if(result||entry.uncompressedSize>2*1024*1024||entry.isEncrypted()){fail();return;}
        archive.openReadStream(entry,(error,stream)=>{
          if(error||!stream){fail();return;}
          let bytes=0;const chunks:Buffer[]=[];
          stream.on("error",fail);
          stream.on("data",(chunk:Buffer)=>{
            bytes+=chunk.length;if(bytes>2*1024*1024){stream.destroy();fail();return;}chunks.push(chunk);
          });
          stream.on("end",()=>{if(!failed){result=Buffer.concat(chunks,bytes);archive.readEntry();}});
        });
      });
      archive.on("end",()=>{if(!failed){if(result)resolve(result);else fail();}});
      archive.readEntry();
    });
  });
}

export async function validateLicense(xml:Buffer):Promise<void>{
  let root:XmlNode|undefined;
  await readXml([xml],node=>{root=node;},undefined,undefined,2*1024*1024);
  const nodes=root?[...descendants(root)]:[];
  const conditions=nodes.filter(n=>n.local==="useLimitation"&&n.uri).map(n=>content(n).trim());
  if(!conditions.length||conditions.some(c=>c!=="Licensed under CC BY 4.0")||nodes.some(n=>["accessConstraints","useConstraints","otherConstraints"].includes(n.local)))throw new Error("LICENSE_REVIEW_REQUIRED");
}

const RawFile=z.object({url:z.string(),fileSize:z.number().int().nonnegative().nullish()});
const RawCity=z.object({cityCode:z.string().regex(/^\d{5}$/),cityName:z.string().max(100),year:z.number().int().min(2000).max(2100),
  files:z.object({bldg:z.array(RawFile).default([]),tran:z.array(RawFile).default([])}),metadataZipUrls:z.array(z.string()).default([])});

export async function discover(latitude:number,longitude:number,download:Download=sourceClient(),measureSource=sourceSize):Promise<Catalog>{
  if(!SelectionSchema.safeParse({latitude,longitude}).success)throw new Error("AREA_OUTSIDE_JAPAN");
  const dy=130/110574,dx=130/(111320*Math.cos(latitude*Math.PI/180));
  const bounds=[longitude-dx,latitude-dy,longitude+dx,latitude+dy].map(v=>v.toFixed(7)).join(",");
  const raw=await download(`https://api.plateauview.mlit.go.jp/datacatalog/citygml/r:${bounds}?types=bldg,tran`,4*1024*1024,false);
  const catalog=z.object({cities:z.array(RawCity).max(100).default([])}).parse(JSON.parse(raw.data.toString("utf8")) as unknown);
  const latest=new Map<string,z.infer<typeof RawCity>>();
  for(const city of catalog.cities){if(city.year>(latest.get(city.cityCode)?.year??0))latest.set(city.cityCode,city);}
  if(!latest.size)throw new Error("NO_DATA");if(latest.size>4)throw new Error("MULTI_CITY_LIMIT");
  const cities=[...latest.values()].sort((a,b)=>a.cityCode.localeCompare(b.cityCode));
  if(cities.reduce((n,c)=>n+c.files.bldg.length+c.files.tran.length,0)>8)throw new Error("SOURCE_TOO_LARGE");
  const unique=new Map<string,Catalog["files"][number]>();
  for(const city of cities){
    if(!city.files.bldg.length||!city.files.tran.length)throw new Error("MISSING_ROADS_OR_BUILDINGS");
    for(const kind of ["bldg","tran"] as const)for(const file of city.files[kind]){
      checkUrl(file.url);const previous=unique.get(file.url);
      // A shared URL with different ownership or interpretation needs an explicit review.
      if(previous)throw new Error("SOURCE_METADATA_AMBIGUOUS");
      unique.set(file.url,{url:file.url,bytes:file.fileSize??await measureSource(file.url,FILE_LIMIT),kind});
    }
  }
  const files=[...unique.values()];
  if(files.length>8||files.some(f=>f.bytes>FILE_LIMIT)||files.reduce((n,f)=>n+f.bytes,0)>TOTAL_LIMIT)throw new Error("SOURCE_TOO_LARGE");
  const datasets:NonNullable<Catalog["datasets"]>=[];
  for(const city of cities){
    const urls=city.metadataZipUrls.filter(url=>new URL(url).pathname.endsWith("_metadata.zip"));
    if(urls.length!==1)throw new Error("LICENSE_REVIEW_REQUIRED");
    const metadata=await download(urls[0]!,8*1024*1024);
    await validateLicense(await licenseXml(metadata.data,city.cityCode,city.year));
    datasets.push({cityCode:city.cityCode,city:city.cityName,year:city.year,metadataUrl:urls[0]!,metadataSha256:sha256(metadata.data),fileUrls:[...city.files.bldg,...city.files.tran].map(f=>f.url)});
  }
  return CatalogSchema.parse({latitude,longitude,city:datasets.map(d=>d.city).join(" / ").slice(0,100),year:Math.max(...datasets.map(d=>d.year)),files,
    metadataUrl:datasets[0]!.metadataUrl,metadataSha256:datasets[0]!.metadataSha256,license:"CC BY 4.0",datasets});
}
