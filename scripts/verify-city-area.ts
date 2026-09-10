import { readFile,stat } from "node:fs/promises";
import assert from "node:assert/strict";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Ray } from "@babylonjs/core/Culling/ray.js";
import { CityManifestSchema,type CityMesh } from "../packages/contracts/src/city.js";
import { createCollisionMesh } from "../apps/game-client/src/walk/collision.js";
import { CollisionGrid } from "../apps/game-client/src/walk/spatial.js";
import { movementSteps,frameSeconds } from "../apps/game-client/src/walk/movement.js";
import "@babylonjs/core/Collisions/collisionCoordinator.js";

async function verify():Promise<void>{
  const paths=process.argv.slice(2);assert.equal(paths.length,2,"Pass two horizontally adjacent generated blocks");
  const blocks=[];
  for(const path of paths){assert((await stat(path)).size<=4*1024*1024);const m=CityManifestSchema.parse(JSON.parse(await readFile(path,"utf8")) as unknown);assert(m.tile&&m.mode==="survey");blocks.push(m);}
  blocks.sort((a,b)=>a.tile!.x-b.tile!.x);const [left,right]=blocks;
  assert.equal(right!.tile!.x-left!.tile!.x,1);assert.equal(left!.tile!.z,right!.tile!.z);assert.deepEqual(left!.origin,right!.origin);
  const seam=left!.tile!.x*250+125;
  const edge=(mesh:CityMesh)=>{const points:number[][]=[];for(let i=0;i<mesh.positions.length;i+=3)if(mesh.positions[i]===seam)points.push(mesh.positions.slice(i,i+3));return points;};
  const a=edge(left!.meshes.find(m=>m.kind==="terrain")!),b=edge(right!.meshes.find(m=>m.kind==="terrain")!);
  assert(a.length>1);assert.deepEqual(a,b,"Terrain edge samples must match exactly");
  const unique=new Map<string,CityMesh>();let shared=0;
  for(const m of blocks.flatMap(block=>block.meshes)){const prior=unique.get(m.id);if(prior){assert.deepEqual(prior,m,"Shared geometry must match across blocks");shared++;}else unique.set(m.id,m);}
  const engine=new NullEngine(),scene=new Scene(engine);scene.collisionsEnabled=true;
  try{
    const colliders=[...unique.values()].map(source=>({mesh:createCollisionMesh(scene,source),kind:source.kind}));
    const surfaces=new Set(colliders.filter(c=>c.kind!=="building").map(c=>c.mesh));const grid=new CollisionGrid(colliders.map(c=>c.mesh));
    const ground=(x:number,z:number):number|undefined=>{const nearby=grid.nearby(x,z);const hit=scene.pickWithRay(new Ray(new Vector3(x,2000,z),Vector3.Down(),4000),m=>nearby.has(m as never));return hit?.hit&&hit.pickedPoint&&surfaces.has(hit.pickedMesh as never)?hit.pickedPoint.y:undefined;};
    let lane:number|undefined;
    for(let offset=0;offset<=110&&lane===undefined;offset+=5)for(const sign of [1,-1]){
      const z=left!.tile!.z*250+offset*sign;let clear=true;
      for(let x=seam-22;x<=seam+22&&clear;x+=1)for(const dz of [-.65,0,.65]){const h=ground(x,z+dz);if(h===undefined){clear=false;break;}}
      if(clear){lane=z;break;}
    }
    assert(lane!==undefined,"No clear lane across the terrain seam was found");
    const startX=seam-18,startY=ground(startX,lane)!,distances:number[]=[];
    for(const fps of [20,60]){
      const player=MeshBuilder.CreateBox("seam-walker",{size:1},scene);player.isPickable=false;player.ellipsoid=new Vector3(.42,.9,.42);player.ellipsoidOffset=Vector3.Zero();player.position.set(startX,startY+.95,lane);
      let vertical=0;
      for(let frame=0;frame<5*fps;frame++)for(const dt of movementSteps(frameSeconds(1000/fps))){
        const previousY=player.position.y;player.computeWorldMatrix(true);player.surroundingMeshes=[...grid.nearby(player.position.x,player.position.z)];
        vertical=Math.max(-25,vertical-18*dt);player.moveWithCollisions(new Vector3(7*dt,vertical*dt,0));
        if(Math.abs(player.position.y-previousY)<.002)vertical=-.5;
        const h=ground(player.position.x,player.position.z);assert(h!==undefined&&player.position.y>h+.6,"Walker fell through or under the terrain");
      }
      assert(player.position.x>seam+12,"Walker did not cross the seam");distances.push(player.position.x-startX);player.dispose();
    }
    assert(Math.abs(distances[0]!-distances[1]!)<.05,"Frame rates changed traversal speed");
    const elevations=blocks.flatMap(block=>block.meshes.filter(m=>m.kind==="terrain").flatMap(m=>m.positions.filter((_,i)=>i%3===1)));
    console.log(JSON.stringify({result:"passed",renderer:"NullEngine / no GPU or measured FPS",blocks:2,sharedMeshes:shared,seamVertices:a.length,seamHeightDifference:0,
      terrainMinY:Math.min(...elevations),terrainMaxY:Math.max(...elevations),simulated20FpsDistance:distances[0],simulated60FpsDistance:distances[1]}));
  }finally{scene.dispose();engine.dispose();}
}
void verify().catch(error=>{console.error(error instanceof Error?error.message:"AREA_VERIFICATION_FAILED");process.exitCode=1;});
