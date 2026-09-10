import { describe,it,expect } from "vitest";
import { addTerrain,parseDem,drapeRoad } from "./terrain.js";
import { checkUrl,type Download } from "./source.js";
import { createFixture } from "../../game-client/src/walk/fixture.js";
import { CityManifestSchema,type CityMesh } from "../../../packages/contracts/src/city.js";
import { areaTileAt,tileBounds,tileCoordinates } from "../../../packages/contracts/src/area.js";
import { wantedTiles,canEnterTiles } from "../../game-client/src/walk/streaming.js";

const origin={latitude:34.705,longitude:135.4967,altitude:0};
const dem:Download=(url)=>{
  const match=/\/(\d+)\/(\d+)\.txt$/.exec(url)!;const x=Number(match[1])*256,y=Number(match[2])*256;
  return Promise.resolve({data:Buffer.from(Array.from({length:256},(_,row)=>Array.from({length:256},(_,col)=>((x+col+y+row)/10000).toFixed(2)).join(",")).join("\n")),hit:false});
};
const fixture=()=>{const m=createFixture();m.origin=origin;m.meshes=m.meshes.filter(mesh=>mesh.kind!=="terrain");return m;};

describe("elevation and block seams",()=>{
  it("rejects malformed, unbounded and missing elevation values",()=>{
    expect(()=>parseDem(Buffer.from("0,0"))).toThrow("ELEVATION_INVALID");
    const text=Array.from({length:256},()=>Array<string>(256).fill("e").join(",")).join("\n");expect(Number.isNaN(parseDem(Buffer.from(text))[0])).toBe(true);
  });
  it("allows only the fixed GSI DEM endpoint",()=>{
    expect(checkUrl("https://cyberjapandata.gsi.go.jp/xyz/dem/14/14358/6506.txt")).toContain("/dem/14/");
    for(const url of ["https://cyberjapandata.gsi.go.jp/xyz/std/14/1/2.png","https://cyberjapandata.gsi.go.jp/xyz/dem/14/1/2.txt?token=x","https://example.com/xyz/dem/14/1/2.txt"])expect(()=>checkUrl(url)).toThrow("SOURCE_URL_REJECTED");
  });
  it("preserves a shared terrain edge and records unknown survey years",async()=>{
    const left=fixture(),right=fixture();await addTerrain(left,{...origin,x:0,z:0},dem);await addTerrain(right,{...origin,x:1,z:0},dem);
    const edge=(mesh:CityMesh)=>{const points:number[][]=[];for(let i=0;i<mesh.positions.length;i+=3)if(mesh.positions[i]===125)points.push(mesh.positions.slice(i,i+3));return points;};
    expect(edge(left.meshes.at(-1)!)).toEqual(edge(right.meshes.at(-1)!));expect(edge(left.meshes.at(-1)!)).toHaveLength(21);
    expect(left.sources.every(s=>s.datasetYear===null&&s.surveyYear===null)).toBe(true);expect(CityManifestSchema.safeParse(left).success).toBe(true);
  });
  it("does not turn missing elevations into a flat surface",async()=>{
    const missing:Download=()=>Promise.resolve({data:Buffer.from(Array.from({length:256},()=>Array<string>(256).fill("e").join(",")).join("\n")),hit:false});
    await expect(addTerrain(fixture(),{...origin,x:0,z:0},missing)).rejects.toThrow("ELEVATION_MISSING");
  });
  it("subdivides flat road triangles before draping without expanding the footprint",()=>{
    const m:CityMesh={id:"road",kind:"road",positions:[0,0,0,50,0,0,0,0,50],indices:[0,2,1]};drapeRoad(m,(x,z)=>(x+z)/10);
    expect(m.positions.length/3).toBeGreaterThan(3);for(let i=0;i<m.positions.length;i+=3){expect(m.positions[i]!+m.positions[i+2]!).toBeLessThanOrEqual(50);expect(m.positions[i+1]).toBeCloseTo((m.positions[i]!+m.positions[i+2]!)/10+.06);}
  });
});
describe("bounded area streaming",()=>{
  it("covers exactly a 1km square including partial outside tiles",()=>{
    let area=0;for(let x=-2;x<=2;x++)for(let z=-2;z<=2;z++){const b=tileBounds({x,z});area+=(b.maxX-b.minX)*(b.maxZ-b.minZ);}expect(area).toBe(1_000_000);
    expect(tileBounds({x:2,z:2}).maxX).toBe(500);expect(areaTileAt(126,-126)).toEqual({x:1,z:-1});
  });
  it("prefetches neighbors before reaching an edge with no more than five desired tiles",()=>{
    expect(wantedTiles(0,0)).toHaveLength(5);expect(wantedTiles(120,120).map(t=>`${t.x},${t.z}`)).toContain("1,1");expect(wantedTiles(490,490).every(t=>Math.abs(t.x)<=2&&Math.abs(t.z)<=2)).toBe(true);
  });
  it("blocks unloaded geometry under any part of the player and opens when ready",()=>{
    const ready=new Set(["0,0"]);expect(canEnterTiles(124,0,ready)).toBe(true);expect(canEnterTiles(124.7,0,ready)).toBe(false);
    ready.add("1,0");expect(canEnterTiles(126,0,ready)).toBe(true);expect(canEnterTiles(500,0,ready)).toBe(false);
  });
  it("moves geographic searches south for positive local Z",()=>{
    const tile=tileCoordinates({...origin,x:1,z:1});expect(tile.latitude).toBeLessThan(origin.latitude);expect(tile.longitude).toBeGreaterThan(origin.longitude);
  });
});
