import assert from "node:assert/strict";
import { readFile,stat } from "node:fs/promises";
import { CityManifestSchema,type CityManifest } from "../packages/contracts/src/city.js";

/** Verify generated artifacts in both directions, without a browser or a GPU. */
async function verify():Promise<void>{
  const paths=process.argv.slice(2);assert(paths.length>=2&&paths.length<=25,"Pass 2–25 generated blocks from the same area");
  const blocks=new Map<string,CityManifest>();
  for(const path of paths){
    assert((await stat(path)).size<=4*1024*1024,"Manifest exceeds the browser budget");
    const block=CityManifestSchema.parse(JSON.parse(await readFile(path,"utf8")) as unknown);
    assert(block.mode==="survey"&&block.tile,"Expected a generated survey block");
    const key=`${block.tile.x},${block.tile.z}`;assert(!blocks.has(key),"Duplicate block");
    const first=blocks.values().next().value;if(first)assert.deepEqual(block.origin,first.origin,"Origins differ");blocks.set(key,block);
  }
  let boundaries=0,sharedObjects=0;const connected=new Set<string>();
  for(const [key,block] of blocks){
    const {x,z}=block.tile!;
    for(const [dx,dz] of [[1,0],[0,1]] as const){
      const nextKey=`${x+dx},${z+dz}`,next=blocks.get(nextKey);if(!next)continue;
      const axis=dx?0:2,sortAxis=dx?2:0,edge=(dx?x:z)*250+125;
      const samples=(manifest:CityManifest)=>{
        const terrain=manifest.meshes.filter(mesh=>mesh.kind==="terrain");assert.equal(terrain.length,1,"Expected exactly one terrain surface");
        const positions=terrain[0]!.positions,points:number[][]=[];
        for(let i=0;i<positions.length;i+=3)if(positions[i+axis]===edge)points.push(positions.slice(i,i+3));
        return points.sort((a,b)=>a[sortAxis]!-b[sortAxis]!);
      };
      const a=samples(block),b=samples(next);assert(a.length>1,`No terrain samples on ${key} / ${nextKey}`);
      assert.deepEqual(a,b,`Terrain mismatch on ${key} / ${nextKey}`);
      const objects=new Map(next.meshes.map(mesh=>[mesh.id,mesh]));
      for(const mesh of block.meshes){const other=objects.get(mesh.id);if(other){assert.deepEqual(mesh,other,"Shared object geometry differs");sharedObjects++;}}
      boundaries++;connected.add(key);connected.add(nextKey);
    }
  }
  assert.equal(connected.size,blocks.size,"Some supplied blocks have no tested neighbor");
  console.log(JSON.stringify({result:"passed",blocks:blocks.size,boundaries,sharedObjectPairs:sharedObjects,scope:"Exact generated geometry; not walkability, visual appearance or measured FPS"}));
}
void verify().catch(error=>{console.error(error instanceof Error?error.message:"SEAM_VERIFICATION_FAILED");process.exitCode=1;});
