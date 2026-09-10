import { mkdtemp, open, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { request } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGeometry, geometryClient } from "./geometry-source.js";
import { GEOMETRY_CACHE_LIMIT, TOTAL_LIMIT } from "./limits.js";
import { sha256 } from "./source.js";

const base="https://assets.cms.plateau.reearth.io/assets/";
const directories:string[]=[];
async function directory(){const path=await mkdtemp(join(tmpdir(),"city-geometry-"));directories.push(path);return path;}
afterEach(async()=>{await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
const transport=(chunks:Iterable<Buffer>|AsyncIterable<Buffer>,headers:Record<string,string>={})=>vi.fn().mockResolvedValue({statusCode:200,headers,body:Readable.from(chunks)}) as unknown as typeof request;

describe("geometry streaming to disk",()=>{
  it("writes a complete response, hashes its bytes and reuses disk cache without a request",async()=>{
    const path=await directory(),data=Buffer.from("synthetic geometry"),send=transport([data.subarray(0,5),data.subarray(5)]);
    const fetch=vi.fn((url:string,file:string,limit:number,consume:(bytes:number)=>void)=>fetchGeometry(url,file,limit,consume,send));
    const download=await geometryClient([base+"building"],path,fetch);
    const first=await download(base+"building",100),second=await download(base+"building",100);
    expect(first).toMatchObject({digest:sha256(data),bytes:data.length,hit:false});expect(second).toEqual({...first,hit:true});
    expect(await readFile(first.path)).toEqual(data);expect(fetch).toHaveBeenCalledTimes(1);expect(await readdir(path)).toEqual([sha256(base+"building")]);
  });
  it("removes interrupted partial files and preserves a previous complete response",async()=>{
    const path=await directory(),file=join(path,"complete");await writeFile(file,"old");
    function* broken(){yield Buffer.from("partial");throw new Error("socket closed");}
    await expect(fetchGeometry(base+"building",file,100,undefined,transport(broken()))).rejects.toThrow("SOURCE_UNAVAILABLE");
    expect(await readdir(path)).toEqual(["complete"]);expect(await readFile(file,"utf8")).toBe("old");
  });
  it.each([{}, {"content-length":"4"}])("enforces actual bytes and never publishes oversized responses (%j)",async headers=>{
    const path=await directory();await expect(fetchGeometry(base+"building",join(path,"file"),5,undefined,transport([Buffer.alloc(4),Buffer.alloc(4)],headers))).rejects.toThrow("SOURCE_TOO_LARGE");
    expect(await readdir(path)).toEqual([]);
  });
  it("rejects truncated responses even when the transport does not report an error",async()=>{
    const path=await directory();await expect(fetchGeometry(base+"building",join(path,"file"),100,undefined,transport([Buffer.alloc(3)],{"content-length":"10"}))).rejects.toThrow("SOURCE_UNAVAILABLE");
    expect(await readdir(path)).toEqual([]);
  });
  it("checks redirects before contacting a new destination",async()=>{
    const path=await directory(),send=vi.fn().mockResolvedValue({statusCode:302,headers:{location:"https://127.0.0.1/"},body:Readable.from([])});
    await expect(fetchGeometry(base+"building",join(path,"file"),100,undefined,send as typeof request)).rejects.toThrow("SOURCE_URL_REJECTED");expect(send).toHaveBeenCalledTimes(1);
  });
  it("shares the total byte budget across downloads, including cache hits",async()=>{
    const path=await directory();await writeFile(join(path,sha256(base+"cached")),"cached");
    const download=await geometryClient([base+"cached",base+"new"],path,(_url,_file,_limit,consume)=>{consume(TOTAL_LIMIT-5);return Promise.resolve({bytes:TOTAL_LIMIT-5,digest:"0".repeat(64)});});
    await download(base+"cached",100);await expect(download(base+"new",100)).rejects.toThrow("SOURCE_TOO_LARGE");
  });
  it("prunes old files and abandoned partials while protecting this build's sources",async()=>{
    const path=await directory(),keep=sha256(base+"keep"),old=sha256(base+"old");
    await writeFile(join(path,keep),"keep");await writeFile(join(path,old),"old");await writeFile(join(path,"abandoned.partial"),"partial");
    const past=new Date(Date.now()-90_000_000);for(const file of [keep,old,"abandoned.partial"])await utimes(join(path,file),past,past);
    await geometryClient([base+"keep"],path);expect(await readdir(path)).toEqual([keep]);
  });
  it("reserves bounded disk space before opening download streams",async()=>{
    const path=await directory(),file=await open(join(path,"active.partial"),"w");try{await file.truncate(GEOMETRY_CACHE_LIMIT);}finally{await file.close();}
    await expect(geometryClient([base+"new"],path)).rejects.toThrow("SOURCE_CACHE_FULL");
  });
});
