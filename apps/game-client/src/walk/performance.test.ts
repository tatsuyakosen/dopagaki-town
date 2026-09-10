import {describe,it,expect} from "vitest";
import {WalkPerformance} from "./performance.js";
describe("local gameplay measurements",()=>{
  it("records real frame durations, including stalls, without pretending JS heap is GPU memory",()=>{
    const recorder=new WalkPerformance();for(let i=0;i<590;i++)recorder.add(100,"balanced",1000,3);recorder.add(1000,"low",1200,4);
    expect(recorder.complete).toBe(true);expect(recorder.report()).toMatchObject({frames:591,durationSeconds:60,averageFps:9.8,p95FrameMs:100,framesOver100Ms:1,maximumResidentBlocks:4,peakJsHeapBytes:null,qualities:["balanced","low"]});
    recorder.add(10,"high",9999,9);expect(recorder.report().frames).toBe(591);
  });
  it("ignores invalid samples and caps recording at sixty seconds",()=>{
    const recorder=new WalkPerformance();recorder.add(NaN,"low",0,0);recorder.add(-1,"low",0,0);
    for(let i=0;i<1200;i++)recorder.add(50,"low",500,1,1024);
    expect(recorder.report()).toMatchObject({averageFps:20,durationSeconds:60,p95FrameMs:50,peakJsHeapBytes:1024});
  });
});
