import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { CityMesh } from "@dopagaki/contracts";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Collider } from "@babylonjs/core/Collisions/collider.js";
import "@babylonjs/core/Collisions/collisionCoordinator.js";

export function createCollisionMesh(scene:Scene,source:CityMesh):Mesh {
  // Paired triangles must only collide on the side facing the motion. Without
  // this Babylon can resolve against the back face and sink below the ground.
  Collider.DoubleSidedCheck=true;
  const mesh=new Mesh(`collision-${source.id}`,scene);const data=new VertexData();data.positions=source.positions;
  const reversed:number[]=[];
  for(let i=0;i<source.indices.length;i+=3)reversed.push(source.indices[i]!,source.indices[i+2]!,source.indices[i+1]!);
  data.indices=[...source.indices,...reversed];data.applyToMesh(mesh);
  const material=scene.getMaterialByName("collision-two-sided") ?? new StandardMaterial("collision-two-sided",scene);
  material.backFaceCulling=false;mesh.material=material;
  mesh.isVisible=false;mesh.checkCollisions=true;mesh.isPickable=true;mesh.freezeWorldMatrix();return mesh;
}
