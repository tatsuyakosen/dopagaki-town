import { PlanSchema, validatePlan, type Catalog, type Quality } from "../../city-builder/src/contracts.js";
import { assertAdkRuntime } from "./runtime.js";

export function cityPlannerEnabled():boolean {
  return process.env.CITY_PLANNER==="gemini-adk" && Boolean(process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY);
}

export async function planCity(catalog:Catalog, quality:Quality, signal:AbortSignal):Promise<{lod:1|2;provider:"rules"|"gemini-adk"}> {
  if(!cityPlannerEnabled())return {lod:quality==="low"?1:2,provider:"rules"};
  assertAdkRuntime(process.versions.node);
  const { InMemoryRunner, LlmAgent }=await import("@google/adk");
  const agent=new LlmAgent({name:"city_build_planner",model:process.env.CITY_PLANNER_MODEL ?? "gemini-2.5-flash",
    instruction:"Choose a PLATEAU building LOD cap, 1 or 2. Return JSON only. Low quality MUST use 1. Prefer 1 for large source files, otherwise 2 for balanced quality. You may not generate geometry, URLs, scripts, or raise limits.",
    outputSchema:PlanSchema,generateContentConfig:{temperature:0,maxOutputTokens:128}});
  const runner=new InMemoryRunner({agent,appName:"city-builder"});
  const session=await runner.sessionService.createSession({appName:runner.appName,userId:"public-area"});
  let result="";
  for await(const event of runner.runAsync({userId:session.userId,sessionId:session.id,abortSignal:signal,
    newMessage:{role:"user",parts:[{text:JSON.stringify({quality,city:catalog.city,year:catalog.year,sourceBytes:catalog.files.reduce((n,f)=>n+f.bytes,0),fileCount:catalog.files.length})}]}})) {
    const part=event.content?.parts?.filter(p=>p.thought!==true&&typeof p.text==="string").map(p=>p.text).join("");
    if(part?.trim())result=part;
  }
  signal.throwIfAborted();
  return {...validatePlan(JSON.parse(result) as unknown,quality),provider:"gemini-adk"};
}
