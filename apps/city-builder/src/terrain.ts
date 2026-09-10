import { type AreaTile, tileBounds, offsetCoordinates } from "../../../packages/contracts/src/area.js";
import { type CityManifest, type CityMesh } from "../../../packages/contracts/src/city.js";
import { localFrame, round, type Point } from "./geometry.js";
import { sha256, sourceClient, type Download } from "./source.js";

const PIXELS=256*16384,SPACING=12.5,MAX_TILES=9;
export function demPixel(latitude:number,longitude:number):[number,number] {
  return [(longitude+180)/360*PIXELS,(1-Math.asinh(Math.tan(latitude*Math.PI/180))/Math.PI)/2*PIXELS];
}
export function parseDem(data:Buffer):Float32Array {
  const rows=data.toString("utf8").trim().split(/\r?\n/);
  if(rows.length!==256)throw new Error("ELEVATION_INVALID");
  const values=new Float32Array(65536);let index=0;
  for(const row of rows){const cells=row.split(",");if(cells.length!==256)throw new Error("ELEVATION_INVALID");
    for(const cell of cells){if(cell==="e"){values[index++]=NaN;continue;}
      if(!/^-?\d+(?:\.\d+)?$/.test(cell))throw new Error("ELEVATION_INVALID");
      const value=Number(cell);if(value< -500||value>9000)throw new Error("ELEVATION_INVALID");values[index++]=value;
    }
  }return values;
}

export async function addTerrain(manifest:CityManifest,tile:AreaTile,download:Download=sourceClient()):Promise<{tiles:number;bytes:number;drapedRoads:number;alignedBuildings:number}> {
  const bounds=tileBounds(tile),frame=localFrame([tile.latitude,tile.longitude,0]);
  // Whole intersecting buildings/roads are preserved; sample their complete extent too.
  let minX=bounds.minX,maxX=bounds.maxX,minZ=bounds.minZ,maxZ=bounds.maxZ;
  for(const mesh of manifest.meshes)for(let i=0;i<mesh.positions.length;i+=3){
    minX=Math.min(minX,mesh.positions[i]!);maxX=Math.max(maxX,mesh.positions[i]!);
    minZ=Math.min(minZ,mesh.positions[i+2]!);maxZ=Math.max(maxZ,mesh.positions[i+2]!);
  }
  const pixel=(x:number,z:number):[number,number]=>{const p=offsetCoordinates(tile.latitude,tile.longitude,x,z);return demPixel(p.latitude,p.longitude);};
  const p0=pixel(minX-20,minZ-20),p1=pixel(maxX+20,maxZ+20);
  const x0=Math.floor(p0[0]/256),x1=Math.floor((p1[0]+1)/256),z0=Math.floor(p0[1]/256),z1=Math.floor((p1[1]+1)/256);
  if((x1-x0+1)*(z1-z0+1)>MAX_TILES)throw new Error("ELEVATION_BUDGET");
  const samples=new Map<string,Float32Array>();let bytes=0;
  for(let x=x0;x<=x1;x++)for(let z=z0;z<=z1;z++){
    const url=`https://cyberjapandata.gsi.go.jp/xyz/dem/14/${x}/${z}.txt`;
    const result=await download(url,768*1024);bytes+=result.data.length;
    if(bytes>5*1024*1024)throw new Error("ELEVATION_BUDGET");
    samples.set(`${x},${z}`,parseDem(result.data));
    manifest.sources.push({title:"地理院タイル 標高タイル DEM",provider:"国土地理院",datasetYear:null,surveyYear:null,url,
      license:"国土地理院コンテンツ利用規約",licenseUrl:"https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html",
      attribution:"地理院タイル（標高タイル）を加工して作成",retrievedAt:new Date().toISOString().slice(0,10),sha256:sha256(result.data)});
  }
  const at=(px:number,py:number):number=>{const grid=samples.get(`${Math.floor(px/256)},${Math.floor(py/256)}`);
    const value=grid?.[(py%256)*256+px%256];if(value===undefined||!Number.isFinite(value))throw new Error("ELEVATION_MISSING");return value;};
  const height=(x:number,z:number):number=>{
    const p=offsetCoordinates(tile.latitude,tile.longitude,x,z),[px,py]=demPixel(p.latitude,p.longitude),ix=Math.floor(px),iy=Math.floor(py),u=px-ix,v=py-iy;
    const altitude=(at(ix,iy)*(1-u)+at(ix+1,iy)*u)*(1-v)+(at(ix,iy+1)*(1-u)+at(ix+1,iy+1)*u)*v;
    return frame([p.latitude,p.longitude,altitude])[1];
  };
  let drapedRoads=0,alignedBuildings=0;
  for(const mesh of manifest.meshes){
    const points:Point[]=[];for(let i=0;i<mesh.positions.length;i+=3)points.push([mesh.positions[i]!,mesh.positions[i+1]!,mesh.positions[i+2]!]);
    // LOD1 road elevations of zero are not surveyed slopes. Keep nonzero/3D roads intact.
    if(mesh.kind==="road"&&points.every(([x,y,z])=>Math.abs(y+(x*x+z*z)/(2*6378137))<.03)){
      drapeRoad(mesh,height);drapedRoads++;
    }else if(mesh.kind==="building"){
      const base=Math.min(...points.map(p=>p[1]));
      const feet=points.filter(p=>p[1]<base+.05);
      if(feet.length&&feet.every(([x,y,z])=>Math.abs(y+(x*x+z*z)/(2*6378137))<.1)){
        // Rigidly translate only zero-datum buildings: dimensions/roof shape stay unchanged.
        const levels=feet.map(([x,,z])=>height(x,z)).sort((a,b)=>a-b);
        const shift=levels[Math.floor(levels.length/2)]!-base;
        for(let i=1;i<mesh.positions.length;i+=3)mesh.positions[i]=round(mesh.positions[i]!+shift);
        alignedBuildings++;
      }
    }
  }
  const positions:number[]=[],indices:number[]=[],columns=Math.round((bounds.maxX-bounds.minX)/SPACING)+1,rows=Math.round((bounds.maxZ-bounds.minZ)/SPACING)+1;
  for(let row=0;row<rows;row++)for(let col=0;col<columns;col++){
    const x=bounds.minX+col*SPACING,z=bounds.minZ+row*SPACING;positions.push(x,height(x,z),z);
  }
  for(let row=0;row<rows-1;row++)for(let col=0;col<columns-1;col++){
    const a=row*columns+col,b=a+1,c=a+columns,d=c+1;indices.push(a,c,b,b,c,d);
  }
  manifest.meshes.push({id:`terrain-${tile.x}-${tile.z}`,kind:"terrain",positions,indices});
  manifest.limitations=manifest.limitations.filter(text=>!text.startsWith("1km四方は計画範囲"));
  manifest.limitations.push("地面は国土地理院DEMを12.5m間隔に再標本化し補間した概形です。縁石・階段・歩道の詳細、水域や私有地の通行判定は含みません。DEMの整備・測量年度は不明です。",
    "標高ゼロの平面道路はDEMに沿わせ、標高ゼロの建物底面はDEMの代表標高へ平行移動しています。補正後の標高はPLATEAUの実測値ではありません。高架・立体交差の完全な通行再現は未対応です。",
    "1km四方のうち準備できた街区だけに進めます。周辺の取得失敗・容量超過時は境界で停止し、欠けた建物を架空のものに置き換えません。");
  return {tiles:samples.size,bytes,drapedRoads,alignedBuildings};
}

