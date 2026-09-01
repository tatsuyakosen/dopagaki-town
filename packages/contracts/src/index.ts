import { z } from "zod";

export const Vec2Schema = z.object({
  x: z.number().finite(),
  z: z.number().finite(),
});

export const MovementSchema = Vec2Schema.extend({
  sprint: z.boolean().default(false),
});

export const MatchModeSchema = z.enum(["DEMO", "STANDARD"]);

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("JOIN"),
    playerName: z.string().trim().min(1).max(20).optional(),
    matchMode: MatchModeSchema.optional(),
    playerToken: z.string().min(32).max(128).optional(),
    lastAckedEventId: z.number().int().nonnegative().optional(),
    mapVersion: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("INPUT"),
    seq: z.number().int().nonnegative(),
    movement: MovementSchema,
  }),
  z.object({ type: z.literal("RESTART") }),
  z.object({ type: z.literal("PING"), sentAt: z.number().finite() }),
  z.object({
    type: z.literal("TRANSIT_RESERVE"),
    reservationId: z.string().min(1).max(128),
    departureId: z.string().min(1).max(128),
  }),
  z.object({
    type: z.literal("TRANSIT_CANCEL"),
    reservationId: z.string().min(1).max(128),
  }),
  z.object({
    type: z.literal("PATCH_APPLIED"),
    patchId: z.string().min(1),
    mapVersion: z.number().int().positive(),
    checksum: z.string().regex(/^[0-9a-f]{8}$/),
  }),
]);

export const RoleSchema = z.enum(["ONI", "RUNNER"]);
export const PlayerKindSchema = z.enum(["HUMAN", "BOT"]);
export const BotStrategySchema = z.enum(["CHASE", "CITY_CORE", "RAIL"]);

export const TransitPhaseSchema = z.enum(["ON_FOOT", "WAITING", "IN_TRANSIT", "ARRIVING"]);

export const TransitStationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  chunkId: z.string().min(1),
  position: Vec2Schema,
});

export const TransitRouteSchema = z.object({
  id: z.string().min(1),
  fromStationId: z.string().min(1),
  toStationId: z.string().min(1),
  durationMs: z.number().int().positive(),
  fareYen: z.number().int().positive(),
  transfers: z.number().int().nonnegative(),
});

export const TransitDepartureSchema = z.object({
  id: z.string().min(1),
  routeId: z.string().min(1),
  departureAtMs: z.number().int().nonnegative(),
  arrivalAtMs: z.number().int().positive(),
});

export const TransitGraphSchema = z.object({
  source: z.enum(["FIXTURE", "EXTERNAL"]),
  seed: z.number().int(),
  stations: z.array(TransitStationSchema).min(4).max(6),
  routes: z.array(TransitRouteSchema).min(1),
  timetable: z.array(TransitDepartureSchema).min(1),
}).superRefine((graph, context) => {
  const stationIds = new Set<string>();
  for (const [index, station] of graph.stations.entries()) {
    if (stationIds.has(station.id)) {
      context.addIssue({ code: "custom", path: ["stations", index, "id"], message: "Station IDs must be unique" });
    }
    stationIds.add(station.id);
  }

  const routesById = new Map<string, z.infer<typeof TransitRouteSchema>>();
  for (const [index, route] of graph.routes.entries()) {
    if (routesById.has(route.id)) {
      context.addIssue({ code: "custom", path: ["routes", index, "id"], message: "Route IDs must be unique" });
    }
    routesById.set(route.id, route);
    if (!stationIds.has(route.fromStationId)) {
      context.addIssue({ code: "custom", path: ["routes", index, "fromStationId"], message: "Unknown origin station" });
    }
    if (!stationIds.has(route.toStationId)) {
      context.addIssue({ code: "custom", path: ["routes", index, "toStationId"], message: "Unknown destination station" });
    }
    if (route.fromStationId === route.toStationId) {
      context.addIssue({ code: "custom", path: ["routes", index], message: "A route must connect different stations" });
    }
  }

  const departureIds = new Set<string>();
  for (const [index, departure] of graph.timetable.entries()) {
    if (departureIds.has(departure.id)) {
      context.addIssue({ code: "custom", path: ["timetable", index, "id"], message: "Departure IDs must be unique" });
    }
    departureIds.add(departure.id);
    const route = routesById.get(departure.routeId);
    if (route === undefined) {
      context.addIssue({ code: "custom", path: ["timetable", index, "routeId"], message: "Unknown route" });
    } else if (departure.arrivalAtMs - departure.departureAtMs !== route.durationMs) {
      context.addIssue({
        code: "custom",
        path: ["timetable", index, "arrivalAtMs"],
        message: "Arrival must match the route duration",
      });
    }
  }
});

