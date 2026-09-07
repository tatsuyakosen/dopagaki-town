import { describe,expect,it,vi } from "vitest";
import { CityBuilder,readStage,type runWorker } from "./service.js";
import { allowedWrite } from "./http.js";
import { SelectionSchema,BuildRequestSchema,validatePlan,type Catalog } from "./contracts.js";
import { createFixture } from "../../game-client/src/walk/fixture.js";

const catalog:Catalog={latitude:34.705,longitude:135.4967,city:"Synthetic test city",year:2025,license:"CC BY 4.0",metadataUrl:"https://example.com/metadata",metadataSha256:"0".repeat(64),
  files:[{url:"https://example.com/building",bytes:100,kind:"bldg"},{url:"https://example.com/road",bytes:100,kind:"tran"}]};
const manifest={...createFixture(),mode:"survey",title:"Synthetic lifecycle test",sources:[{title:"Synthetic test only",provider:"Tests",datasetYear:2025,surveyYear:null,url:"https://example.com/data",license:"Test only",licenseUrl:"https://example.com/license",attribution:"Synthetic test only",retrievedAt:"2026-09-07",sha256:"0".repeat(64)}]};
const planner=()=>Promise.resolve({lod:1 as const,provider:"rules" as const});

describe("bounded city jobs",()=>{
  it("validates area and rejects arbitrary source URL input",()=>{
    expect(SelectionSchema.safeParse({latitude:34.7,longitude:135.5,url:"https://example.com"}).success).toBe(false);
    expect(SelectionSchema.safeParse({latitude:NaN,longitude:135.5}).success).toBe(false);
    expect(BuildRequestSchema.safeParse({catalogId:"../private",quality:"low"}).success).toBe(false);
  });
  it("AI cannot raise LOD limits or return geometry/code",()=>{
    expect(validatePlan({lod:1},"low")).toEqual({lod:1});
    expect(()=>validatePlan({lod:2},"low")).toThrow();expect(()=>validatePlan({lod:3},"balanced")).toThrow();
    expect(()=>validatePlan({lod:1,script:"example"},"low")).toThrow();
  });
  it("requires same-origin write intent",()=>{
    expect(allowedWrite({headers:{host:"localhost:5173",origin:"https://elsewhere.example","x-city-client":"1"}})).toBe(false);
    expect(allowedWrite({headers:{host:"localhost:5173",origin:"http://localhost:5173","x-city-client":"1"}})).toBe(true);
    expect(allowedWrite({headers:{host:"localhost:5173"}})).toBe(false);
  });
  it("reuses ready data, independently serves it, and avoids a second conversion",async()=>{
    let builds=0;
    const worker:typeof runWorker=request=>{
      if((request as {action:string}).action==="discover")return Promise.resolve(catalog);
      builds++;return Promise.resolve({manifest,stats:{vertices:100}});
    };
    const builder=new CityBuilder(worker,planner);const area=await builder.discover(34.705,135.4967);
    const job=builder.start(area.id,"low");await vi.waitFor(()=>expect(builder.get(job.id)?.state).toBe("ready"));
    expect(builder.start(area.id,"low").id).toBe(job.id);expect(builds).toBe(1);
    expect((await readStage(job.stageId!,false)).byteLength).toBeGreaterThan(0);
    expect((await readStage(job.stageId!,true)).byteLength).toBeLessThan((await readStage(job.stageId!,false)).byteLength);
    await expect(readStage("../../private",false)).rejects.toThrow();
  });
  it("rejects duplicate active jobs and aborts the conversion",async()=>{
    const worker:typeof runWorker=async(request,signal)=>{
      if((request as {action:string}).action==="discover")return catalog;
      return new Promise((_,reject)=>{signal.addEventListener("abort",()=>reject(new Error("CANCELLED")),{once:true});});
    };
    const builder=new CityBuilder(worker,planner);const area=await builder.discover(34.705,135.4967);const job=builder.start(area.id,"low");
    await new Promise<void>(resolve=>setTimeout(resolve,0));expect(()=>builder.start(area.id,"balanced")).toThrow("BUSY");
    builder.cancel(job.id);await vi.waitFor(()=>expect(builder.get(job.id)?.state).toBe("cancelled"));
    expect(builder.get(job.id)?.stageId).toBeUndefined();
  });
  it("does not publish fabricated or invalid worker output",async()=>{
    const worker:typeof runWorker=request=>Promise.resolve((request as {action:string}).action==="discover"?catalog:{manifest:createFixture(),stats:{}});
    const builder=new CityBuilder(worker,planner);const area=await builder.discover(34.705,135.4967);const job=builder.start(area.id,"low");
    await vi.waitFor(()=>expect(builder.get(job.id)?.state).toBe("failed"));expect(job.stageId).toBeUndefined();
  });
  it("requires a reviewed catalog before building",()=>expect(()=>new CityBuilder().start("0".repeat(24),"low")).toThrow("CATALOG_EXPIRED"));
});
