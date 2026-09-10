import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { request } from "undici";
import { describe,expect,it,vi } from "vitest";
import { checkUrl, discover, fetchBytes, FILE_LIMIT, licenseXml, sourceClient, validateLicense, type Download } from "./source.js";

const base="https://assets.cms.plateau.reearth.io/assets/";
const city={cityCode:"12345",cityName:"Synthetic city",year:2025,files:{bldg:[{url:base+"building",fileSize:100}],tran:[{url:base+"road",fileSize:100}]},metadataZipUrls:[base+"test_metadata.zip"]};
const license='<root xmlns:g="urn:synthetic-test"><g:useLimitation>Licensed under CC BY 4.0</g:useLimitation></root>';

/** Minimal stored ZIP used only for synthetic parser tests. No source data is embedded. */
function zip(entries:{name:string;text:string;declaredSize?:number}[]):Buffer{
  const local:Buffer[]=[],central:Buffer[]=[];let offset=0;
  for(const entry of entries){
    const name=Buffer.from(entry.name),data=Buffer.from(entry.text),size=entry.declaredSize??data.length;
    const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt32LE(data.length,18);header.writeUInt32LE(size,22);header.writeUInt16LE(name.length,26);
    const directory=Buffer.alloc(46);directory.writeUInt32LE(0x02014b50);directory.writeUInt16LE(20,6);directory.writeUInt32LE(data.length,20);directory.writeUInt32LE(size,24);directory.writeUInt16LE(name.length,28);directory.writeUInt32LE(offset,42);
    local.push(header,name,data);central.push(directory,name);offset+=header.length+name.length+data.length;
  }
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(central.reduce((n,b)=>n+b.length,0),12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,...central,end]);
}
const archive=(text=license)=>zip([{name:"metadata/udx_12345_city_2025_op.xml",text}]);
const result=(data:Buffer)=>({data,hit:false});
const catalogDownload=(record:unknown=city,metadata=archive()):Download=>vi.fn<Download>().mockResolvedValueOnce(result(Buffer.from(JSON.stringify({cities:[record]})))).mockResolvedValueOnce(result(metadata));

