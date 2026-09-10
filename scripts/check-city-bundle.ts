import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const directory=resolve("apps/game-client/dist");
const manifest=JSON.parse(await readFile(`${directory}/.vite/manifest.json`,"utf8")) as Record<string,{file:string;imports?:string[]}>;
const seen=new Set<string>();let gzipBytes=0;
async function visit(key:string):Promise<void>{
  if(seen.has(key))return;seen.add(key);const chunk=manifest[key];assert(chunk,`Missing build chunk: ${key}`);
  assert(!chunk.file.includes(".."));const source=await readFile(`${directory}/${chunk.file}`);
  assert(!source.includes("Babylon.js"),"The map must not import the 3D engine");gzipBytes+=gzipSync(source).length;
  for(const child of chunk.imports??[])await visit(child);
}
await visit("map.html");
assert(gzipBytes<=80*1024,"Map initial JavaScript exceeds the 80KiB gzip budget");
console.log(JSON.stringify({mapInitialJsGzipBytes:gzipBytes,limitBytes:80*1024,staticChunks:seen.size}));
