import { createReadStream } from "node:fs";
import type { z } from "zod";
import { CityManifestSchema, type CityManifest } from "../../../packages/contracts/src/city.js";
import { localFrame, triangulateRings, type Point } from "./geometry.js";
import { child, CORE, descendants, GML, readXml, XLINK, type XmlNode } from "./xml.js";

const MetadataSchema=CityManifestSchema.shape.sources.element.omit({sha256:true});
export type Metadata=z.infer<typeof MetadataSchema>;
export type Mesh=CityManifest["meshes"][number];

function readRing(ring:XmlNode|undefined,toLocal:(p:Point)=>Point):Point[]{
  if(!ring)throw new Error("GEOMETRY_UNSUPPORTED");
  const list=child(ring,"posList");
  const positions=list?[list]:ring.children.filter(n=>n.uri===GML&&n.local==="pos");
  if(positions.some(n=>n.attributes.srsDimension&&n.attributes.srsDimension!=="3"))throw new Error("COORDINATES_REJECTED");
  const tokens=positions.flatMap(n=>n.text.trim().split(/\s+/));
  if(tokens.some(v=>!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(v)))throw new Error("COORDINATES_REJECTED");
  const values=tokens.map(Number);
  if(values.length<12||values.length%3||values.length>6003)throw new Error("GEOMETRY_UNSUPPORTED");
  const points:Point[]=[];
  for(let i=0;i<values.length;i+=3)points.push(toLocal([values[i]!,values[i+1]!,values[i+2]!]));
  if(points[0]!.some((v,i)=>v!==points.at(-1)![i]))throw new Error("UNCLOSED_RING");
  points.pop();return points;
}

export async function convert(
  paths:string[],rawMetadata:unknown,origin:Point,halfSize:number,spawn:Point,
  maxLod:1|2=2,title="大阪・梅田 / 実データ街区",
):Promise<CityManifest>{
  const metadata=MetadataSchema.parse(rawMetadata);
  for(const field of [metadata.title,metadata.provider,metadata.license,metadata.attribution]){
    if(!field.trim()||/todo|replace|記入|未確認/i.test(field))throw new Error("METADATA_REJECTED");
  }
  const date=new Date(metadata.retrievedAt);
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==metadata.retrievedAt)throw new Error("METADATA_REJECTED");
  if(![...origin,...spawn,halfSize].every(Number.isFinite)||halfSize<20||halfSize>500||origin[0]<20||origin[0]>46||origin[1]<122||origin[1]>154||Math.abs(spawn[0])>=halfSize-1||Math.abs(spawn[2])>=halfSize-1)throw new Error("COORDINATES_REJECTED");
  const toLocal=localFrame(origin),meshes:Mesh[]=[],sources:CityManifest["sources"]=[],seen=new Set<string>();
  let vertices=0;
  for(const path of paths){
    let crsChecked=false;const initialLength=meshes.length,initialVertices=vertices;
    const digest=await readXml(createReadStream(path),member=>{
      if(!crsChecked)throw new Error("CRS_REQUIRED");
      const object=member.children[0];if(!object)return;
      const kinds:Record<string,Mesh["kind"]>={Building:"building",Road:"road",ReliefFeature:"terrain"};
      const kind=kinds[object.local];if(!kind)return;
      const preferred=kind==="building"?(maxLod>=2?["lod2MultiSurface","lod2Solid","lod1Solid"]:["lod1Solid"]):["lod1MultiSurface","TriangulatedSurface","Tin"];
      let geometries:XmlNode[]=[];
      for(const name of preferred){geometries=[...descendants(object)].filter(n=>n.local===name);if(geometries.length)break;}
      if(!geometries.length)throw new Error("GEOMETRY_UNSUPPORTED");
      const nodes=geometries.flatMap(root=>[...descendants(root)]);
      if(nodes.some(n=>n.attributes[`{${XLINK}}href`]!==undefined))throw new Error("UNRESOLVED_XLINK");
      const polygons=nodes.filter(n=>n.uri===GML&&(n.local==="Polygon"||n.local==="Triangle"));
      if(!polygons.length)throw new Error("GEOMETRY_UNSUPPORTED");
      const compounds=polygons.map(p=>[
        readRing(child(child(p,"exterior"),"LinearRing"),toLocal),
        ...p.children.filter(n=>n.uri===GML&&n.local==="interior").map(n=>readRing(child(n,"LinearRing"),toLocal)),
      ]);
      const points=compounds.flat(2);
      let minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity;
      for(const p of points){minX=Math.min(minX,p[0]);maxX=Math.max(maxX,p[0]);minZ=Math.min(minZ,p[2]);maxZ=Math.max(maxZ,p[2]);}
      // Preserve whole intersecting objects; a clipped edge must not become an invented wall.
      if(maxX< -halfSize||minX>halfSize||maxZ< -halfSize||minZ>halfSize)return;
      const positions:number[]=[],indices:number[]=[];
      for(const rings of compounds){
        const result=triangulateRings(rings),base=positions.length/3;
        for(const index of result.indices)indices.push(base+index);
        for(const point of result.points)positions.push(...point);
      }
      vertices+=positions.length/3;
      meshes.push({id:`mesh-${String(meshes.length).padStart(5,"0")}`,kind,positions,indices});
      if(meshes.length>5000||vertices>500_000)throw new Error("GEOMETRY_BUDGET");
    },tag=>tag.uri===CORE&&tag.local==="cityObjectMember",tag=>{
      const srs=tag.attributes.srsName?.value;
      if(srs){if(!/(\/|:)6697$/.test(srs))throw new Error("CRS_UNSUPPORTED");crsChecked=true;}
    });
    if(seen.has(digest)){meshes.length=initialLength;vertices=initialVertices;continue;}
    seen.add(digest);sources.push({...metadata,sha256:digest});
  }
  if(!meshes.some(m=>m.kind==="building")||!meshes.some(m=>m.kind!=="building"))throw new Error("MISSING_ROADS_OR_BUILDINGS");
  return CityManifestSchema.parse({version:1,mode:"survey",title,coordinateSystem:"LOCAL_ENU_Y_UP_METERS",
    origin:{latitude:origin[0],longitude:origin[1],altitude:origin[2]},extentMeters:1000,playableHalfSize:halfSize,spawn,sources,meshes,
    limitations:[
      "形状は出典データの年度に対応します。現在の街の完全再現ではありません。",
      "外壁材・窓・夕景は汎用の演出で、実際の外観や点灯状態を示しません。原データのテクスチャは未取込です。",
      "1km四方は計画範囲です。今回の変換は開始街区と交差する地物に限定し、街区境界はゲーム用制約です。",
      "GRS80局所接平面を使用。標高を近傍相対高度として扱い、ジオイド補正は未実施です。測量精度は保証しません。",
      "地下・建物内部・歩道の通行権・私有地・工事による通行規制は未再現です。",
    ]});
}
