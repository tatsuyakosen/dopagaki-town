import { readFile,stat } from "node:fs/promises";
import assert from "node:assert/strict";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Ray } from "@babylonjs/core/Culling/ray.js";
import { CityManifestSchema } from "../packages/contracts/src/city.js";
import { createCollisionMesh } from "../apps/game-client/src/walk/collision.js";
import { CollisionGrid } from "../apps/game-client/src/walk/spatial.js";
import "@babylonjs/core/Collisions/collisionCoordinator.js";

async function verify():Promise<void>{
  const path=process.argv[2];assert(path,"Pass a generated CityManifest path");assert((await stat(path)).size<=4*1024*1024);
  const manifest=CityManifestSchema.parse(JSON.parse(await readFile(path,"utf8")) as unknown);assert.equal(manifest.mode,"survey");
  const engine=new NullEngine();const scene=new Scene(engine);scene.collisionsEnabled=true;
  try{
    const material=new StandardMaterial("two-sided-collision",scene);material.backFaceCulling=false;
    const meshes=manifest.meshes.map(source=>{const mesh=createCollisionMesh(scene,source);mesh.material=material;mesh.isVisible=false;mesh.checkCollisions=true;mesh.computeWorldMatrix(true);return mesh;});
    const surfaces=new Set<AbstractMesh>(meshes.filter((_,i)=>manifest.meshes[i]!.kind!=="building"));const all=new Set<AbstractMesh>(meshes);
    const origin=new Vector3(...manifest.spawn);
    const hit=scene.pickWithRay(new Ray(new Vector3(origin.x,2000,origin.z),Vector3.Down(),4000),mesh=>all.has(mesh));
    assert(hit?.hit&&hit.pickedPoint&&hit.pickedMesh&&surfaces.has(hit.pickedMesh),"Spawn must hit a surveyed road before any roof");
    origin.y=hit.pickedPoint.y+.95;
    const player=MeshBuilder.CreateBox("walker-test",{size:1},scene);player.ellipsoid=new Vector3(.42,.9,.42);player.ellipsoidOffset=Vector3.Zero();player.position.copyFrom(origin);
    const grid=new CollisionGrid(meshes);player.surroundingMeshes=[...grid.nearby(origin.x,origin.z)];
    const began=performance.now();
    for(let frame=0;frame<300;frame++){player.computeWorldMatrix(true);player.moveWithCollisions(new Vector3(0,-.1,0));}
    assert(Math.abs(player.position.y-(hit.pickedPoint.y+.9))<.03,"Repeated ground contact must not sink");
    const groundedAt=performance.now();
    for(const direction of [new Vector3(1,0,0),new Vector3(-1,0,0),new Vector3(0,0,1),new Vector3(0,0,-1)]){
      player.position.copyFrom(origin);
      for(let frame=0;frame<120;frame++){
        player.computeWorldMatrix(true);player.surroundingMeshes=[...grid.nearby(player.position.x,player.position.z)];
        const previous=player.position.clone();player.moveWithCollisions(direction.scale(7/60).add(new Vector3(0,-.08,0)));
        assert(Math.hypot(player.position.x-previous.x,player.position.z-previous.z)<=7/60+.02,"Collision cannot teleport the player");
        assert(player.position.asArray().every(Number.isFinite));
        if(player.position.y<origin.y-5)player.position.copyFrom(origin);
      }
    }
    console.log(JSON.stringify({result:"passed",renderer:"NullEngine / CPU only, not FPS",meshes:meshes.length,
      vertices:manifest.meshes.reduce((n,m)=>n+m.positions.length/3,0),groundFrames:300,directionalFrames:480,
      groundCollisionMs:Math.round(groundedAt-began),directionalCollisionMs:Math.round(performance.now()-groundedAt)}));
  }finally{scene.dispose();engine.dispose();}
}
void verify().catch(()=>{console.error("CITY_COLLISION_VERIFICATION_FAILED");process.exitCode=1;});
