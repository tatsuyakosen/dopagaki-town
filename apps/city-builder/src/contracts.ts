import { z } from "zod";
import { AreaTileSchema } from "../../../packages/contracts/src/area.js";
import { FILE_LIMIT } from "./limits.js";

export const SelectionSchema = z.object({
  latitude: z.number().finite().min(20).max(46),
  longitude: z.number().finite().min(122).max(154),
}).strict();
export const BuildRequestSchema = z.object({catalogId:z.string().regex(/^[a-f0-9]{24}$/), quality:z.enum(["low","balanced"]),tile:AreaTileSchema.optional()}).strict();
export const DatasetSchema=z.object({cityCode:z.string().regex(/^\d{5}$/),city:z.string().max(100),year:z.number().int().min(2000).max(2100),
  metadataUrl:z.string().url(),metadataSha256:z.string().regex(/^[a-f0-9]{64}$/),fileUrls:z.array(z.string().url()).min(2).max(8)}).strict();
export const CatalogSchema = SelectionSchema.extend({
  city:z.string().max(100),year:z.number().int().min(2000).max(2100),license:z.literal("CC BY 4.0"),
  files:z.array(z.object({url:z.string().url(),bytes:z.number().int().nonnegative().max(FILE_LIMIT),kind:z.enum(["bldg","tran"])}).strict()).min(2).max(8),
  metadataUrl:z.string().url(),metadataSha256:z.string().regex(/^[a-f0-9]{64}$/),
  datasets:z.array(DatasetSchema).min(1).max(4).optional(),
}).strict();
export type Catalog = z.infer<typeof CatalogSchema>;
export type Quality = z.infer<typeof BuildRequestSchema>["quality"];
export const PlanSchema = z.object({lod:z.union([z.literal(1),z.literal(2)])}).strict();
export function validatePlan(raw:unknown, quality:Quality):z.infer<typeof PlanSchema> {
  const plan=PlanSchema.parse(raw);
  if(quality==="low" && plan.lod!==1)throw new Error("PLAN_BUDGET");
  return plan;
}