export const TransitReservationSchema = z.object({
  reservationId: z.string().min(1).max(128),
  departureId: z.string().min(1).max(128),
  routeId: z.string().min(1),
  fromStationId: z.string().min(1),
  toStationId: z.string().min(1),
  fareYen: z.number().int().positive(),
  status: z.enum(["RESERVED", "COMMITTED"]),
  reservedAtMs: z.number().nonnegative(),
  departureAtMs: z.number().nonnegative(),
  arrivalAtMs: z.number().positive(),
});

export const PlayerTransitStateSchema = z.object({
  phase: TransitPhaseSchema,
  balanceYen: z.number().int().nonnegative(),
  reservedFareYen: z.number().int().nonnegative(),
  currentStationId: z.string().nullable(),
  reservation: TransitReservationSchema.nullable(),
  arrivalAtMs: z.number().nonnegative().nullable(),
});

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
  transit: PlayerTransitStateSchema,
});

export const ObstacleSchema = z.object({
  id: z.string(),
  kind: z.enum(["BUILDING", "BARRIER", "STATION", "ALLEY_GATE", "BRIDGE"]),
  x: z.number(),
  z: z.number(),
  width: z.number().positive(),
  depth: z.number().positive(),
  height: z.number().positive(),
  elevation: z.number().nonnegative().optional(),
  active: z.boolean(),
});

export const NavigationEdgeSchema = z.object({
  id: z.string().min(1),
  fromNodeId: z.string().min(1),
  toNodeId: z.string().min(1),
  kind: z.enum(["ALLEY", "BRIDGE"]),
  active: z.boolean(),
});

const RaiseBarrierOperationSchema = z.object({
  type: z.literal("raise_barrier"),
  anchorId: z.string().min(1),
  obstacle: ObstacleSchema.extend({ kind: z.literal("BARRIER") }),
});

const OpenAlleyOperationSchema = z.object({
  type: z.literal("open_alley"),
  anchorId: z.string().min(1),
  gateId: z.string().min(1),
  obstacle: ObstacleSchema.extend({ kind: z.literal("ALLEY_GATE") }),
  edge: NavigationEdgeSchema.extend({ kind: z.literal("ALLEY") }),
});

const SpawnRooftopBridgeOperationSchema = z.object({
  type: z.literal("spawn_rooftop_bridge"),
  anchorId: z.string().min(1),
  bridgeId: z.string().min(1),
  obstacle: ObstacleSchema.extend({ kind: z.literal("BRIDGE") }),
  edge: NavigationEdgeSchema.extend({ kind: z.literal("BRIDGE") }),
});

export const MapPatchOperationSchema = z.discriminatedUnion("type", [
  RaiseBarrierOperationSchema,
  OpenAlleyOperationSchema,
  SpawnRooftopBridgeOperationSchema,
]);

export const StageSpecSchema = z.object({
  seed: z.number().int(),
  theme: z.string().min(1),
  stations: z.array(z.string()).min(4).max(6),
  spawnZones: z.array(z.string()).length(4),
  initialOni: z.string().min(1),
  routes: z.array(z.enum(["street", "alley", "rooftop"])).min(2),
  mutationAnchors: z.array(z.string()).min(3),
  cityCoreSpawn: z.string().min(1),
});

