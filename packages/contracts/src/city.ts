import { z } from "zod";

const number = z.number().finite();
const point = z.tuple([number, number, number]);
const publicUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
}, "Use a public HTTPS source URL without credentials or query parameters");

export const CityMeshSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(["building", "road", "terrain"]),
  positions: z.array(number).min(9).max(900_000),
  indices: z.array(z.number().int().nonnegative()).min(3).max(900_000),
}).strict().superRefine((mesh, ctx) => {
  if (mesh.positions.length % 3 || mesh.indices.length % 3 || mesh.indices.some((i) => i >= mesh.positions.length / 3)) {
    ctx.addIssue({ code: "custom", message: "Invalid triangle buffers" });
  }
});

export const CityManifestSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["survey", "fixture"]),
  title: z.string().min(1).max(160),
  coordinateSystem: z.literal("LOCAL_ENU_Y_UP_METERS"),
  origin: z.object({ latitude: number.min(-90).max(90), longitude: number.min(-180).max(180), altitude: number }).strict(),
  extentMeters: z.literal(1000),
  playableHalfSize: number.min(20).max(500),
  spawn: point,
  sources: z.array(z.object({
    title: z.string().min(1).max(300),
    provider: z.string().min(1).max(160),
    datasetYear: z.number().int().min(2000).max(2100),
    surveyYear: z.number().int().min(1900).max(2100).nullable(),
    url: publicUrl,
    license: z.string().min(1).max(200),
    licenseUrl: publicUrl,
    attribution: z.string().min(1).max(600),
    retrievedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).max(100),
  limitations: z.array(z.string().min(1).max(500)).min(1).max(30),
  meshes: z.array(CityMeshSchema).min(1).max(5000),
}).strict().superRefine((manifest, ctx) => {
  if (manifest.mode === "survey" && !manifest.sources.length) ctx.addIssue({ code: "custom", message: "Survey provenance required" });
  if (!manifest.meshes.some((mesh) => mesh.kind !== "building")) ctx.addIssue({ code: "custom", message: "Surveyed walkable surface required" });
  if (new Set(manifest.meshes.map((mesh) => mesh.id)).size !== manifest.meshes.length) ctx.addIssue({ code: "custom", message: "Duplicate mesh ID" });
  if (manifest.meshes.reduce((sum, mesh) => sum + mesh.positions.length, 0) > 1_500_000) ctx.addIssue({ code: "custom", message: "Block exceeds vertex budget" });
  if (Math.abs(manifest.spawn[0]) > manifest.playableHalfSize - 1 || Math.abs(manifest.spawn[2]) > manifest.playableHalfSize - 1) ctx.addIssue({ code: "custom", message: "Spawn is outside playable block" });
  if (manifest.meshes.some((mesh) => mesh.positions.some((value) => Math.abs(value) > 5000))) ctx.addIssue({ code: "custom", message: "Coordinates must be local meters" });
});

export type CityManifest = z.infer<typeof CityManifestSchema>;
export type CityMesh = z.infer<typeof CityMeshSchema>;
