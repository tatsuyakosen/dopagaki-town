import { z } from "zod";
import { CatalogSchema, type Catalog } from "./contracts.js";
import { convert, type Metadata } from "./converter.js";
import { FILE_LIMIT, TOTAL_LIMIT, discover, sourceClient } from "./source.js";
import { geometryClient, type GeometryDownload } from "./geometry-source.js";
import { chooseSpawn } from "./spawn.js";
import { AreaTileSchema, tileBounds, type AreaTile } from "../../../packages/contracts/src/area.js";
import { addTerrain } from "./terrain.js";

export type Progress={phase:string;completed?:number;total?:number;bytes?:number;vertices?:number};
/** At most two streams are fetched together; only paths and hashes survive the batch. */
export async function downloadGeometry(catalog:Catalog,download?:GeometryDownload,progress:(value:Progress)=>void=()=>{}){
  if(catalog.files.some(f=>f.bytes>FILE_LIMIT)||catalog.files.reduce((n,f)=>n+f.bytes,0)>TOTAL_LIMIT)throw new Error("SOURCE_TOO_LARGE");
  const acquire=download??await geometryClient(catalog.files.map(f=>f.url));
  const paths:string[]=[],byHash=new Map<string,string>(),sourceMetadata=new Map<string,Metadata>();
  let received=0,hits=0,completed=0;
  const metadataFor=(dataset:{city:string;year:number;metadataUrl:string}):Metadata=>({title:dataset.city+" 3D都市モデル "+dataset.year+"年度",provider:dataset.city+" / Project PLATEAU",
    datasetYear:dataset.year,surveyYear:null,url:dataset.metadataUrl,license:"CC BY 4.0",licenseUrl:"https://creativecommons.org/licenses/by/4.0/",
    attribution:dataset.city+" 3D都市モデル（"+dataset.year+"年度）を加工して作成",retrievedAt:new Date().toISOString().slice(0,10)});
  const metadata=metadataFor(catalog);
  for(let at=0;at<catalog.files.length;at+=2){
    progress({phase:"download",completed,total:catalog.files.length,bytes:received});
    const batch=await Promise.allSettled(catalog.files.slice(at,at+2).map(async source=>{
      const {path,digest,bytes,hit}=await acquire(source.url,FILE_LIMIT);received+=bytes;
      if(received>TOTAL_LIMIT)throw new Error("SOURCE_TOO_LARGE");
      const dataset=catalog.datasets?.find(d=>d.fileUrls.includes(source.url));
      if(catalog.datasets&&!dataset)throw new Error("SOURCE_METADATA_AMBIGUOUS");
      sourceMetadata.set(path,dataset?metadataFor(dataset):metadata);hits+=Number(hit);completed++;
      progress({phase:"download",completed,total:catalog.files.length,bytes:received});
      return {path,digest,url:source.url};
    }));
    for(const result of batch){if(result.status==="rejected")throw result.reason;paths.push(result.value.path);if(!byHash.has(result.value.digest))byHash.set(result.value.digest,result.value.url);}
  }
  return {paths,byHash,sourceMetadata,metadata,received,hits};
}

export async function build(catalog:Catalog,lod:1|2,progress:(value:Progress)=>void=()=>{},tile?:AreaTile){
  const started=performance.now(),download=sourceClient();
  const {paths,byHash,sourceMetadata,metadata,received,hits}=await downloadGeometry(catalog,undefined,progress);
  const downloaded=performance.now(),downloadPeakRssBytes=process.resourceUsage().maxRSS*1024;progress({phase:"convert",bytes:received});
  const origin=tile??catalog,bounds=tile?tileBounds(tile):undefined;
  const manifest=await convert(paths,metadata,[origin.latitude,origin.longitude,0],tile?500:125,[0,1,0],lod,catalog.city+" / 選択した街",bounds,sourceMetadata);
  for(const source of manifest.sources){const url=byHash.get(source.sha256);if(!url)throw new Error("SOURCE_CHANGED");source.url=url;}
  for(const dataset of catalog.datasets??[catalog]){
    manifest.sources.push({...metadata,title:dataset.city+" 3D都市モデル "+dataset.year+"年度",provider:dataset.city+" / Project PLATEAU",datasetYear:dataset.year,
      attribution:dataset.city+" 3D都市モデル（"+dataset.year+"年度）を加工して作成",url:dataset.metadataUrl,sha256:dataset.metadataSha256});
  }
  const converted=performance.now();let terrainStats={tiles:0,bytes:0,drapedRoads:0,alignedBuildings:0};
  if(tile){manifest.tile=tile;progress({phase:"terrain"});terrainStats=await addTerrain(manifest,tile,download);}
  const terrainDone=performance.now(),vertices=manifest.meshes.reduce((n,m)=>n+m.positions.length/3,0);
  if(vertices>(lod===1?40_000:80_000)||manifest.meshes.length>600)throw new Error("GEOMETRY_BUDGET");
  progress({phase:"validate",vertices});manifest.spawn=chooseSpawn(manifest.meshes,tile?500:125,bounds);
  manifest.limitations.push(tile?"街路樹・看板・写真テクスチャ・地下・建物内部は未取込です。":"地面は収録された道路面に限定します。地形DEM・歩道の補完・街路樹・看板は未取込です。",
    "建物はLOD"+lod+"を上限に収録形状を使用します。AIによる建物形状の創作は行いません。");
  const bytes=Buffer.byteLength(JSON.stringify(manifest));if(bytes>4*1024*1024)throw new Error("GEOMETRY_BUDGET");
  return {manifest,stats:{sourceBytes:received,sourceCacheHits:hits,vertices,meshes:manifest.meshes.length,manifestBytes:bytes,
    terrainTiles:terrainStats.tiles,terrainBytes:terrainStats.bytes,drapedRoads:terrainStats.drapedRoads,alignedBuildings:terrainStats.alignedBuildings,
    downloadSeconds:(downloaded-started)/1000,downloadPeakRssBytes,convertSeconds:(converted-downloaded)/1000,terrainSeconds:(terrainDone-converted)/1000,
    validateSeconds:(performance.now()-terrainDone)/1000,workerSeconds:(performance.now()-started)/1000,workerPeakRssBytes:process.resourceUsage().maxRSS*1024}};
}

const RequestSchema=z.discriminatedUnion("action",[
  z.object({action:z.literal("discover"),latitude:z.number(),longitude:z.number()}).strict(),
  z.object({action:z.literal("build"),catalog:CatalogSchema,lod:z.union([z.literal(1),z.literal(2)]),tile:AreaTileSchema.optional()}).strict(),
]);
export async function handleRequest(raw:unknown,progress:(value:Progress)=>void){
  const request=RequestSchema.parse(raw);
  return request.action==="discover"?discover(request.latitude,request.longitude):build(request.catalog,request.lod,progress,request.tile);
}