export const MapPatchSchema = z.object({
  patchId: z.string().min(1),
  baseMapVersion: z.number().int().positive(),
  reason: z.string().min(1),
  targetZone: z.string().min(1),
  target: Vec2Schema,
  targetPlayerId: z.string().nullable(),
  warningSec: z.number().min(5).max(15),
  operations: z.array(MapPatchOperationSchema).min(1).max(2),
  expectedEffect: z.object({
    encounterRatePct: z.number().min(-100).max(100),
    routeDiversityPct: z.number().min(-100).max(100),
  }),
});

export const DirectorPlayerObservationSchema = z.object({
  id: z.string().min(1),
  kind: PlayerKindSchema,
  strategy: BotStrategySchema.nullable(),
  role: RoleSchema,
  position: Vec2Schema,
  velocity: Vec2Schema,
  oniDurationMs: z.number().nonnegative(),
  protectedUntilMs: z.number().nonnegative(),
  transitPhase: TransitPhaseSchema,
});

export const DirectorStationObservationSchema = TransitStationSchema.omit({ name: true });

export const DirectorMutationAnchorSchema = z.object({
  id: z.string().min(1),
  chunkIds: z.array(z.string().min(1)).min(1),
  position: Vec2Schema,
  width: z.number().positive(),
  depth: z.number().positive(),
  height: z.number().positive(),
});

export const DirectorObservationSchema = z.object({
  requestId: z.string().min(1),
  matchId: z.string().min(1),
  seed: z.number().int(),
  sequence: z.number().int().nonnegative(),
  observedAtMs: z.number().nonnegative(),
  mapVersion: z.number().int().positive(),
  mapChecksum: z.string().regex(/^[0-9a-f]{8}$/),
  stageSpec: StageSpecSchema,
  world: WorldSpecSchema,
  players: z.array(DirectorPlayerObservationSchema).length(4),
  stations: z.array(DirectorStationObservationSchema).min(4).max(6),
  mutationAnchors: z.array(DirectorMutationAnchorSchema).min(3),
  obstacles: z.array(ObstacleSchema),
  navigationEdges: z.array(NavigationEdgeSchema),
  appliedPatchIds: z.array(z.string().min(1)),
  lastTargetPlayerId: z.string().nullable(),
});

export const DirectorResponseSchema = z.object({
  requestId: z.string().min(1),
  stageSpec: StageSpecSchema,
  candidates: z.array(MapPatchSchema).min(1).max(3),
});

export const ConstraintIdSchema = z.enum([
  "F-01",
  "F-02",
  "F-03",
  "F-04",
  "F-05",
  "F-06",
  "F-07",
  "F-08",
  "VERSION",
  "DUPLICATE",
  "SCHEMA",
]);

export const ConstraintViolationSchema = z.object({
  id: ConstraintIdSchema,
  message: z.string().min(1),
});

export const PatchEvaluationSchema = z.object({
  patch: MapPatchSchema,
  accepted: z.boolean(),
  violations: z.array(ConstraintViolationSchema),
  routeCountByPlayer: z.record(z.string(), z.number().int().nonnegative()),
  rolloutScore: z.number().finite(),
  latencyMs: z.number().nonnegative(),
  estimatedCostYen: z.number().nonnegative(),
});

export const AIReplayEntrySchema = z.object({
  sequence: z.number().int().nonnegative(),
  atMs: z.number().nonnegative(),
  phase: z.enum([
    "STAGE_GENERATED",
    "CANDIDATES_EVALUATED",
    "PATCH_COMMITTED",
    "ROLLBACK",
    "TAG_CHANGED",
    "TRANSIT_RESERVED",
    "TRANSIT_REJECTED",
    "TRANSIT_BOARDED",
    "TRANSIT_ARRIVED",
    "TRANSIT_CANCELLED",
  ]),
  patchId: z.string().nullable(),
  selectedPatchId: z.string().nullable(),
  summary: z.string(),
  candidates: z.array(PatchEvaluationSchema),
  latencyMs: z.number().nonnegative(),
  estimatedCostYen: z.number().nonnegative(),
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
  activePatch: MapPatchSchema.nullable(),
  lastAppliedPatchId: z.string().nullable(),
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
  stageSpec: StageSpecSchema,
  navigationEdges: z.array(NavigationEdgeSchema),
  mapChecksum: z.string().regex(/^[0-9a-f]{8}$/),
  rollbackCount: z.number().int().nonnegative(),
  aiReplay: z.array(AIReplayEntrySchema),
  transitGraph: TransitGraphSchema,
  players: z.array(PlayerSnapshotSchema).length(4),
  obstacles: z.array(ObstacleSchema),
  cityCore: CityCoreSchema,
});

