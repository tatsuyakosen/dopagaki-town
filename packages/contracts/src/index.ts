import { z } from "zod";

export const Vec2Schema = z.object({
  x: z.number().finite(),
  z: z.number().finite(),
});

export const MovementSchema = Vec2Schema.extend({
  sprint: z.boolean().default(false),
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("JOIN"),
    playerName: z.string().trim().min(1).max(20).optional(),
  }),
  z.object({
    type: z.literal("INPUT"),
    seq: z.number().int().nonnegative(),
    movement: MovementSchema,
  }),
  z.object({ type: z.literal("RESTART") }),
  z.object({ type: z.literal("PING"), sentAt: z.number().finite() }),
]);

export const RoleSchema = z.enum(["ONI", "RUNNER"]);
export const PlayerKindSchema = z.enum(["HUMAN", "BOT"]);
export const BotStrategySchema = z.enum(["CHASE", "CITY_CORE", "RAIL"]);

export const WorldSpecSchema = z.object({
  sizeMeters: z.number().positive(),
  halfSize: z.number().positive(),
  chunksPerAxis: z.number().int().positive(),
  chunkSizeMeters: z.number().positive(),
  activeChunkRadius: z.number().int().nonnegative(),
  preloadChunkRadius: z.number().int().nonnegative(),
  roadOffsets: z.array(z.number()).min(3),
  roadWidth: z.number().positive(),
});

export const PlayerSnapshotSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  kind: PlayerKindSchema,
  strategy: BotStrategySchema.nullable(),
  role: RoleSchema,
  position: Vec2Schema,
  velocity: Vec2Schema,
  oniDurationMs: z.number().nonnegative(),
  protectedUntilMs: z.number().nonnegative(),
  connected: z.boolean(),
});

export const ObstacleSchema = z.object({
  id: z.string(),
  kind: z.enum(["BUILDING", "BARRIER", "STATION"]),
  x: z.number(),
  z: z.number(),
  width: z.number().positive(),
  depth: z.number().positive(),
  height: z.number().positive(),
  active: z.boolean(),
});

export const CityCoreSchema = z.object({
  position: Vec2Schema,
  target: Vec2Schema,
  warningStartedAtMs: z.number().nonnegative().nullable(),
  patchAppliesAtMs: z.number().nonnegative(),
  radius: z.number().positive(),
  patchIndex: z.number().int().nonnegative(),
  patchId: z.string(),
  patchPhase: z.enum(["IDLE", "PREPARED"]),
  affectedChunkIds: z.array(z.string()),
});

export const MatchStatusSchema = z.enum(["WAITING", "RUNNING", "FINISHED"]);

export const MatchSnapshotSchema = z.object({
  matchId: z.string(),
  seed: z.number().int(),
  world: WorldSpecSchema,
  status: MatchStatusSchema,
  nowMs: z.number().nonnegative(),
  startedAtMs: z.number().nonnegative().nullable(),
  endsAtMs: z.number().nonnegative().nullable(),
  remainingMs: z.number().nonnegative(),
  mapVersion: z.number().int().nonnegative(),
  lastEventId: z.number().int().nonnegative(),
  lastEventText: z.string(),
  winnerId: z.string().nullable(),
  tagLockedUntilMs: z.number().nonnegative(),
  players: z.array(PlayerSnapshotSchema).length(4),
  obstacles: z.array(ObstacleSchema),
  cityCore: CityCoreSchema,
});

export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("WELCOME"),
    playerId: z.string(),
    matchId: z.string(),
  }),
  z.object({
    type: z.literal("SNAPSHOT"),
    snapshot: MatchSnapshotSchema,
  }),
  z.object({
    type: z.literal("ERROR"),
    message: z.string(),
  }),
  z.object({
    type: z.literal("PONG"),
    sentAt: z.number().finite(),
  }),
]);

export type Vec2 = z.infer<typeof Vec2Schema>;
export type Movement = z.infer<typeof MovementSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type Role = z.infer<typeof RoleSchema>;
export type PlayerKind = z.infer<typeof PlayerKindSchema>;
export type BotStrategy = z.infer<typeof BotStrategySchema>;
export type WorldSpec = z.infer<typeof WorldSpecSchema>;
export type PlayerSnapshot = z.infer<typeof PlayerSnapshotSchema>;
export type Obstacle = z.infer<typeof ObstacleSchema>;
export type CityCore = z.infer<typeof CityCoreSchema>;
export type MatchStatus = z.infer<typeof MatchStatusSchema>;
export type MatchSnapshot = z.infer<typeof MatchSnapshotSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}
