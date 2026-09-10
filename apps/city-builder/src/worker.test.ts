import {describe,it,expect,vi} from "vitest";
import {downloadGeometry} from "./worker.js";
import type {Catalog} from "./contracts.js";
import type {Download} from "./source.js";
const files=Array.from({length:6},(_,i)=>({url:`https://assets.cms.plateau.reearth.io/assets/test-${i}`,bytes:10,kind:i%2?"tran" as const:"bldg" as const}));
const catalog:Catalog={latitude:34.7,longitude:135.5,city:"Synthetic test",year:2025,license:"CC BY 4.0",files,metadataUrl:"https://example.com/metadata",metadataSha256:"0".repeat(64)};
describe("bounded parallel geometry acquisition",()=>{
  it("never exceeds two downloads and preserves file ordering",async()=>{
    let active=0,peak=0;const download:Download=async url=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,5));active--;return {data:Buffer.from(url),hit:false};};
    const progress=vi.fn();const result=await downloadGeometry(catalog,download,progress);
    expect(peak).toBe(2);expect(result.paths).toHaveLength(6);expect([...result.byHash.values()]).toEqual(files.map(f=>f.url));expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({completed:6,total:6}));
  });
  it("waits for the bounded batch to settle before reporting a failure",async()=>{
    let ended=false;const download:Download=async url=>{if(url.endsWith("0"))throw new Error("SOURCE_TIMEOUT");await new Promise(resolve=>setTimeout(resolve,5));ended=true;return {data:Buffer.from(url),hit:false};};
    await expect(downloadGeometry(catalog,download)).rejects.toThrow("SOURCE_TIMEOUT");expect(ended).toBe(true);
  });
});
