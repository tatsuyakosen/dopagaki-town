import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";

/** Static X/Z grid shared by movement and camera; game overlays keep separate meshes. */
export class CollisionGrid {
  private cells=new Map<string,Set<Mesh>>();
  private global=new Set<Mesh>();
  constructor(meshes:Iterable<Mesh>,private size=16){
    for(const mesh of meshes){
      mesh.computeWorldMatrix(true);const box=mesh.getBoundingInfo().boundingBox;
      const x0=Math.floor(box.minimumWorld.x/size),x1=Math.floor(box.maximumWorld.x/size);
      const z0=Math.floor(box.minimumWorld.z/size),z1=Math.floor(box.maximumWorld.z/size);
      if((x1-x0+1)*(z1-z0+1)>64){this.global.add(mesh);continue;}
      for(let x=x0;x<=x1;x++)for(let z=z0;z<=z1;z++){
        const key=`${x},${z}`;let cell=this.cells.get(key);if(!cell){cell=new Set();this.cells.set(key,cell);}cell.add(mesh);
      }
    }
  }
  key(x:number,z:number):string{return `${Math.floor(x/this.size)},${Math.floor(z/this.size)}`;}
  nearby(x:number,z:number):Set<Mesh>{
    const result=new Set(this.global),cx=Math.floor(x/this.size),cz=Math.floor(z/this.size);
    // Full adjacent cells leave >16m margin, including the 5.5m follow camera.
    for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++)for(const mesh of this.cells.get(`${cx+dx},${cz+dz}`)??[])result.add(mesh);
    return result;
  }
}
