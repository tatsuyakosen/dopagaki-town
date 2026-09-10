import { describe, expect, it } from "vitest";
import { CityManifestSchema } from "../../packages/contracts/src/city.js";
import { createFixture } from "../../apps/game-client/src/walk/fixture.js";
import { movementVector, frameSeconds, movementSteps } from "../../apps/game-client/src/walk/movement.js";
import { inspectPublishFile } from "../../scripts/repository-safety.js";

describe("city data integrity",()=>{
  it("labels synthetic geometry explicitly",()=>{expect(CityManifestSchema.parse(createFixture()).mode).toBe("fixture");});
  it("rejects real-city claims without source provenance",()=>{expect(CityManifestSchema.safeParse({...createFixture(),mode:"survey"}).success).toBe(false);});
  it("rejects missing terrain rather than inventing ground",()=>{const data=createFixture();data.meshes=data.meshes.filter(m=>m.kind==="building");expect(CityManifestSchema.safeParse(data).success).toBe(false);});
  it("rejects invalid indices and NaN",()=>{const data=createFixture();data.meshes[0]!.indices[0]=999999;expect(CityManifestSchema.safeParse(data).success).toBe(false);data.meshes[0]!.positions[0]=NaN;expect(CityManifestSchema.safeParse(data).success).toBe(false);});
  it("rejects arbitrary extra metadata and duplicate mesh identities",()=>{const data=createFixture();data.meshes.push(data.meshes[0]!);expect(CityManifestSchema.safeParse(data).success).toBe(false);expect(CityManifestSchema.safeParse({...createFixture(),apiKey:"not-allowed"}).success).toBe(false);});
  it("rejects signed source URLs",()=>{const data=createFixture();data.sources=[{title:"Test",provider:"Test",datasetYear:2020,surveyYear:null,url:"https://example.com/?token=private",license:"Test",licenseUrl:"https://example.com/license",attribution:"Test",retrievedAt:"2026-09-07",sha256:"a".repeat(64)}];expect(CityManifestSchema.safeParse(data).success).toBe(false);});
});
describe("walking controls",()=>{
  it("has no diagonal speed advantage",()=>{const move=movementVector(new Set(["KeyW","KeyD"]),0);expect(Math.hypot(move.x,move.z)).toBeCloseTo(1);});
  it("moves relative to camera yaw",()=>{const move=movementVector(new Set(["KeyW"]),Math.PI/2);expect(move.x).toBeCloseTo(1);expect(move.z).toBeCloseTo(0);});
  it("supports both shift keys",()=>{expect(movementVector(new Set(["ShiftRight"]),0).speed).toBeGreaterThan(movementVector(new Set(),0).speed);});
  it("clamps tab-resume deltas",()=>{expect(frameSeconds(10000)).toBe(.1);expect(frameSeconds(-1)).toBe(0);expect(frameSeconds(NaN)).toBe(0);});
  it("preserves running speed at 15, 20, 30 and 60 FPS with small collision steps",()=>{
    for(const fps of [15,20,30,60]){const steps=movementSteps(frameSeconds(1000/fps));expect(Math.max(...steps)).toBeLessThanOrEqual(1/60+1e-9);expect(steps.reduce((s,dt)=>s+dt*7,0)*fps).toBeCloseTo(7);}
  });
});
describe("publication guard",()=>{
  const bytes=(value:string)=>new TextEncoder().encode(value);
  it("rejects env, keys, raw data and oversized files",()=>{for(const path of [".env","apps/x/.env.local","auth.pem","data/raw/city.xml","apps/game-client/public/city-data/umeda-block.json"]){expect(inspectPublishFile(path,bytes("test"))).toContain("forbidden-file");}expect(inspectPublishFile("file.bin",new Uint8Array(1024*1024+1))).toContain("oversize-file");});
  it("detects credential patterns without embedding credentials in the tests",()=>{for(const token of ["AIza"+"A".repeat(35),"ghp_"+"a".repeat(36),"AKIA"+"A".repeat(16)])expect(inspectPublishFile("source.ts",bytes(token))).toContain("possible-secret");});
  it("allows a sanitized env template",()=>{expect(inspectPublishFile(".env.example",bytes("GEMINI_API_KEY=replace-with-a-secret-outside-version-control"))).toEqual([]);});
  it("rejects raw elevation tile rows outside the cache directory too",()=>{expect(inspectPublishFile("elevation.txt",bytes(Array<string>(256).fill("0.12").join(",")))).toContain("raw-elevation-data");});
  it("detects a literal secret assignment",()=>{expect(inspectPublishFile("source.ts",bytes('apiKey = "'+'1234567890abcdef'+'"'))).toContain("possible-secret-assignment");});
});
