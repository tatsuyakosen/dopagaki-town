import { afterEach,describe,it,expect,vi } from "vitest";
import { AreaStreamer, wantedTiles } from "./streaming.js";
import { createFixture } from "./fixture.js";
import type { WalkWorld } from "./world.js";
import type { CityManifest } from "../../../../packages/contracts/src/city.js";

function manifest(x=0):CityManifest{
  return {...createFixture(),mode:"survey",origin:{latitude:34.7,longitude:135.5,altitude:0},playableHalfSize:500,
    tile:{latitude:34.7,longitude:135.5,x,z:0},sources:[{title:"Synthetic test",provider:"Tests",datasetYear:2025,surveyYear:null,url:"https://example.com/test",license:"Test",licenseUrl:"https://example.com/license",attribution:"Synthetic test",retrievedAt:"2026-09-10",sha256:"0".repeat(64)}]};
}
function world():WalkWorld{return {colliders:new Set(),surfaces:new Set(),overlay:undefined as never,gate:null,revision:0,vertices:0,
  addBlock:vi.fn(()=>Promise.resolve()),removeBlock:vi.fn(),dispose:vi.fn()};}
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
describe("streaming lifecycle",()=>{
  it("adds one validated neighbor and opens its boundary",async()=>{
    vi.useFakeTimers();const w=world(),next=manifest(-1),notify=vi.fn();
    const fetcher=vi.fn((path:string)=>Promise.resolve(new Response(JSON.stringify(path.endsWith("ready")?{ready:null}:path.endsWith("catalog")?{id:"a".repeat(24)}:path.endsWith("jobs")?{id:"b".repeat(24),state:"ready",stageId:"c".repeat(24)}:next))));vi.stubGlobal("fetch",fetcher);
    const stream=new AreaStreamer(manifest(),w,"balanced",notify,vi.fn());expect(stream.canEnter(-126,0)).toBe(false);
    stream.update(0,0);await vi.advanceTimersByTimeAsync(300);
    expect(w.addBlock).toHaveBeenCalledOnce();expect(stream.canEnter(-126,0)).toBe(true);expect(fetcher).toHaveBeenCalledTimes(4);stream.dispose();
  });
  it("keeps an unavailable neighbor closed and permits explicit retry",async()=>{
    vi.useFakeTimers();const w=world(),fetcher=vi.fn(()=>Promise.resolve(new Response(JSON.stringify({code:"SOURCE_TOO_LARGE"}),{status:400})));vi.stubGlobal("fetch",fetcher);
    const stream=new AreaStreamer(manifest(),w,"balanced",vi.fn(),vi.fn());stream.update(0,0);await vi.advanceTimersByTimeAsync(300);
    expect(stream.failedKeys.has("-1,0")).toBe(true);expect(w.addBlock).not.toHaveBeenCalled();expect(stream.canEnter(-126,0)).toBe(false);
    stream.retry();await vi.advanceTimersByTimeAsync(300);expect(fetcher).toHaveBeenCalledTimes(2);stream.dispose();
  });
  it("does not fetch after disposal",async()=>{
    vi.useFakeTimers();const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);const stream=new AreaStreamer(manifest(),world(),"low",vi.fn(),vi.fn());
    stream.update(0,0);stream.dispose();await vi.advanceTimersByTimeAsync(500);expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("predictive and cached streaming",()=>{
  it("prioritizes the direction of travel while retaining the player's block",()=>{
    const east=wantedTiles(0,0,{x:7,z:0}),west=wantedTiles(0,0,{x:-7,z:0});
    expect(east.slice(0,2).map(t=>[t.x,t.z])).toEqual([[0,0],[1,0]]);expect(west[1]?.x).toBe(-1);expect(east).toHaveLength(5);
  });
  it("opens a cached neighbor without catalog search or conversion",async()=>{
    vi.useFakeTimers();const w=world();const fetcher=vi.fn((path:string)=>Promise.resolve(new Response(JSON.stringify(path.endsWith("ready")?{ready:{stageId:"c".repeat(24)}}:manifest(1)))));vi.stubGlobal("fetch",fetcher);
    const stream=new AreaStreamer(manifest(),w,"balanced",vi.fn(),vi.fn());stream.update(0,0,{x:7,z:0});await vi.advanceTimersByTimeAsync(300);
    expect(w.addBlock).toHaveBeenCalledOnce();expect(stream.canEnter(126,0)).toBe(true);expect(fetcher).toHaveBeenCalledTimes(2);expect(stream.stats.cacheHits).toBe(1);stream.dispose();
  });
  it("waits for other walkers without exhausting the network failure budget",async()=>{
    vi.useFakeTimers();const fetcher=vi.fn(()=>Promise.resolve(new Response(JSON.stringify({code:"BUSY"}),{status:429})));vi.stubGlobal("fetch",fetcher);
    const stream=new AreaStreamer(manifest(),world(),"low",vi.fn(),vi.fn());stream.update(0,0);await vi.advanceTimersByTimeAsync(300);
    for(let i=0;i<20;i++){await vi.advanceTimersByTimeAsync(3100);stream.update(0,0);await vi.advanceTimersByTimeAsync(300);}
    expect(stream.failedKeys.size).toBe(0);expect(fetcher).toHaveBeenCalledTimes(21);stream.dispose();
  });
});

describe("resident street boundaries",()=>{
  it("evicts distant blocks while keeping at most five and preserving the player's surface",async()=>{
    vi.useFakeTimers();const w=world(),stages=new Map<string,CityManifest>();let sequence=0;
    const fetcher=vi.fn((path:string,request?:RequestInit)=>{
      if(path.endsWith("ready")){
        const {tile}=JSON.parse(request!.body as string) as {tile:NonNullable<CityManifest["tile"]>};
        const id=(++sequence).toString(16).padStart(24,"0"),next={...manifest(tile.x),tile};stages.set(id,next);
        return Promise.resolve(new Response(JSON.stringify({ready:{stageId:id}})));
      }
      return Promise.resolve(new Response(JSON.stringify(stages.get(path.split("/").at(-1)!))));
    });vi.stubGlobal("fetch",fetcher);
    const stream=new AreaStreamer(manifest(),w,"balanced",vi.fn(),vi.fn());
    for(let i=0;i<5;i++){stream.update(0,0,{x:7,z:0});await vi.advanceTimersByTimeAsync(300);expect(stream.readyKeys.size).toBeLessThanOrEqual(5);}
    expect(stream.canEnter(126,0)).toBe(true);
    for(let i=0;i<5;i++){stream.update(250,0,{x:7,z:0});await vi.advanceTimersByTimeAsync(300);expect(stream.readyKeys.size).toBeLessThanOrEqual(5);expect(stream.isReady(250,0)).toBe(true);}
    expect(w.removeBlock).toHaveBeenCalled();stream.dispose();
  });
});
