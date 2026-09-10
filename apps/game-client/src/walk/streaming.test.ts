import { afterEach,describe,it,expect,vi } from "vitest";
import { AreaStreamer } from "./streaming.js";
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
    const fetcher=vi.fn((path:string)=>Promise.resolve(new Response(JSON.stringify(path.endsWith("catalog")?{id:"a".repeat(24)}:path.endsWith("jobs")?{id:"b".repeat(24),state:"ready",stageId:"c".repeat(24)}:next))));vi.stubGlobal("fetch",fetcher);
    const stream=new AreaStreamer(manifest(),w,"balanced",notify,vi.fn());expect(stream.canEnter(-126,0)).toBe(false);
    stream.update(0,0);await vi.advanceTimersByTimeAsync(300);
    expect(w.addBlock).toHaveBeenCalledOnce();expect(stream.canEnter(-126,0)).toBe(true);expect(fetcher).toHaveBeenCalledTimes(3);stream.dispose();
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
