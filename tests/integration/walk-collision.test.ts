import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Ray } from "@babylonjs/core/Culling/ray.js";
import { createCollisionMesh } from "../../apps/game-client/src/walk/collision.js";
import { boxGeometry,createFixture } from "../../apps/game-client/src/walk/fixture.js";
import "@babylonjs/core/Culling/ray.js";

describe("Babylon collision world without renderer or network",()=>{
  it("blocks a runner at a measured wall and allows tangential movement",()=>{
    const engine=new NullEngine();const scene=new Scene(engine);scene.collisionsEnabled=true;
    const wall=createCollisionMesh(scene,boxGeometry("wall",5,0,2,20,8));
    const player=MeshBuilder.CreateBox("player",{size:1},scene);player.ellipsoid=new Vector3(.42,.9,.42);player.position.set(0,1,0);
    for(let i=0;i<50;i++){player.computeWorldMatrix(true);player.moveWithCollisions(new Vector3(.28,0,.01));}
    expect(player.position.x).toBeLessThanOrEqual(3.6);expect(player.position.x).toBeGreaterThan(3.3);expect(player.position.z).toBeGreaterThan(.1);
    wall.dispose();scene.dispose();engine.dispose();
  });
  it("prevents falling through terrain independently of visible models",()=>{
    const engine=new NullEngine();const scene=new Scene(engine);scene.collisionsEnabled=true;
    const ground=createCollisionMesh(scene,createFixture().meshes[0]!);
    const player=MeshBuilder.CreateBox("player",{size:1},scene);player.ellipsoid=new Vector3(.42,.9,.42);player.position.set(0,3,0);
    for(let i=0;i<300;i++){player.computeWorldMatrix(true);player.moveWithCollisions(new Vector3(0,-.2,0));}
    expect(ground.isVisible).toBe(false);expect(player.position.y).toBeGreaterThan(.89);expect(player.position.y).toBeLessThan(.93);
    scene.dispose();engine.dispose();
  });
  it("camera rays hit invisible collision geometry",()=>{
    const engine=new NullEngine();const scene=new Scene(engine);
    const wall=createCollisionMesh(scene,boxGeometry("wall",5,0,2,20,8));
    const hit=scene.pickWithRay(new Ray(new Vector3(0,1,0),new Vector3(1,0,0),10),mesh=>mesh===wall);
    expect(hit?.hit).toBe(true);expect(hit?.distance).toBeCloseTo(4);
    scene.dispose();engine.dispose();
  });
});
