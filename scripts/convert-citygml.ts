import { parseArgs } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { convert } from "../apps/city-builder/src/converter.js";
import type { Point } from "../apps/city-builder/src/geometry.js";

try{
  const {values,positionals}=parseArgs({allowPositionals:true,options:{
    "source-metadata":{type:"string"},out:{type:"string"},origin:{type:"string"},
    "block-half-size":{type:"string",default:"125"},spawn:{type:"string",default:"0,2,0"},
  }});
  if(!positionals.length||!values["source-metadata"]||!values.out||!values.origin)throw new Error("Arguments required");
  const point=(value:string):Point=>{const values=value.split(",").map(Number);if(values.length!==3||!values.every(Number.isFinite))throw new Error("Invalid point");return values as Point;};
  const source=await readFile(values["source-metadata"],"utf8");if(Buffer.byteLength(source)>16*1024)throw new Error("Metadata too large");
  const manifest=await convert(positionals,JSON.parse(source) as unknown,point(values.origin),Number(values["block-half-size"]),point(values.spawn));
  const json=JSON.stringify(manifest),bytes=Buffer.byteLength(json);if(bytes>20*1024*1024)throw new Error("Output budget exceeded");
  await mkdir(dirname(values.out),{recursive:true});await writeFile(values.out,json,{flag:"wx"});
  console.log(JSON.stringify({meshes:manifest.meshes.length,sources:manifest.sources.length,bytes}));
}catch{
  console.error("Conversion failed: check arguments, supported geometry, metadata, file access and budgets. Output files are never overwritten.");
  process.exitCode=1;
}
