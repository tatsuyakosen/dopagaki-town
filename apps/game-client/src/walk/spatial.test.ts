import { expect,it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { CollisionGrid } from "./spatial.js";

it("keeps crossing walls and game overlays in nearby collision queries",()=>{
  const engine=new NullEngine();const scene=new Scene(engine);
  const wall=MeshBuilder.CreateBox("wall",{width:40,height:4,depth:1},scene);wall.position.x=20;
  const distant=MeshBuilder.CreateBox("distant",{size:2},scene);distant.position.set(200,0,200);
  const border=MeshBuilder.CreateBox("border",{width:1000,depth:1000,height:1},scene);
  const grid=new CollisionGrid([wall,distant,border]);
  expect(grid.nearby(-1,0).has(wall)).toBe(true);expect(grid.nearby(45,0).has(wall)).toBe(true);
  expect(grid.nearby(0,0).has(distant)).toBe(false);expect(grid.nearby(200,200).has(border)).toBe(true);
  scene.dispose();engine.dispose();
});
