import { parseArgs } from "node:util";
import { setTimeout as pause } from "node:timers/promises";
import { CityBuilder } from "../apps/city-builder/src/service.js";
import { AreaTileSchema,tileCoordinates } from "../packages/contracts/src/area.js";
import { SelectionSchema } from "../apps/city-builder/src/contracts.js";

// Operator preparation, never automatic bulk downloads merely from moving the map.
// Run against the same checkout as the preview, with no other builder process active.
const {values}=parseArgs({options:{latitude:{type:"string"},longitude:{type:"string"},quality:{type:"string",default:"balanced"},tiles:{type:"string"},radius:{type:"string",default:"1"}}});
const selection=SelectionSchema.parse({latitude:Number(values.latitude),longitude:Number(values.longitude)});
const quality=values.quality;if(quality!=="low"&&quality!=="balanced")throw new Error("QUALITY_INVALID");
const radius=Number(values.radius);if(!Number.isInteger(radius)||radius<0||radius>2)throw new Error("RADIUS_INVALID");
const rawTiles=values.tiles?values.tiles.split(",").map(pair=>{if(!/^-?[0-2]:-?[0-2]$/.test(pair))throw new Error("TILE_INVALID");const [x,z]=pair.split(":").map(Number);return {x:x!,z:z!};}):Array.from({length:(radius*2+1)**2},(_,i)=>({x:i%(radius*2+1)-radius,z:Math.floor(i/(radius*2+1))-radius}));
if(rawTiles.length>25)throw new Error("TILE_LIMIT");
const tiles=[...new Map(rawTiles.map(t=>[`${t.x},${t.z}`,AreaTileSchema.parse({...selection,...t})])).values()].sort((a,b)=>Math.hypot(a.x,a.z)-Math.hypot(b.x,b.z));
const builder=new CityBuilder(),controller=new AbortController();let active="";
process.once("SIGINT",()=>{controller.abort();if(active)builder.cancel(active);});
const results:object[]=[];
for(const tile of tiles){
  if(controller.signal.aborted)break;const began=performance.now();
  try{
    const ready=await builder.ready(selection.latitude,selection.longitude,quality,tile);
    if(ready){const result={tile:[tile.x,tile.z],state:"cached",stageId:ready.stageId,seconds:(performance.now()-began)/1000};results.push(result);console.log(JSON.stringify(result));continue;}
    const coordinates=tileCoordinates(tile),catalog=await builder.discover(coordinates.latitude,coordinates.longitude,controller.signal);
    const discovered=performance.now();const job=builder.start(catalog.id,quality,tile);active=job.id;
    while(job.state==="running"&&!controller.signal.aborted)await pause(200);
    active="";const result={tile:[tile.x,tile.z],state:job.state,code:job.code,stageId:job.stageId,catalogSeconds:(discovered-began)/1000,seconds:(performance.now()-began)/1000,stats:job.stats};results.push(result);console.log(JSON.stringify(result));
  }catch(error){const message=error instanceof Error?error.message:"BUILD_FAILED";const result={tile:[tile.x,tile.z],state:"failed",code:/^[A-Z_]{3,60}$/.test(message)?message:"BUILD_FAILED",seconds:(performance.now()-began)/1000};results.push(result);console.log(JSON.stringify(result));}
}
const failures=results.filter(r=>!["ready","cached"].includes((r as {state:string}).state)).length;
console.log(JSON.stringify({completed:results.length,requested:tiles.length,failed:failures,cancelled:controller.signal.aborted}));
if(failures||controller.signal.aborted)process.exitCode=1;