describe("bounded PLATEAU acquisition",()=>{
  it.each(["http://api.plateauview.mlit.go.jp/","https://127.0.0.1/","https://api.plateauview.mlit.go.jp.evil.example/","https://user@api.plateauview.mlit.go.jp/","file:///private","https://assets.cms.plateau.reearth.io/assets/data?key=value"])("rejects unapproved destination %s",url=>expect(()=>checkUrl(url)).toThrow("SOURCE_URL_REJECTED"));
  it("rejects a redirect before opening the unapproved destination",async()=>{
    const body=Readable.from([]);
    const transport=vi.fn().mockResolvedValue({statusCode:302,headers:{location:"https://127.0.0.1/"},body});
    await expect(fetchBytes(base+"data",100,transport as typeof request)).rejects.toThrow("SOURCE_URL_REJECTED");
    expect(transport).toHaveBeenCalledTimes(1);expect(body.destroyed).toBe(true);
  });
  it("limits streamed responses even without Content-Length",async()=>{
    const transport=vi.fn().mockResolvedValue({statusCode:200,headers:{},body:Readable.from([Buffer.alloc(7),Buffer.alloc(7)])});
    await expect(fetchBytes(base+"data",10,transport as typeof request)).rejects.toThrow("SOURCE_TOO_LARGE");
  });
  it("caches only complete responses and reuses them",async()=>{
    const directory=await mkdtemp(join(tmpdir(),"city-source-"));
    try{
      const fetch=vi.fn().mockRejectedValueOnce(new Error("SOURCE_TIMEOUT")).mockResolvedValue(Buffer.from("ok"));
      const download=sourceClient(directory,fetch);
      await expect(download(base+"data",100)).rejects.toThrow("SOURCE_TIMEOUT");expect(await readdir(directory)).toEqual([]);
      expect((await download(base+"data",100)).hit).toBe(false);expect((await download(base+"data",100)).hit).toBe(true);expect(fetch).toHaveBeenCalledTimes(2);
    }finally{await rm(directory,{recursive:true,force:true});}
  });
  it("accepts the exact reviewed license and keeps its archive hash",async()=>{
    const result=await discover(34.7,135.5,catalogDownload());expect(result.license).toBe("CC BY 4.0");expect(result.metadataSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each([
    license.replace("Licensed under CC BY 4.0","Restricted"),
    license.replace("</root>",'<g:useConstraints><g:code value="restricted"/></g:useConstraints></root>'),
    '<root/>',
  ])("requires review for unknown or additional license conditions",async xml=>{
    await expect(validateLicense(Buffer.from(xml))).rejects.toThrow("LICENSE_REVIEW_REQUIRED");
  });
  it("rejects missing, duplicate, oversized and traversing archive records",async()=>{
    for(const entries of [
      [{name:"other.xml",text:license}],
      [{name:"udx_12345_city_2025_op.xml",text:license},{name:"metadata/udx_12345_city_2025_op.xml",text:license}],
      [{name:"udx_12345_city_2025_op.xml",text:license,declaredSize:3*1024*1024}],
      [{name:"../udx_12345_city_2025_op.xml",text:license}],
    ])await expect(licenseXml(zip(entries),"12345",2025)).rejects.toThrow("LICENSE_REVIEW_REQUIRED");
  });
  it("rejects entities in metadata",async()=>{
    await expect(discover(34.7,135.5,catalogDownload(city,archive('<!DOCTYPE root [<!ENTITY x "test">]>'+license)))).rejects.toThrow("XML_REJECTED");
  });
  it("rejects source budgets before downloading any geometry",async()=>{
    const download=catalogDownload({...city,files:{...city.files,bldg:[{url:base+"b",fileSize:FILE_LIMIT+1}]}});
    await expect(discover(34.7,135.5,download)).rejects.toThrow("SOURCE_TOO_LARGE");expect(download).toHaveBeenCalledTimes(1);
  });
  it("rejects missing coverage, ambiguous shared sources, and outside Japan",async()=>{
    await expect(discover(NaN,135.5)).rejects.toThrow("AREA_OUTSIDE_JAPAN");
    const download:Download=()=>Promise.resolve(result(Buffer.from('{"cities":[]}')));
    await expect(discover(34.7,135.5,download)).rejects.toThrow("NO_DATA");
    const multiple:Download=()=>Promise.resolve(result(Buffer.from(JSON.stringify({cities:[city,{...city,cityCode:"54321"}]}))));
    await expect(discover(34.7,135.5,multiple)).rejects.toThrow("SOURCE_METADATA_AMBIGUOUS");
  });
});

describe("municipal boundary data",()=>{
  const second={...city,cityCode:"54321",cityName:"Second synthetic city",year:2024,files:{bldg:[{url:base+"second-building",fileSize:100}],tran:[{url:base+"second-road",fileSize:100}]},metadataZipUrls:[base+"second_metadata.zip"]};
  const secondArchive=(text=license)=>zip([{name:"udx_54321_city_2024_op.xml",text}]);
  it("keeps each municipality's own year, archive hash and file ownership",async()=>{
    const download=vi.fn<Download>().mockResolvedValueOnce(result(Buffer.from(JSON.stringify({cities:[second,city]})))).mockResolvedValueOnce(result(archive())).mockResolvedValueOnce(result(secondArchive()));
    const catalog=await discover(34.7,135.5,download);
    expect(catalog.files).toHaveLength(4);expect(catalog.datasets?.map(d=>[d.cityCode,d.year])).toEqual([["12345",2025],["54321",2024]]);
    expect(catalog.datasets?.[1]?.fileUrls).toContain(base+"second-road");expect(download).toHaveBeenCalledTimes(3);
  });
  it("does not accept a neighboring municipality with unreviewed license terms",async()=>{
    const download=vi.fn<Download>().mockResolvedValueOnce(result(Buffer.from(JSON.stringify({cities:[city,second]})))).mockResolvedValueOnce(result(archive())).mockResolvedValueOnce(result(secondArchive(license.replace("CC BY 4.0","Restricted"))));
    await expect(discover(34.7,135.5,download)).rejects.toThrow("LICENSE_REVIEW_REQUIRED");
  });
});

describe("catalogs without file sizes",()=>{
  it("checks a missing size before accepting a catalog",async()=>{
    const measure=vi.fn().mockResolvedValue(123);
    const old={...city,files:{...city.files,bldg:[{url:base+"old-building"}]}};
    const catalog=await discover(34.7,135.5,catalogDownload(old),measure);
    expect(catalog.files[0]?.bytes).toBe(123);expect(measure).toHaveBeenCalledExactlyOnceWith(base+"old-building",FILE_LIMIT);
  });
  it("does not use an unlimited download when size metadata is unavailable",async()=>{
    const {sourceSize}=await import("./source.js");const body=Readable.from([]),transport=vi.fn().mockResolvedValue({statusCode:200,headers:{},body});
    await expect(sourceSize(base+"data",100,transport as typeof request)).rejects.toThrow("SOURCE_SIZE_UNKNOWN");
    expect(transport.mock.calls[0]?.[1]).toMatchObject({method:"HEAD"});expect(body.destroyed).toBe(true);
  });
});

describe("real HTTP metadata response lifecycle",()=>{
  it("reads HEAD size and closes the response without an unhandled abort error",async()=>{
    const {createServer}=await import("node:http"),{request:send}=await import("undici"),{sourceSize}=await import("./source.js");
    const server=createServer((req,res)=>{res.setHeader("Content-Length","123");res.end();});
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    try{
      const address=server.address() as {port:number};
      const transport=((_url,options)=>send(`http://127.0.0.1:${address.port}`,{method:options?.method??"GET"})) as typeof request;
      expect(await sourceSize(base+"metadata-only",1000,transport)).toBe(123);
      await new Promise(resolve=>setTimeout(resolve,0));
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
});