/** Subdivide before draping, retaining polygon holes and X/Z footprints. */
export function drapeRoad(mesh:CityMesh,height:(x:number,z:number)=>number):void {
  const points:Point[]=[];for(let i=0;i<mesh.positions.length;i+=3)points.push([mesh.positions[i]!,mesh.positions[i+1]!,mesh.positions[i+2]!]);
  const positions:number[]=[],indices:number[]=[],vertices=new Map<string,number>();
  const vertex=(point:Point):number=>{const key=`${round(point[0])},${round(point[2])}`;const old=vertices.get(key);if(old!==undefined)return old;
    const id=positions.length/3;positions.push(point[0],round(height(point[0],point[2])+.06),point[2]);vertices.set(key,id);return id;};
  const split=(triangle:[Point,Point,Point],depth=0):void=>{
    const lengths=triangle.map((a,i)=>{const b=triangle[(i+1)%3]!;return Math.hypot(a[0]-b[0],a[2]-b[2]);});
    const edge=lengths.indexOf(Math.max(...lengths));
    if(lengths[edge]!>12.5&&depth<18){const a=triangle[edge]!,b=triangle[(edge+1)%3]!,c=triangle[(edge+2)%3]!;
      const mid:Point=[(a[0]+b[0])/2,0,(a[2]+b[2])/2];split([a,mid,c],depth+1);split([mid,b,c],depth+1);
    }else indices.push(...triangle.map(vertex));
    if(positions.length/3>30_000||indices.length>180_000)throw new Error("GEOMETRY_BUDGET");
  };
  for(let i=0;i<mesh.indices.length;i+=3)split([points[mesh.indices[i]!]!,points[mesh.indices[i+1]!]!,points[mesh.indices[i+2]!]!]);
  mesh.positions=positions;mesh.indices=indices;
}
