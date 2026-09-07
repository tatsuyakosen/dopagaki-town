import type { Mesh } from "./converter.js";
import { round, type Point } from "./geometry.js";

export function triangleHeight(x:number,z:number,[a,b,c]:[Point,Point,Point]):number|undefined{
  const d=(b[2]-c[2])*(a[0]-c[0])+(c[0]-b[0])*(a[2]-c[2]);if(Math.abs(d)<1e-7)return;
  const u=((b[2]-c[2])*(x-c[0])+(c[0]-b[0])*(z-c[2]))/d;
  const v=((c[2]-a[2])*(x-c[0])+(a[0]-c[0])*(z-c[2]))/d;
  if(Math.min(u,v,1-u-v)< -1e-7)return;
  return u*a[1]+v*b[1]+(1-u-v)*c[1];
}

export function chooseSpawn(meshes:Mesh[],half=125):Point{
  const roads:[Point,Point,Point][]=[],buildings:[Point,Point,Point][]=[],candidates:Point[]=[];
  for(const mesh of meshes){
    const points:Point[]=[];
    for(let i=0;i<mesh.positions.length;i+=3)points.push([mesh.positions[i]!,mesh.positions[i+1]!,mesh.positions[i+2]!]);
    for(let i=0;i<mesh.indices.length;i+=3){
      const triangle:[Point,Point,Point]=[points[mesh.indices[i]!]!,points[mesh.indices[i+1]!]!,points[mesh.indices[i+2]!]!];
      if(mesh.kind==="building")buildings.push(triangle);
      else{roads.push(triangle);candidates.push([0,1,2].map(k=>triangle.reduce((sum,p)=>sum+p[k]!,0)/3) as Point);}
    }
  }
  const offsets=[[0,0],[.6,0],[-.6,0],[0,.6],[0,-.6],[.45,.45],[-.45,.45],[.45,-.45],[-.45,-.45]] as const;
  for(const [x,y,z] of candidates.sort((a,b)=>a[0]**2+a[2]**2-b[0]**2-b[2]**2)){
    if(Math.max(Math.abs(x),Math.abs(z))>half-2)continue;
    const clear=offsets.every(([dx,dz])=>{
      let ground:number|undefined;
      for(const triangle of roads){const h=triangleHeight(x+dx,z+dz,triangle);if(h!==undefined)ground=Math.max(ground??-Infinity,h);}
      return ground!==undefined&&Math.abs(ground-y)<=.25&&!buildings.some(t=>{const h=triangleHeight(x+dx,z+dz,t);return h!==undefined&&h>=y-.1;});
    });
    if(clear)return [round(x),round(y+.95),round(z)];
  }
  throw new Error("NO_SAFE_SPAWN");
}
