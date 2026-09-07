import { join } from "node:path";
import { z } from "zod";
import { CatalogSchema, type Catalog } from "./contracts.js";
import { convert, type Metadata } from "./converter.js";
import { CACHE, FILE_LIMIT, TOTAL_LIMIT, discover, sha256, sourceClient } from "./source.js";
import { chooseSpawn } from "./spawn.js";

type Progress={phase:string;completed?:number;total?:number;bytes?:number;vertices?:number};
export async function build(catalog:Catalog,lod:1|2,progress:(value:Progress)=>void=()=>{}){
  const started=performance.now(),paths:string[]=[],byHash=new Map<string,string>(),download=sourceClient();
  let received=0,hits=0;
  for(const [i,source] of catalog.files.entries()){
    progress({phase:"download",completed:i,total:catalog.files.length,bytes:received});
    const {data,hit}=await download(source.url,FILE_LIMIT);received+=data.length;
    if(received>TOTAL_LIMIT)throw new Error("SOURCE_TOO_LARGE");
    paths.push(join(CACHE,sha256(source.url)));byHash.set(sha256(data),source.url);hits+=Number(hit);
  }
  progress({phase:"convert",bytes:received});
  const metadata:Metadata={title:`${catalog.city} 3D都市モデル ${catalog.year}年度`,provider:`${catalog.city} / Project PLATEAU`,
    datasetYear:catalog.year,surveyYear:null,url:catalog.metadataUrl,license:"CC BY 4.0",licenseUrl:"https://creativecommons.org/licenses/by/4.0/",
    attribution:`${catalog.city} 3D都市モデル（${catalog.year}年度）を加工して作成`,retrievedAt:new Date().toISOString().slice(0,10)};
  const manifest=await convert(paths,metadata,[catalog.latitude,catalog.longitude,0],125,[0,1,0],lod,`${catalog.city} / 選択した250m街区`);
  for(const source of manifest.sources){const url=byHash.get(source.sha256);if(!url)throw new Error("SOURCE_CHANGED");source.url=url;}
  manifest.sources.push({...metadata,sha256:catalog.metadataSha256});
  const vertices=manifest.meshes.reduce((n,m)=>n+m.positions.length/3,0);
  if(vertices>(lod===1?40_000:80_000)||manifest.meshes.length>600)throw new Error("GEOMETRY_BUDGET");
  progress({phase:"validate",vertices});manifest.spawn=chooseSpawn(manifest.meshes);
  manifest.limitations.push("地面は収録された道路面に限定します。地形DEM・歩道の補完・街路樹・看板は未取込です。",
    `建物はLOD${lod}を上限に収録形状を使用します。AIによる建物形状の創作は行いません。`);
  const bytes=Buffer.byteLength(JSON.stringify(manifest));if(bytes>4*1024*1024)throw new Error("GEOMETRY_BUDGET");
  return {manifest,stats:{sourceBytes:received,sourceCacheHits:hits,vertices,meshes:manifest.meshes.length,manifestBytes:bytes,workerSeconds:(performance.now()-started)/1000}};
}

const RequestSchema=z.discriminatedUnion("action",[
  z.object({action:z.literal("discover"),latitude:z.number(),longitude:z.number()}).strict(),
  z.object({action:z.literal("build"),catalog:CatalogSchema,lod:z.union([z.literal(1),z.literal(2)])}).strict(),
]);
export async function handleRequest(raw:unknown,progress:(value:Progress)=>void){
  const request=RequestSchema.parse(raw);
  return request.action==="discover"?discover(request.latitude,request.longitude):build(request.catalog,request.lod,progress);
}