export const NetworkMatchSnapshotSchema = MatchSnapshotSchema.omit({ transitGraph: true });

export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("WELCOME"),
    playerId: z.string(),
    matchId: z.string(),
    playerToken: z.string().min(32).max(128),
    resumed: z.boolean(),
    lastInputSeq: z.number().int().nonnegative(),
    lastEventId: z.number().int().nonnegative(),
    mapVersion: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("ROOM_CONFIG"),
    matchId: z.string(),
    matchMode: MatchModeSchema,
    durationMs: z.number().int().positive(),
    seed: z.number().int(),
    transitGraph: TransitGraphSchema,
  }),
  z.object({
    type: z.literal("SNAPSHOT"),
    snapshot: NetworkMatchSnapshotSchema,
  }),
  z.object({
    type: z.literal("ERROR"),
    code: z.enum(["ROOM_FULL", "SESSION_EXPIRED", "INVALID_SESSION", "BAD_MESSAGE", "TRANSIT_REJECTED"]).optional(),
    message: z.string(),
  }),
  z.object({
    type: z.literal("PONG"),
    sentAt: z.number().finite(),
  }),
]);

export type Vec2 = z.infer<typeof Vec2Schema>;
export type Movement = z.infer<typeof MovementSchema>;
export type MatchMode = z.infer<typeof MatchModeSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type Role = z.infer<typeof RoleSchema>;
export type PlayerKind = z.infer<typeof PlayerKindSchema>;
export type BotStrategy = z.infer<typeof BotStrategySchema>;
export type TransitPhase = z.infer<typeof TransitPhaseSchema>;
export type TransitStation = z.infer<typeof TransitStationSchema>;
export type TransitRoute = z.infer<typeof TransitRouteSchema>;
export type TransitDeparture = z.infer<typeof TransitDepartureSchema>;
export type TransitGraph = z.infer<typeof TransitGraphSchema>;
export type TransitReservation = z.infer<typeof TransitReservationSchema>;
export type PlayerTransitState = z.infer<typeof PlayerTransitStateSchema>;
export type WorldSpec = z.infer<typeof WorldSpecSchema>;
export type PlayerSnapshot = z.infer<typeof PlayerSnapshotSchema>;
export type Obstacle = z.infer<typeof ObstacleSchema>;
export type NavigationEdge = z.infer<typeof NavigationEdgeSchema>;
export type MapPatchOperation = z.infer<typeof MapPatchOperationSchema>;
export type StageSpec = z.infer<typeof StageSpecSchema>;
export type MapPatch = z.infer<typeof MapPatchSchema>;
export type DirectorPlayerObservation = z.infer<typeof DirectorPlayerObservationSchema>;
export type DirectorStationObservation = z.infer<typeof DirectorStationObservationSchema>;
export type DirectorMutationAnchor = z.infer<typeof DirectorMutationAnchorSchema>;
export type DirectorObservation = z.infer<typeof DirectorObservationSchema>;
export type DirectorResponse = z.infer<typeof DirectorResponseSchema>;
export type ConstraintId = z.infer<typeof ConstraintIdSchema>;
export type ConstraintViolation = z.infer<typeof ConstraintViolationSchema>;
export type PatchEvaluation = z.infer<typeof PatchEvaluationSchema>;
export type AIReplayEntry = z.infer<typeof AIReplayEntrySchema>;
export type CityCore = z.infer<typeof CityCoreSchema>;
export type MatchStatus = z.infer<typeof MatchStatusSchema>;
export type MatchSnapshot = z.infer<typeof MatchSnapshotSchema>;
export type NetworkMatchSnapshot = z.infer<typeof NetworkMatchSnapshotSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}
