import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe,expect,it } from "vitest";
import { convert, type Metadata } from "./converter.js";
import { localFrame, triangulateRings, type Point } from "./geometry.js";
import { chooseSpawn, triangleHeight } from "./spawn.js";
import { readXml } from "./xml.js";
import { runWorker } from "./service.js";

const origin:Point=[34.705,135.4967,3];
const metadata:Metadata={title:"Synthetic converter test",provider:"Tests",datasetYear:2020,surveyYear:null,url:"https://example.com/data",license:"Test only",licenseUrl:"https://example.com/license",attribution:"Synthetic fixture",retrievedAt:"2026-09-07"};
const ring="34.705 135.4967 3 34.705 135.497 3 34.7053 135.497 3 34.7053 135.4967 3 34.705 135.4967 3";
const polygon=`<gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>${ring}</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon>`;
const xml=`<core:CityModel xmlns:core="http://www.opengis.net/citygml/2.0" xmlns:gml="http://www.opengis.net/gml" xmlns:bldg="http://www.opengis.net/citygml/building/2.0" xmlns:tran="http://www.opengis.net/citygml/transportation/2.0" xmlns:xlink="http://www.w3.org/1999/xlink"><gml:boundedBy><gml:Envelope srsName="http://www.opengis.net/def/crs/EPSG/0/6697"/></gml:boundedBy><core:cityObjectMember><bldg:Building><bldg:lod1Solid>${polygon}</bldg:lod1Solid></bldg:Building></core:cityObjectMember><core:cityObjectMember><tran:Road><tran:lod1MultiSurface>${polygon}</tran:lod1MultiSurface></tran:Road></core:cityObjectMember></core:CityModel>`;
async function withSource(source:string,check:(path:string)=>Promise<void>){
  const directory=await mkdtemp(join(tmpdir(),"city-converter-"));
  try{const path=join(directory,"fixture.xml");await writeFile(path,source);await check(path);}finally{await rm(directory,{recursive:true,force:true});}
}
const area=(points:Point[],indices:number[])=>{
  let total=0;for(let i=0;i<indices.length;i+=3){const a=points[indices[i]!]!,b=points[indices[i+1]!]!,c=points[indices[i+2]!]!;total+=Math.abs((b[0]-a[0])*(c[2]-a[2])-(b[2]-a[2])*(c[0]-a[0]))/2;}return total;
};

