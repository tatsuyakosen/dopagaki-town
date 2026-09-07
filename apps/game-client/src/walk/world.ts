import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator.js";
import type { CityManifest, CityMesh } from "@dopagaki/contracts";
import { createCollisionMesh } from "./collision.js";

export interface WalkWorld { colliders: Set<Mesh>; surfaces: Set<Mesh>; overlay: TransformNode; gate: Mesh | null; dispose: () => void }

function makeFacade(scene: Scene, emissive: boolean): DynamicTexture {
  const texture = new DynamicTexture(emissive ? "window-light" : "facade", {width:256,height:256}, scene, true);
  texture.wrapU = texture.wrapV = Texture.WRAP_ADDRESSMODE;
  const ctx = texture.getContext();
  ctx.fillStyle = emissive ? "#000000" : "#727985";
  ctx.fillRect(0,0,256,256);
  for (let row=0; row<4; row++) for (let col=0; col<4; col++) {
    const lit = (row*7+col*13)%5 < 2;
    ctx.fillStyle = emissive ? (lit ? "#aa7335" : "#000000") : (lit ? "#b3a080" : "#263644");
    ctx.fillRect(col*64+12,row*64+13,40,39);
    if (!emissive) {ctx.fillStyle="#89909a";ctx.fillRect(col*64+30,row*64+13,3,39);ctx.fillRect(col*64+10,row*64+53,44,3);}
  }
  texture.update();
  return texture;
}

function geometry(source: CityMesh): VertexData {
  const data = new VertexData();
  data.positions = source.positions;
  data.indices = source.indices;
  const normals: number[] = [];
  VertexData.ComputeNormals(source.positions,source.indices,normals);
  data.normals = normals;
  // UVs decorate measured geometry; these are not measured facade details.
  data.uvs = source.positions.flatMap((_,i) => {
    if (i%3) return [];
    const x=source.positions[i] ?? 0, y=source.positions[i+1] ?? 0, z=source.positions[i+2] ?? 0;
    const nx=Math.abs(normals[i] ?? 0), ny=Math.abs(normals[i+1] ?? 0), nz=Math.abs(normals[i+2] ?? 0);
    return ny>.7 ? [x/12,z/12] : [(nx>nz ? z : x)/12,y/12];
  });
  return data;
}

export async function createWalkWorld(scene: Scene, manifest: CityManifest, shadows: ShadowGenerator, progress:(done:number,total:number)=>void=()=>{}): Promise<WalkWorld> {
  const visualRoot = new TransformNode("survey-visual-world",scene);
  const collisionRoot = new TransformNode("survey-collision-world",scene);
  const overlay = new TransformNode("game-overlay-not-survey",scene);
  const colliders = new Set<Mesh>();
  const surfaces = new Set<Mesh>();
  const facade = new StandardMaterial("interpreted-facade",scene);
  facade.diffuseColor = Color3.FromHexString("#acb1ba");
  facade.diffuseTexture=makeFacade(scene,false);
  facade.emissiveTexture=makeFacade(scene,true);
  facade.emissiveColor=new Color3(.8,.66,.48);
  facade.specularColor = new Color3(.15,.17,.2);
  facade.backFaceCulling=false;
  const road = new StandardMaterial("survey-road",scene);
  road.diffuseColor=Color3.FromHexString("#303642"); road.specularColor.set(.12,.12,.12); road.backFaceCulling=false;
  const terrain = new StandardMaterial("survey-terrain",scene);
  terrain.diffuseColor=Color3.FromHexString("#686766");terrain.specularColor.set(0,0,0);terrain.backFaceCulling=false;
  const collisionMaterial=new StandardMaterial("collision-two-sided",scene);collisionMaterial.backFaceCulling=false;
  let yieldedAt=performance.now(),done=0;
  for (const source of manifest.meshes) {
    const data=geometry(source);
    const mesh=new Mesh(`visual-${source.id}`,scene);data.applyToMesh(mesh);
    mesh.parent=visualRoot;mesh.material=source.kind==="building"?facade:source.kind==="road"?road:terrain;
    mesh.isPickable=false;mesh.receiveShadows=true;mesh.freezeWorldMatrix();
    if(source.kind==="building") shadows.addShadowCaster(mesh);
    const collision=createCollisionMesh(scene,source);
    collision.parent=collisionRoot;collision.material=collisionMaterial;collision.isVisible=false;
    collision.checkCollisions=true;collision.isPickable=true;collision.freezeWorldMatrix();colliders.add(collision);
    if(source.kind!=="building") surfaces.add(collision);
    done++;
    if(performance.now()-yieldedAt>6){progress(done,manifest.meshes.length);await new Promise<void>(resolve=>setTimeout(resolve,0));yieldedAt=performance.now();}
  }
  facade.freeze();road.freeze();terrain.freeze();collisionMaterial.freeze();
  const borderMaterial = new StandardMaterial("test-boundary",scene);
  borderMaterial.diffuseColor=Color3.FromHexString("#f3bc78");borderMaterial.emissiveColor=new Color3(.15,.08,.02);
  const half=manifest.playableHalfSize;
  for(const [x,z,w,d] of [[-half,0,.5,half*2],[half,0,.5,half*2],[0,-half,half*2,.5],[0,half,half*2,.5]]) {
    const wall=MeshBuilder.CreateBox("play-area-boundary",{width:w!,depth:d!,height:600},scene);
    wall.position.set(x!,100,z!);wall.parent=overlay;wall.isVisible=false;wall.checkCollisions=true;colliders.add(wall);
    const line=MeshBuilder.CreateBox("play-area-marker",{width:w!,depth:d!,height:.12},scene);
    line.position.set(x!,0.1,z!);line.parent=overlay;line.material=borderMaterial;line.isPickable=false;
  }
  let gate:Mesh|null=null;
  if(manifest.mode==="fixture") {
    gate=MeshBuilder.CreateBox("test-gate",{width:32,height:2.8,depth:.5},scene);
    gate.position.set(0,1.4,20);gate.parent=overlay;gate.material=borderMaterial;
    gate.checkCollisions=true;gate.setEnabled(false);colliders.add(gate);
  }
  return {colliders,surfaces,overlay,gate,dispose:()=>{visualRoot.dispose(false,true);collisionRoot.dispose(false,true);overlay.dispose(false,true);colliders.clear();surfaces.clear();}};
}
