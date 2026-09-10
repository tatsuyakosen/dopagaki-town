import { z } from "zod";

export const WalkStageSchema = z.union([z.literal("fixture"), z.string().regex(/^[a-f0-9]{24}$/)]);
export const WalkRoomIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
const coordinate = z.number().finite().min(-5000).max(5000);
export const WalkPoseSchema = z.object({
  x: coordinate, y: coordinate, z: coordinate,
  yaw: z.number().finite().min(-Math.PI).max(Math.PI),
  paused: z.boolean(),
}).strict();
const name = z.string().trim().min(1).max(20).regex(/^[^\p{Cc}\p{Cf}]+$/u);
export const WalkClientSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("CREATE"), stage: WalkStageSchema, name }).strict(),
  z.object({ type: z.literal("JOIN"), room: WalkRoomIdSchema, stage: WalkStageSchema, name,
    token: z.string().regex(/^[a-f0-9]{48}$/).optional() }).strict(),
  z.object({ type: z.literal("POSE"), seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), pose: WalkPoseSchema }).strict(),
  z.object({ type: z.literal("CHAT"), text: z.string().trim().min(1).max(140).regex(/^[^\p{Cc}\p{Cf}]+$/u) }).strict(),
  z.object({ type: z.literal("LEAVE") }).strict(),
]);
export type WalkClientMessage = z.infer<typeof WalkClientSchema>;
export type WalkPose = z.infer<typeof WalkPoseSchema>;
export type WalkPeer = { id: string; name: string; color: number; connected: boolean; pose: WalkPose };
export type WalkChat = { id: number; playerId: string; name: string; text: string };
export type WalkServerMessage =
  | { type: "WELCOME"; room: string; stage: string; playerId: string; token: string }
  | { type: "STATE"; peers: WalkPeer[]; chats: WalkChat[] }
  | { type: "ERROR"; code: string };
export const WALK_COLORS = ["#f1bf78", "#79cfdf", "#c3a3f4", "#a9d889"] as const;