describe("TypeScript CityGML conversion",()=>{
  it("keeps the origin and east/up/south axes",()=>{
    const local=localFrame(origin);expect(local(origin)).toEqual([0,0,0]);
    expect(local([34.705,135.4977,3])[0]).toBeGreaterThan(80);
    expect(local([34.706,135.4967,3])[2]).toBeLessThan(-100);
    expect(local([34.705,135.4967,13])[1]).toBeCloseTo(10);
    expect(()=>local([135,34,0])).toThrow();
  });
  it("preserves a courtyard hole and original XYZ",()=>{
    const rings:Point[][]=[[[0,0,0],[10,0,0],[10,0,10],[0,0,10]],[[3,0,3],[3,0,7],[7,0,7],[7,0,3]]];
    const result=triangulateRings(rings);expect(area(result.points,result.indices)).toBeCloseTo(84);expect(result.points).toEqual(rings.flat());
    for(let i=0;i<result.indices.length;i+=3){
      const triangle=result.indices.slice(i,i+3).map(n=>result.points[n]!) as [Point,Point,Point];
      expect(triangleHeight(5,5,triangle)).toBeUndefined();
    }
  });
  it("triangulates concave roads without filling their missing corner",()=>{
    const result=triangulateRings([[[0,0,0],[4,0,0],[4,0,1],[1,0,1],[1,0,4],[0,0,4]]]);
    expect(area(result.points,result.indices)).toBeCloseTo(7);expect(result.indices).toHaveLength(12);
  });
  it("projects vertical facades and rejects nonplanar surfaces",()=>{
    expect(triangulateRings([[[0,0,0],[0,10,0],[0,10,10],[0,0,10]]]).indices).toHaveLength(6);
    expect(()=>triangulateRings([[[0,0,0],[10,0,0],[10,3,10],[0,0,10]]])).toThrow("NON_PLANAR_GEOMETRY");
  });
  it("records exact source hashes, deduplicates inputs, and never includes local paths",async()=>{
    await withSource(xml,async path=>{
      const result=await convert([path,path],metadata,origin,125,[0,2,0]);
      expect(result.meshes).toHaveLength(2);expect(result.sources).toHaveLength(1);
      expect(result.sources[0]?.sha256).toBe(createHash("sha256").update(await readFile(path)).digest("hex"));
      expect(result.sources[0]?.surveyYear).toBeNull();expect(JSON.stringify(result)).not.toContain(path);
    });
  });
  it.each([
    [xml.replace('srsName="http://www.opengis.net/def/crs/EPSG/0/6697"',''),"CRS_REQUIRED"],
    [xml.replace('/6697','/4326'),"CRS_UNSUPPORTED"],
    [xml.replace('<gml:Polygon>','<gml:Polygon xlink:href="#surface">'),"UNRESOLVED_XLINK"],
    [xml.replace('<gml:posList>','<gml:posList srsDimension="2">'),"COORDINATES_REJECTED"],
    [xml.replace(ring,ring.replace(/34\.705 135\.4967 3$/,"34.706 135.4967 3")),"UNCLOSED_RING"],
  ])("rejects unsupported geometry",async(source,code)=>{
    await withSource(source,async path=>{await expect(convert([path],metadata,origin,125,[0,2,0])).rejects.toThrow(code);});
  });
  it("rejects signed source URLs and placeholder provenance",async()=>{
    await expect(convert([],{...metadata,url:"https://example.com/?sig=test"},origin,125,[0,2,0])).rejects.toThrow();
    await expect(convert([],{...metadata,license:"未確認"},origin,125,[0,2,0])).rejects.toThrow("METADATA_REJECTED");
  });
  it.each([
    ['<!DOC','TYPE a [<!ENTITY x "test">]><a/>'],
    ['<a>\0</a>'],
    ['<?xml version="1.0" encoding="UTF-16"?><a/>'],
    ['<a>&unknown;</a>'],
  ])("rejects unsafe XML, including declarations split across chunks",async(...chunks)=>{
    await expect(readXml(chunks.map(v=>Buffer.from(v)),()=>{})).rejects.toThrow();
  });
  it("enforces a streaming byte budget",async()=>{
    await expect(readXml([Buffer.from('<a>123456</a>')],()=>{},undefined,undefined,8)).rejects.toThrow("SOURCE_TOO_LARGE");
  });
  it("starts on measured roads with clearance and rejects a covering roof",()=>{
    const road={id:"road",kind:"road" as const,positions:[-10,0,-10,10,0,-10,10,0,10,-10,0,10],indices:[0,1,2,0,2,3]};
    expect(chooseSpawn([road])[1]).toBe(.95);
    const roof={...road,kind:"building" as const,positions:road.positions.map((v,i)=>i%3===1?4:v)};
    expect(()=>chooseSpawn([road,roof])).toThrow("NO_SAFE_SPAWN");
    expect(triangleHeight(5,2,[[0,0,0],[10,2,0],[0,0,10]])).toBeCloseTo(1);
    expect(triangleHeight(9,9,[[0,0,0],[10,2,0],[0,0,10]])).toBeUndefined();
  });
  it("runs the real Node child process and returns a sanitized validation error",async()=>{
    await expect(runWorker({action:"discover",latitude:0,longitude:0},AbortSignal.timeout(5000))).rejects.toThrow("AREA_OUTSIDE_JAPAN");
  });
  it("cancels the real Node child before network access",async()=>{
    const controller=new AbortController();
    const result=runWorker({action:"discover",latitude:34.7,longitude:135.5},controller.signal);controller.abort();
    await expect(result).rejects.toThrow("CANCELLED");
  });
});
