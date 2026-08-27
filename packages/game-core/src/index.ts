import {
  MatchSnapshotSchema,
  type AIReplayEntry,
  type BotStrategy,
  type MapPatch,
  type MatchSnapshot,
  type Movement,
  type NavigationEdge,
  type Obstacle,
  type PatchEvaluation,
  type PlayerSnapshot,
  type TransitDeparture,
  type TransitRoute,
  type Vec2,
} from "@dopagaki/contracts";
import { createFixtureTransitGraph } from "@dopagaki/transit-core";
import {
  createFixturePatchCandidates,
  createFixtureStageSpec,
  evaluatePatch,
  selectPatchCandidate,
  type VerifierContext,
} from "@dopagaki/verifier";
import {
  DEFAULT_WORLD_SPEC,
  chunkAtPosition,
  chunkId,
  commitChunkPatch,
  computeMapChecksum,
  createCityObstacles,
  createRoadGraph,
  createWorldMetadata,
  distanceBetween,
  findRoadPath,
  nearestRoadNode,
  pointCollides,
  prepareChunkPatch,
  segmentIsClear,
  type PreparedChunkPatch,
  type RoadNode,
  type WorldMetadata,
} from "@dopagaki/world-core";

export const WORLD_HALF_SIZE = DEFAULT_WORLD_SPEC.halfSize;
export const PLAYER_RADIUS = 1.35;
export const TAG_DISTANCE = 3.2;
export const TAG_PROTECTION_MS = 3_000;
export const DEFAULT_MATCH_DURATION_MS = 10 * 60 * 1_000;
export const DEFAULT_PATCH_INTERVAL_MS = 20_000;
export const INITIAL_BALANCE_YEN = 1_000;
export const STATION_INTERACTION_RADIUS = 180;
export const ARRIVAL_PROTECTION_MS = 3_000;

const HUMAN_SPEED = 10.5;
const BOT_SPEED = 9.4;
const ROAD_GRAPH = createRoadGraph(DEFAULT_WORLD_SPEC);

export interface GameConfig {
  seed: number;
  durationMs?: number;
  patchIntervalMs?: number;
  humanSpeedMultiplier?: number;
}

export interface GameState extends MatchSnapshot {
  durationMs: number;
  patchIntervalMs: number;
  humanSpeedMultiplier: number;
  worldMetadata: WorldMetadata;
  worldObstacles: Obstacle[];
  staticObstaclesByChunk: Map<string, Obstacle[]>;
  botRouteCache: Map<string, { key: string; path: RoadNode[] }>;
  botGoalCache: Map<string, { expiresAtMs: number; goal: Vec2 }>;
  pendingPatches: PreparedChunkPatch[];
  appliedPatchIds: Set<string>;
  patchAcknowledgements: Map<string, Map<string, string>>;
  interventionSequence: number;
  lastTargetPlayerId: string | null;
  rollbackCheckpoint: RollbackCheckpoint | null;
  cityCoreTagCount: number;
  processedReservationIds: Set<string>;
}

export interface RollbackCheckpoint {
  patchId: string;
  mapVersion: number;
  mapChecksum: string;
  obstacles: Obstacle[];
  navigationEdges: NavigationEdge[];
  lastAppliedPatchId: string | null;
}

export interface GameCheckpoint {
  snapshot: MatchSnapshot;
  durationMs: number;
  patchIntervalMs: number;
  humanSpeedMultiplier: number;
  appliedPatchIds: string[];
  patchAcknowledgements: Array<[string, Array<[string, string]>]>;
  botGoalCache: Array<[string, { expiresAtMs: number; goal: Vec2 }]>;
  interventionSequence: number;
  lastTargetPlayerId: string | null;
  rollbackCheckpoint: RollbackCheckpoint | null;
  cityCoreTagCount: number;
  processedReservationIds: string[];
}

export type TransitActionCode =
  | "RESERVED"
  | "ALREADY_RESERVED"
  | "CANCELLED"
  | "PLAYER_NOT_FOUND"
  | "INVALID_DEPARTURE"
  | "DUPLICATE_RESERVATION"
  | "INVALID_STATE"
  | "NOT_AT_STATION"
  | "INSUFFICIENT_BALANCE"
  | "MISSED_DEPARTURE";

export interface TransitActionResult {
  accepted: boolean;
  code: TransitActionCode;
  message: string;
}

type Inputs = Readonly<Record<string, Movement | undefined>>;

class SeededRandom {
  private value: number;

  constructor(seed: number) {
    this.value = seed >>> 0 || 1;
  }

  next(): number {
    let value = this.value;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.value = value >>> 0;
    return this.value / 0x1_0000_0000;
  }
}

const BARRIER_ANCHORS: ReadonlyArray<Obstacle> = [
  {
    id: "barrier-0",
    kind: "BARRIER",
    x: -50,
    z: 0,
    width: 3,
    depth: 22,
    height: 7,
    active: false,
  },
  {
    id: "barrier-1",
    kind: "BARRIER",
    x: 50,
    z: 0,
    width: 3,
    depth: 22,
    height: 7,
    active: false,
  },
  {
    id: "barrier-2",
    kind: "BARRIER",
    x: 0,
    z: -50,
    width: 22,
    depth: 3,
    height: 7,
    active: false,
  },
  {
    id: "barrier-3",
    kind: "BARRIER",
    x: 0,
    z: 50,
    width: 22,
    depth: 3,
    height: 7,
    active: false,
  },
];

const ALLEY_GATE_ANCHORS: ReadonlyArray<Obstacle> = [
  {
    id: "alley-gate-core",
    kind: "ALLEY_GATE",
    x: 125,
    z: 75,
    width: 10,
    depth: 3,
    height: 4,
    active: true,
  },
];

function spawnPlayer(
  id: string,
  displayName: string,
  position: Vec2,
  role: "ONI" | "RUNNER",
  strategy: BotStrategy,
): PlayerSnapshot {
  return {
    id,
    displayName,
    kind: "BOT",
    strategy,
    role,
    position: { ...position },
    velocity: { x: 0, z: 0 },
    oniDurationMs: 0,
    protectedUntilMs: 0,
    connected: true,
    transit: {
      phase: "ON_FOOT",
      balanceYen: INITIAL_BALANCE_YEN,
      reservedFareYen: 0,
      currentStationId: null,
      reservation: null,
      arrivalAtMs: null,
    },
  };
}

export function createGame(config: GameConfig): GameState {
  const random = new SeededRandom(config.seed);
  const worldMetadata = createWorldMetadata(DEFAULT_WORLD_SPEC, config.seed);
  const worldObstacles = createCityObstacles(DEFAULT_WORLD_SPEC, config.seed);
  const staticObstaclesByChunk = new Map<string, Obstacle[]>();
  for (const obstacle of worldObstacles) {
    const id = chunkId(chunkAtPosition(DEFAULT_WORLD_SPEC, obstacle));
    const chunkObstacles = staticObstaclesByChunk.get(id) ?? [];
    chunkObstacles.push(obstacle);
    staticObstaclesByChunk.set(id, chunkObstacles);
  }
  const oniIndex = Math.floor(random.next() * 4);
  const spawns: Vec2[] = [
    { x: -34, z: 0 },
    { x: 34, z: 0 },
    { x: 0, z: -34 },
    { x: 0, z: 34 },
  ];
  const strategies: BotStrategy[] = ["CHASE", "CITY_CORE", "RAIL", "CHASE"];
  const players = spawns.map((spawn, index) =>
    spawnPlayer(
      `bot-${index + 1}`,
      `Rival ${index + 1}`,
      spawn,
      index === oniIndex ? "ONI" : "RUNNER",
      strategies[index] ?? "CHASE",
    ),
  );
  const firstBarrierIndex = Math.floor(random.next() * BARRIER_ANCHORS.length);
  const firstTarget = BARRIER_ANCHORS[firstBarrierIndex] ?? BARRIER_ANCHORS[0];
  if (firstTarget === undefined) {
    throw new Error("CITY CORE requires at least one mutation anchor");
  }
  const patchIntervalMs = Math.max(6_000, config.patchIntervalMs ?? DEFAULT_PATCH_INTERVAL_MS);
  const durationMs = config.durationMs ?? DEFAULT_MATCH_DURATION_MS;
  const transitGraph = createFixtureTransitGraph(config.seed, worldMetadata.stations, durationMs);
  const dynamicObstacles = [
    ...BARRIER_ANCHORS.map((barrier) => ({ ...barrier })),
    ...ALLEY_GATE_ANCHORS.map((gate) => ({ ...gate })),
  ];
  const navigationEdges: NavigationEdge[] = [];
  const mapChecksum = computeMapChecksum(1, dynamicObstacles, navigationEdges);
  const stageSpec = createFixtureStageSpec(config.seed, worldMetadata, players, DEFAULT_WORLD_SPEC);
  const aiReplay: AIReplayEntry[] = [{
    sequence: 0,
    atMs: 0,
    phase: "STAGE_GENERATED",
    patchId: null,
    selectedPatchId: null,
    summary: `Fixture StageSpec: ${stageSpec.theme}`,
    candidates: [],
    latencyMs: 2,
    estimatedCostYen: 0,
  }];

  return {
    matchId: `local-${config.seed}`,
    seed: config.seed,
    world: {
      ...DEFAULT_WORLD_SPEC,
      roadOffsets: [...DEFAULT_WORLD_SPEC.roadOffsets],
    },
    status: "WAITING",
    nowMs: 0,
    startedAtMs: null,
    endsAtMs: null,
    remainingMs: durationMs,
    mapVersion: 1,
    lastEventId: 0,
    lastEventText: "入場者を待っています",
    winnerId: null,
    tagLockedUntilMs: 0,
    stageSpec,
    navigationEdges,
    mapChecksum,
    rollbackCount: 0,
    aiReplay,
    transitGraph,
    players,
    obstacles: dynamicObstacles,
    cityCore: {
      position: { x: 0, z: 0 },
      target: { x: firstTarget.x, z: firstTarget.z },
      warningStartedAtMs: null,
      patchAppliesAtMs: patchIntervalMs,
      radius: 250,
      patchIndex: firstBarrierIndex,
      patchId: "patch-1-valid",
      patchPhase: "IDLE",
      affectedChunkIds: [],
      activePatch: null,
      lastAppliedPatchId: null,
    },
    durationMs,
    patchIntervalMs,
    humanSpeedMultiplier: config.humanSpeedMultiplier ?? 1,
    worldMetadata,
    worldObstacles,
    staticObstaclesByChunk,
    botRouteCache: new Map(),
    botGoalCache: new Map(),
    pendingPatches: [],
    appliedPatchIds: new Set(),
    patchAcknowledgements: new Map(),
    interventionSequence: 0,
    lastTargetPlayerId: null,
    rollbackCheckpoint: null,
    cityCoreTagCount: 0,
    processedReservationIds: new Set(),
  };
}

export function startGame(state: GameState): void {
  if (state.status !== "WAITING") return;
  state.status = "RUNNING";
  state.startedAtMs = state.nowMs;
  state.endsAtMs = state.nowMs + state.durationMs;
  state.remainingMs = state.durationMs;
  state.lastEventId += 1;
  state.lastEventText = "CITY TAG 開始";
}

export function replaceBotWithHuman(
  state: GameState,
  playerId: string,
  displayName: string,
): PlayerSnapshot {
  const runner = [...state.players].reverse().find((player) => player.kind === "BOT" && player.role === "RUNNER");
  const candidate = runner ?? state.players.find((player) => player.kind === "BOT");
  if (candidate === undefined) {
    throw new Error("This room already has four human players");
  }
  candidate.id = playerId;
  candidate.displayName = displayName;
  candidate.kind = "HUMAN";
  candidate.strategy = null;
  candidate.connected = true;
  state.lastEventId += 1;
  state.lastEventText = `${displayName} が入場しました`;
  return candidate;
}

export function markHumanDisconnected(state: GameState, playerId: string): void {
  const player = state.players.find((item) => item.id === playerId);
  if (player === undefined || player.kind !== "HUMAN" || !player.connected) return;
  player.connected = false;
  player.velocity = { x: 0, z: 0 };
  state.lastEventId += 1;
  state.lastEventText = `${player.displayName} の再接続を待っています`;
}

export function restoreHumanControl(
  state: GameState,
  playerId: string,
  displayName: string,
): PlayerSnapshot | null {
  const player = state.players.find((item) => item.id === playerId);
  if (player === undefined) return null;
  player.kind = "HUMAN";
  player.strategy = null;
  player.connected = true;
  player.displayName = displayName;
  player.velocity = { x: 0, z: 0 };
  state.lastEventId += 1;
  state.lastEventText = `${displayName} が再接続しました`;
  return player;
}

export function letBotTakeOver(state: GameState, playerId: string): void {
  const player = state.players.find((item) => item.id === playerId);
  if (player === undefined || player.kind === "BOT") return;
  player.kind = "BOT";
  player.strategy = player.role === "ONI" ? "CHASE" : "CITY_CORE";
  player.connected = false;
  if (!player.displayName.endsWith(" (Bot)")) player.displayName = `${player.displayName} (Bot)`;
  state.lastEventId += 1;
  state.lastEventText = `${player.displayName} をBotが引き継ぎました`;
}

function length(vector: Vec2): number {
  return Math.hypot(vector.x, vector.z);
}

function normalized(vector: Vec2): Vec2 {
  const magnitude = length(vector);
  if (magnitude < 0.0001) return { x: 0, z: 0 };
  return { x: vector.x / magnitude, z: vector.z / magnitude };
}

function subtract(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, z: a.z - b.z };
}

function distance(a: Vec2, b: Vec2): number {
  return length(subtract(a, b));
}

function nearestPlayer(player: PlayerSnapshot, candidates: PlayerSnapshot[]): PlayerSnapshot | undefined {
  return candidates.reduce<PlayerSnapshot | undefined>((nearest, candidate) => {
    if (nearest === undefined) return candidate;
    return distance(player.position, candidate.position) < distance(player.position, nearest.position)
      ? candidate
      : nearest;
  }, undefined);
}

function directionToRoadGoal(state: GameState, player: PlayerSnapshot, goal: Vec2): Vec2 {
  const directDistance = distance(player.position, goal);
  if (
    directDistance <= 28 &&
    segmentIsClear(state.obstacles, player.position, goal, PLAYER_RADIUS)
  ) {
    return normalized(subtract(goal, player.position));
  }

  const startNode = nearestRoadNode(ROAD_GRAPH, player.position);
  const goalNode = nearestRoadNode(ROAD_GRAPH, goal);
  const routeKey = `${startNode.id}>${goalNode.id}@${state.mapVersion}`;
  const cachedRoute = state.botRouteCache.get(player.id);
  const path = cachedRoute?.key === routeKey
    ? cachedRoute.path
    : findRoadPath(ROAD_GRAPH, startNode.id, goalNode.id, state.obstacles, state.navigationEdges);
  if (cachedRoute?.key !== routeKey) state.botRouteCache.set(player.id, { key: routeKey, path });
  let waypoint: RoadNode | undefined;
  if (distanceBetween(player.position, startNode.position) > 3) waypoint = startNode;
  else waypoint = path[1] ?? path[0];

  if (waypoint === undefined) return normalized(subtract(goal, player.position));
  if (waypoint.id === goalNode.id && directDistance <= 38) {
    return normalized(subtract(goal, player.position));
  }
  return normalized(subtract(waypoint.position, player.position));
}

function runnerRoadGoal(state: GameState, player: PlayerSnapshot, oni: PlayerSnapshot): Vec2 {
  if (player.strategy === "CITY_CORE" && state.cityCore.warningStartedAtMs !== null) {
    return state.cityCore.target;
  }
  if (player.strategy === "RAIL") {
    const reservation = player.transit.reservation;
    const station = reservation === null
      ? nearestTransitStation(state, player.position)
      : stationById(state, reservation.fromStationId);
    return station?.position ?? player.position;
  }

  const idBias = [...player.id].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 7;
  const best = ROAD_GRAPH.nodes.reduce<RoadNode | undefined>((current, node, index) => {
    const score =
      distanceBetween(node.position, oni.position) -
      distanceBetween(node.position, player.position) * 0.16 +
      ((index + idBias) % 7) * 0.01;
    if (current === undefined) return node;
    const currentScore =
      distanceBetween(current.position, oni.position) -
      distanceBetween(current.position, player.position) * 0.16;
    return score > currentScore ? node : current;
  }, undefined);
  return best?.position ?? player.position;
}

function botMovement(state: GameState, player: PlayerSnapshot): Movement {
  if (player.transit.phase === "WAITING" && player.transit.reservation !== null) {
    const station = stationById(state, player.transit.reservation.fromStationId);
    const direction = station === undefined
      ? { x: 0, z: 0 }
      : directionToRoadGoal(state, player, station.position);
    return { ...direction, sprint: false };
  }
  const oni = state.players.find((candidate) => candidate.role === "ONI");
  if (oni === undefined) return { x: 0, z: 0, sprint: false };

  if (player.role === "ONI") {
    const target = nearestPlayer(
      player,
      state.players.filter((candidate) => candidate.role === "RUNNER"),
    );
    const direction = target === undefined
      ? { x: 0, z: 0 }
      : directionToRoadGoal(state, player, target.position);
    return { ...direction, sprint: false };
  }

  const cachedGoal = state.botGoalCache.get(player.id);
  const goal = cachedGoal !== undefined && cachedGoal.expiresAtMs > state.nowMs
    ? cachedGoal.goal
    : runnerRoadGoal(state, player, oni);
  if (cachedGoal === undefined || cachedGoal.expiresAtMs <= state.nowMs) {
    state.botGoalCache.set(player.id, {
      expiresAtMs: state.nowMs + 5_000,
      goal: { ...goal },
    });
  }
  return { ...directionToRoadGoal(state, player, goal), sprint: false };
}

function collides(state: GameState, x: number, z: number): boolean {
  const position = { x, z };
  const localChunkId = chunkId(chunkAtPosition(state.world, position));
  const staticObstacles = state.staticObstaclesByChunk.get(localChunkId) ?? [];
  return (
    pointCollides(staticObstacles, position, PLAYER_RADIUS) ||
    pointCollides(state.obstacles, position, PLAYER_RADIUS)
  );
}

function movePlayer(state: GameState, player: PlayerSnapshot, movement: Movement, deltaMs: number): void {
  if (player.transit.phase === "IN_TRANSIT" || player.transit.phase === "ARRIVING") {
    player.velocity = { x: 0, z: 0 };
    return;
  }
  const direction = normalized(movement);
  const baseSpeed = player.kind === "HUMAN" ? HUMAN_SPEED : BOT_SPEED;
  const humanMultiplier = player.kind === "HUMAN" ? state.humanSpeedMultiplier : 1;
  const speed = baseSpeed * humanMultiplier * (movement.sprint && player.kind === "HUMAN" ? 1.12 : 1);
  const seconds = deltaMs / 1_000;
  const dx = direction.x * speed * seconds;
  const dz = direction.z * speed * seconds;
  const worldLimit = state.world.halfSize - PLAYER_RADIUS;
  const nextX = Math.max(-worldLimit, Math.min(worldLimit, player.position.x + dx));
  const nextZ = Math.max(-worldLimit, Math.min(worldLimit, player.position.z + dz));

  let appliedX = player.position.x;
  let appliedZ = player.position.z;
  if (!collides(state, nextX, player.position.z)) appliedX = nextX;
  if (!collides(state, appliedX, nextZ)) appliedZ = nextZ;

  const hasReachableDisplacement = nextX !== player.position.x || nextZ !== player.position.z;
  if (appliedX === player.position.x && appliedZ === player.position.z && hasReachableDisplacement) {
    const sidestepX = Math.max(-worldLimit, Math.min(worldLimit, player.position.x - dz));
    const sidestepZ = Math.max(-worldLimit, Math.min(worldLimit, player.position.z + dx));
    if (!collides(state, sidestepX, player.position.z)) appliedX = sidestepX;
    if (!collides(state, appliedX, sidestepZ)) appliedZ = sidestepZ;
  }

  player.velocity = {
    x: (appliedX - player.position.x) / Math.max(seconds, 0.001),
    z: (appliedZ - player.position.z) / Math.max(seconds, 0.001),
  };
  player.position = { x: appliedX, z: appliedZ };
}

function verifierContext(state: GameState): VerifierContext {
  return {
    world: state.world,
    metadata: state.worldMetadata,
    players: state.players,
    obstacles: state.obstacles,
    navigationEdges: state.navigationEdges,
    currentMapVersion: state.mapVersion,
    appliedPatchIds: state.appliedPatchIds,
    lastTargetPlayerId: state.lastTargetPlayerId,
  };
}

export function evaluatePatchForGame(state: GameState, patch: MapPatch): PatchEvaluation {
  return evaluatePatch(patch, verifierContext(state));
}

function appendReplay(
  state: GameState,
  entry: Omit<AIReplayEntry, "sequence" | "atMs">,
): void {
  state.aiReplay.push({
    ...entry,
    sequence: state.aiReplay.length,
    atMs: state.nowMs,
  });
}

function routeForDeparture(
  state: GameState,
  departure: TransitDeparture,
): TransitRoute | undefined {
  return state.transitGraph.routes.find((route) => route.id === departure.routeId);
}

function stationById(state: GameState, stationId: string): GameState["transitGraph"]["stations"][number] | undefined {
  return state.transitGraph.stations.find((station) => station.id === stationId);
}

function nearestTransitStation(state: GameState, position: Vec2) {
  return state.transitGraph.stations.reduce<GameState["transitGraph"]["stations"][number] | undefined>(
    (nearest, station) => {
      if (nearest === undefined) return station;
      return distance(position, station.position) < distance(position, nearest.position) ? station : nearest;
    },
    undefined,
  );
}

function recordTransitReplay(
  state: GameState,
  phase: Extract<AIReplayEntry["phase"], `TRANSIT_${string}`>,
  summary: string,
): void {
  appendReplay(state, {
    phase,
    patchId: null,
    selectedPatchId: null,
    summary,
    candidates: [],
    latencyMs: 0,
    estimatedCostYen: 0,
  });
}

function rejectTransit(
  state: GameState,
  player: PlayerSnapshot | undefined,
  reservationId: string,
  code: Exclude<TransitActionCode, "RESERVED" | "ALREADY_RESERVED" | "CANCELLED">,
  message: string,
): TransitActionResult {
  if (player !== undefined) state.processedReservationIds.add(reservationId);
  recordTransitReplay(state, "TRANSIT_REJECTED", `${player?.displayName ?? "Unknown"}: ${message}`);
  return { accepted: false, code, message };
}

export function reserveTransit(
  state: GameState,
  playerId: string,
  reservationId: string,
  departureId: string,
): TransitActionResult {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (player === undefined) {
    return rejectTransit(state, player, reservationId, "PLAYER_NOT_FOUND", "プレイヤーが見つかりません");
  }
  const active = player.transit.reservation;
  if (
    active?.reservationId === reservationId &&
    active.departureId === departureId &&
    player.transit.phase === "WAITING"
  ) {
    return { accepted: true, code: "ALREADY_RESERVED", message: "予約済みです" };
  }
  if (state.processedReservationIds.has(reservationId) || active !== null) {
    return rejectTransit(state, player, reservationId, "DUPLICATE_RESERVATION", "予約IDは使用済みです");
  }
  if (player.transit.phase !== "ON_FOOT") {
    return rejectTransit(state, player, reservationId, "INVALID_STATE", "現在の交通状態では予約できません");
  }

  const departure = state.transitGraph.timetable.find((candidate) => candidate.id === departureId);
  const route = departure === undefined ? undefined : routeForDeparture(state, departure);
  if (departure === undefined || route === undefined) {
    return rejectTransit(state, player, reservationId, "INVALID_DEPARTURE", "便が見つかりません");
  }
  if (departure.departureAtMs <= state.nowMs) {
    return rejectTransit(state, player, reservationId, "MISSED_DEPARTURE", "この便は発車済みです");
  }
  const station = stationById(state, route.fromStationId);
  if (station === undefined || distance(player.position, station.position) > STATION_INTERACTION_RADIUS) {
    return rejectTransit(state, player, reservationId, "NOT_AT_STATION", "出発駅の近くで予約してください");
  }
  if (player.transit.balanceYen - player.transit.reservedFareYen < route.fareYen) {
    return rejectTransit(state, player, reservationId, "INSUFFICIENT_BALANCE", "残高が不足しています");
  }

  player.transit.phase = "WAITING";
  player.transit.currentStationId = station.id;
  player.transit.reservedFareYen = route.fareYen;
  player.transit.reservation = {
    reservationId,
    departureId,
    routeId: route.id,
    fromStationId: route.fromStationId,
    toStationId: route.toStationId,
    fareYen: route.fareYen,
    status: "RESERVED",
    reservedAtMs: state.nowMs,
    departureAtMs: departure.departureAtMs,
    arrivalAtMs: departure.arrivalAtMs,
  };
  state.botGoalCache.delete(player.id);
  state.lastEventId += 1;
  state.lastEventText = `${player.displayName} が${station.name}発を予約`;
  recordTransitReplay(state, "TRANSIT_RESERVED", `${player.displayName}: ${route.id} / ¥${route.fareYen}`);
  return { accepted: true, code: "RESERVED", message: "予約しました" };
}

export function cancelTransit(
  state: GameState,
  playerId: string,
  reservationId: string,
): TransitActionResult {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (player === undefined) {
    return rejectTransit(state, player, reservationId, "PLAYER_NOT_FOUND", "プレイヤーが見つかりません");
  }
  const reservation = player.transit.reservation;
  if (
    reservation === null ||
    reservation.reservationId !== reservationId ||
    reservation.status !== "RESERVED" ||
    player.transit.phase !== "WAITING"
  ) {
    const code = state.processedReservationIds.has(reservationId)
      ? "DUPLICATE_RESERVATION"
      : "INVALID_STATE";
    return rejectTransit(state, player, reservationId, code, "取消できる予約がありません");
  }

  state.processedReservationIds.add(reservationId);
  player.transit.phase = "ON_FOOT";
  player.transit.reservedFareYen = 0;
  player.transit.reservation = null;
  player.transit.arrivalAtMs = null;
  state.lastEventId += 1;
  state.lastEventText = `${player.displayName} が予約を取消`;
  recordTransitReplay(state, "TRANSIT_CANCELLED", `${player.displayName}: ${reservation.routeId}`);
  return { accepted: true, code: "CANCELLED", message: "予約を取り消しました" };
}

function missTransitDeparture(state: GameState, player: PlayerSnapshot, reason: string): void {
  const reservation = player.transit.reservation;
  if (reservation !== null) state.processedReservationIds.add(reservation.reservationId);
  player.transit.phase = "ON_FOOT";
  player.transit.reservedFareYen = 0;
  player.transit.reservation = null;
  player.transit.arrivalAtMs = null;
  state.lastEventId += 1;
  state.lastEventText = `${player.displayName} は乗車できませんでした`;
  recordTransitReplay(state, "TRANSIT_REJECTED", `${player.displayName}: ${reason}`);
}

function updateTransitState(state: GameState): void {
  for (const player of state.players) {
    const transit = player.transit;
    if (transit.phase === "ARRIVING" && state.nowMs >= player.protectedUntilMs) {
      transit.phase = "ON_FOOT";
    }

    if (transit.phase === "WAITING") {
      const reservation = transit.reservation;
      if (reservation === null) {
        transit.phase = "ON_FOOT";
        transit.reservedFareYen = 0;
      } else if (state.nowMs >= reservation.departureAtMs) {
        const station = stationById(state, reservation.fromStationId);
        if (station === undefined || distance(player.position, station.position) > STATION_INTERACTION_RADIUS) {
          missTransitDeparture(state, player, "出発時に駅構内にいないため予約を解除");
        } else if (transit.balanceYen < reservation.fareYen) {
          missTransitDeparture(state, player, "乗車確定時の残高不足");
        } else {
          transit.balanceYen -= reservation.fareYen;
          transit.reservedFareYen = 0;
          transit.phase = "IN_TRANSIT";
          transit.arrivalAtMs = reservation.arrivalAtMs;
          reservation.status = "COMMITTED";
          state.processedReservationIds.add(reservation.reservationId);
          player.velocity = { x: 0, z: 0 };
          state.lastEventId += 1;
          state.lastEventText = `${player.displayName} が乗車（¥${reservation.fareYen}）`;
          recordTransitReplay(state, "TRANSIT_BOARDED", `${player.displayName}: ${reservation.routeId}`);
        }
      }
    }

    if (transit.phase === "IN_TRANSIT") {
      const reservation = transit.reservation;
      if (reservation !== null && state.nowMs >= reservation.arrivalAtMs) {
        const destination = stationById(state, reservation.toStationId);
        if (destination !== undefined) {
          player.position = { x: destination.position.x, z: destination.position.z + 28 };
          transit.currentStationId = destination.id;
        }
        transit.phase = "ARRIVING";
        transit.arrivalAtMs = null;
        transit.reservation = null;
        player.protectedUntilMs = Math.max(player.protectedUntilMs, state.nowMs + ARRIVAL_PROTECTION_MS);
        player.velocity = { x: 0, z: 0 };
        state.botGoalCache.delete(player.id);
        state.lastEventId += 1;
        state.lastEventText = `${player.displayName} が${destination?.name ?? "目的駅"}へ到着`;
        recordTransitReplay(state, "TRANSIT_ARRIVED", `${player.displayName}: ${destination?.id ?? "unknown"}`);
      }
    }

    if (transit.phase === "ON_FOOT" || transit.phase === "WAITING") {
      const nearest = nearestTransitStation(state, player.position);
      transit.currentStationId = nearest !== undefined && distance(player.position, nearest.position) <= STATION_INTERACTION_RADIUS
        ? nearest.id
        : null;
    }
  }
}

function tryReserveRailBot(state: GameState, player: PlayerSnapshot): void {
  if (
    player.kind !== "BOT" ||
    player.strategy !== "RAIL" ||
    player.role !== "RUNNER" ||
    player.transit.phase !== "ON_FOOT" ||
    player.transit.reservation !== null
  ) return;
  const station = nearestTransitStation(state, player.position);
  if (station === undefined || distance(player.position, station.position) > STATION_INTERACTION_RADIUS) return;

  const candidate = state.transitGraph.timetable
    .filter((departure) => departure.departureAtMs >= state.nowMs + 1_000)
    .map((departure) => ({ departure, route: routeForDeparture(state, departure) }))
    .filter((item): item is { departure: TransitDeparture; route: TransitRoute } =>
      item.route !== undefined && item.route.fromStationId === station.id)
    .filter(({ departure, route }) => {
      const destination = stationById(state, route.toStationId);
      if (destination === undefined || route.fareYen > player.transit.balanceYen) return false;
      const walkMs = distance(player.position, destination.position) / BOT_SPEED * 1_000;
      return departure.arrivalAtMs - state.nowMs < walkMs;
    })
    .sort((left, right) => left.departure.departureAtMs - right.departure.departureAtMs)[0];
  if (candidate === undefined) return;
  reserveTransit(
    state,
    player.id,
    `rail-${player.id}-${candidate.departure.id}`,
    candidate.departure.id,
  );
}

function upsertObstacle(state: GameState, obstacle: Obstacle): void {
  const existing = state.obstacles.find((candidate) => candidate.id === obstacle.id);
  if (existing === undefined) state.obstacles.push({ ...obstacle });
  else Object.assign(existing, obstacle);
}

function upsertNavigationEdge(state: GameState, edge: NavigationEdge): void {
  const existing = state.navigationEdges.find((candidate) => candidate.id === edge.id);
  if (existing === undefined) state.navigationEdges.push({ ...edge });
  else Object.assign(existing, edge);
}

function applyPatchOperations(state: GameState, patch: MapPatch): void {
  for (const operation of patch.operations) {
    if (operation.type === "raise_barrier") {
      for (const obstacle of state.obstacles) {
        if (obstacle.kind === "BARRIER") obstacle.active = false;
      }
    }
    upsertObstacle(state, operation.obstacle);
    if (operation.type !== "raise_barrier") upsertNavigationEdge(state, operation.edge);
  }
}

function prepareNextIntervention(state: GameState): void {
  const candidates = createFixturePatchCandidates(state.interventionSequence, verifierContext(state));
  const decision = selectPatchCandidate(candidates, verifierContext(state));
  const selected = decision.selected;
  const totalLatency = decision.evaluations.reduce((total, evaluation) => total + evaluation.latencyMs, 0);
  appendReplay(state, {
    phase: "CANDIDATES_EVALUATED",
    patchId: selected?.patchId ?? null,
    selectedPatchId: selected?.patchId ?? null,
    summary: selected === null ? "全候補をHard Constraintで拒否" : `${selected.reason}を採用`,
    candidates: decision.evaluations,
    latencyMs: totalLatency,
    estimatedCostYen: decision.evaluations.reduce((total, evaluation) => total + evaluation.estimatedCostYen, 0),
  });
  if (selected === null) {
    state.cityCore.patchAppliesAtMs += state.patchIntervalMs;
    state.interventionSequence += 1;
    state.lastEventId += 1;
    state.lastEventText = "CITY CORE候補を全件拒否。地形を維持";
    return;
  }

  state.pendingPatches = selected.operations.map((operation) => prepareChunkPatch(state.world, {
    patchId: selected.patchId,
    baseMapVersion: selected.baseMapVersion,
    obstacle: { ...operation.obstacle },
  }));
  state.cityCore.activePatch = selected;
  state.cityCore.patchId = selected.patchId;
  state.cityCore.target = { ...selected.target };
  state.cityCore.patchIndex = state.interventionSequence;
  state.cityCore.patchPhase = "PREPARED";
  state.cityCore.warningStartedAtMs = state.nowMs;
  state.cityCore.affectedChunkIds = [
    ...new Set(state.pendingPatches.flatMap((prepared) => prepared.affectedChunkIds)),
  ].sort();
  state.lastEventId += 1;
  state.lastEventText = `CITY CORE予告: ${selected.reason} / ${selected.operations[0]?.type ?? "patch"}`;
}

function commitPreparedIntervention(state: GameState): void {
  const patch = state.cityCore.activePatch;
  if (patch === null || state.pendingPatches.length === 0) return;
  const committed = state.pendingPatches.map((pending) => commitChunkPatch(pending, state.mapVersion));
  const nextVersion = committed[0]?.committedMapVersion;
  if (nextVersion === undefined) return;

  state.rollbackCheckpoint = {
    patchId: patch.patchId,
    mapVersion: state.mapVersion,
    mapChecksum: state.mapChecksum,
    obstacles: state.obstacles.map((obstacle) => ({ ...obstacle })),
    navigationEdges: state.navigationEdges.map((edge) => ({ ...edge })),
    lastAppliedPatchId: state.cityCore.lastAppliedPatchId,
  };
  applyPatchOperations(state, patch);
  state.mapVersion = nextVersion;
  state.mapChecksum = computeMapChecksum(state.mapVersion, state.obstacles, state.navigationEdges);
  state.appliedPatchIds.add(patch.patchId);
  state.patchAcknowledgements.set(patch.patchId, new Map());
  state.lastTargetPlayerId = patch.targetPlayerId;
  state.cityCore.lastAppliedPatchId = patch.patchId;
  state.botRouteCache.clear();
  state.botGoalCache.clear();
  appendReplay(state, {
    phase: "PATCH_COMMITTED",
    patchId: patch.patchId,
    selectedPatchId: patch.patchId,
    summary: `MapPatch v${state.mapVersion}: ${patch.operations.map((operation) => operation.type).join("+")}`,
    candidates: [],
    latencyMs: 1,
    estimatedCostYen: 0,
  });
  state.lastEventId += 1;
  state.lastEventText = `MapPatch v${state.mapVersion}: ${patch.operations[0]?.type ?? "patch"}をcommit`;
  state.interventionSequence += 1;
  state.cityCore.warningStartedAtMs = null;
  state.cityCore.patchAppliesAtMs += state.patchIntervalMs;
  state.cityCore.patchId = `patch-${state.interventionSequence + 1}-valid`;
  state.cityCore.patchPhase = "IDLE";
  state.cityCore.affectedChunkIds = [];
  state.cityCore.activePatch = null;
  state.pendingPatches = [];
}

function updateCityCore(state: GameState, deltaMs: number): void {
  const warningDuration = 6_000;
  if (
    state.cityCore.warningStartedAtMs === null &&
    state.nowMs >= state.cityCore.patchAppliesAtMs - warningDuration
  ) {
    prepareNextIntervention(state);
  }

  const targetDelta = subtract(state.cityCore.target, state.cityCore.position);
  const travel = normalized(targetDelta);
  const travelDistance = Math.min(length(targetDelta), (deltaMs / 1_000) * 18);
  state.cityCore.position.x += travel.x * travelDistance;
  state.cityCore.position.z += travel.z * travelDistance;

  if (state.nowMs >= state.cityCore.patchAppliesAtMs) commitPreparedIntervention(state);
}

function rollbackLastPatch(state: GameState, reason: string): void {
  const checkpoint = state.rollbackCheckpoint;
  if (checkpoint === null) return;
  state.mapVersion = checkpoint.mapVersion;
  state.mapChecksum = checkpoint.mapChecksum;
  state.obstacles = checkpoint.obstacles.map((obstacle) => ({ ...obstacle }));
  state.navigationEdges = checkpoint.navigationEdges.map((edge) => ({ ...edge }));
  state.cityCore.lastAppliedPatchId = checkpoint.lastAppliedPatchId;
  state.rollbackCount += 1;
  state.botRouteCache.clear();
  state.botGoalCache.clear();
  appendReplay(state, {
    phase: "ROLLBACK",
    patchId: checkpoint.patchId,
    selectedPatchId: null,
    summary: reason,
    candidates: [],
    latencyMs: 1,
    estimatedCostYen: 0,
  });
  state.lastEventId += 1;
  state.lastEventText = `ROLLBACK → v${state.mapVersion}: ${reason}`;
  state.rollbackCheckpoint = null;
}

export function acknowledgeMapChecksum(
  state: GameState,
  playerId: string,
  patchId: string,
  mapVersion: number,
  checksum: string,
): boolean {
  if (patchId !== state.cityCore.lastAppliedPatchId || mapVersion !== state.mapVersion) return false;
  if (checksum !== state.mapChecksum) {
    rollbackLastPatch(state, `${playerId}のchecksum不一致 (${checksum} != ${state.mapChecksum})`);
    return false;
  }
  const acknowledgements = state.patchAcknowledgements.get(patchId) ?? new Map<string, string>();
  acknowledgements.set(playerId, checksum);
  state.patchAcknowledgements.set(patchId, acknowledgements);
  return true;
}

function applyTag(state: GameState): void {
  if (state.nowMs < state.tagLockedUntilMs) return;
  const oni = state.players.find((player) => player.role === "ONI");
  if (oni === undefined) return;
  if (oni.kind === "HUMAN" && !oni.connected) return;
  if (oni.transit.phase === "IN_TRANSIT" || oni.transit.phase === "ARRIVING") return;
  const target = state.players.find(
    (player) =>
      player.role === "RUNNER" &&
      (player.kind === "BOT" || player.connected) &&
      player.transit.phase !== "IN_TRANSIT" &&
      player.transit.phase !== "ARRIVING" &&
      state.nowMs >= player.protectedUntilMs &&
      distance(oni.position, player.position) <= TAG_DISTANCE,
  );
  if (target === undefined) return;

  oni.role = "RUNNER";
  target.role = "ONI";
  target.protectedUntilMs = state.nowMs + TAG_PROTECTION_MS;
  state.tagLockedUntilMs = state.nowMs + TAG_PROTECTION_MS;
  state.lastEventId += 1;
  state.lastEventText = `${oni.displayName} → ${target.displayName} 鬼交代`;
  if (
    distance(oni.position, state.cityCore.target) <= state.cityCore.radius ||
    distance(target.position, state.cityCore.target) <= state.cityCore.radius
  ) {
    state.cityCoreTagCount += 1;
    appendReplay(state, {
      phase: "TAG_CHANGED",
      patchId: state.cityCore.lastAppliedPatchId,
      selectedPatchId: null,
      summary: `CITY CORE範囲内で${target.displayName}へ鬼交代`,
      candidates: [],
      latencyMs: 0,
      estimatedCostYen: 0,
    });
  }
}

function finishGame(state: GameState): void {
  state.status = "FINISHED";
  state.remainingMs = 0;
  const ranked = [...state.players].sort(
    (a, b) => a.oniDurationMs - b.oniDurationMs || a.id.localeCompare(b.id),
  );
  state.winnerId = ranked[0]?.id ?? null;
  state.lastEventId += 1;
  state.lastEventText = `${ranked[0]?.displayName ?? "Unknown"} の勝利`;
  for (const player of state.players) player.velocity = { x: 0, z: 0 };
}

export function stepGame(state: GameState, inputs: Inputs, deltaMs: number): void {
  if (state.status !== "RUNNING" || deltaMs <= 0) return;
  const safeDeltaMs = Math.min(deltaMs, 100);
  const endsAtMs = state.endsAtMs;
  if (endsAtMs === null) return;
  const appliedDeltaMs = Math.min(safeDeltaMs, Math.max(0, endsAtMs - state.nowMs));
  state.nowMs += appliedDeltaMs;

  const oniBeforeMovement = state.players.find((player) => player.role === "ONI");
  if (oniBeforeMovement !== undefined) oniBeforeMovement.oniDurationMs += appliedDeltaMs;

  updateTransitState(state);

  for (const player of state.players) {
    const movement = player.kind === "BOT" ? botMovement(state, player) : inputs[player.id];
    movePlayer(state, player, movement ?? { x: 0, z: 0, sprint: false }, appliedDeltaMs);
  }
  updateTransitState(state);
  for (const player of state.players) tryReserveRailBot(state, player);

  updateCityCore(state, appliedDeltaMs);
  applyTag(state);
  state.remainingMs = Math.max(0, endsAtMs - state.nowMs);
  if (state.nowMs >= endsAtMs) finishGame(state);
}

export function snapshotOf(state: GameState): MatchSnapshot {
  return {
    matchId: state.matchId,
    seed: state.seed,
    world: {
      ...state.world,
      roadOffsets: [...state.world.roadOffsets],
    },
    status: state.status,
    nowMs: state.nowMs,
    startedAtMs: state.startedAtMs,
    endsAtMs: state.endsAtMs,
    remainingMs: state.remainingMs,
    mapVersion: state.mapVersion,
    lastEventId: state.lastEventId,
    lastEventText: state.lastEventText,
    winnerId: state.winnerId,
    tagLockedUntilMs: state.tagLockedUntilMs,
    stageSpec: structuredClone(state.stageSpec),
    navigationEdges: state.navigationEdges.map((edge) => ({ ...edge })),
    mapChecksum: state.mapChecksum,
    rollbackCount: state.rollbackCount,
    aiReplay: structuredClone(state.aiReplay),
    transitGraph: structuredClone(state.transitGraph),
    players: state.players.map((player) => ({
      ...player,
      position: { ...player.position },
      velocity: { ...player.velocity },
      transit: structuredClone(player.transit),
    })),
    obstacles: state.obstacles.map((obstacle) => ({ ...obstacle })),
    cityCore: {
      ...state.cityCore,
      position: { ...state.cityCore.position },
      target: { ...state.cityCore.target },
      affectedChunkIds: [...state.cityCore.affectedChunkIds],
      activePatch: state.cityCore.activePatch === null ? null : structuredClone(state.cityCore.activePatch),
    },
  };
}

export function gameCheckpointOf(state: GameState): GameCheckpoint {
  return {
    snapshot: snapshotOf(state),
    durationMs: state.durationMs,
    patchIntervalMs: state.patchIntervalMs,
    humanSpeedMultiplier: state.humanSpeedMultiplier,
    appliedPatchIds: [...state.appliedPatchIds],
    patchAcknowledgements: [...state.patchAcknowledgements].map(([patchId, acknowledgements]) => [
      patchId,
      [...acknowledgements],
    ]),
    botGoalCache: [...state.botGoalCache].map(([playerId, goal]) => [
      playerId,
      { expiresAtMs: goal.expiresAtMs, goal: { ...goal.goal } },
    ]),
    interventionSequence: state.interventionSequence,
    lastTargetPlayerId: state.lastTargetPlayerId,
    rollbackCheckpoint: state.rollbackCheckpoint === null
      ? null
      : structuredClone(state.rollbackCheckpoint),
    cityCoreTagCount: state.cityCoreTagCount,
    processedReservationIds: [...state.processedReservationIds],
  };
}

export function restoreGame(checkpoint: GameCheckpoint): GameState {
  const restoredSnapshot = MatchSnapshotSchema.parse(checkpoint.snapshot);
  const state = createGame({
    seed: restoredSnapshot.seed,
    durationMs: checkpoint.durationMs,
    patchIntervalMs: checkpoint.patchIntervalMs,
    humanSpeedMultiplier: checkpoint.humanSpeedMultiplier,
  });
  Object.assign(state, structuredClone(restoredSnapshot));
  state.durationMs = checkpoint.durationMs;
  state.patchIntervalMs = checkpoint.patchIntervalMs;
  state.humanSpeedMultiplier = checkpoint.humanSpeedMultiplier;
  state.botRouteCache = new Map();
  state.botGoalCache = new Map(
    checkpoint.botGoalCache.map(([playerId, goal]) => [
      playerId,
      { expiresAtMs: goal.expiresAtMs, goal: { ...goal.goal } },
    ]),
  );
  state.pendingPatches = restoredSnapshot.cityCore.activePatch?.operations.map((operation) =>
    prepareChunkPatch(restoredSnapshot.world, {
      patchId: restoredSnapshot.cityCore.activePatch?.patchId ?? "restored-patch",
      baseMapVersion: restoredSnapshot.cityCore.activePatch?.baseMapVersion ?? restoredSnapshot.mapVersion,
      obstacle: { ...operation.obstacle },
    })) ?? [];
  state.appliedPatchIds = new Set(checkpoint.appliedPatchIds);
  state.patchAcknowledgements = new Map(
    checkpoint.patchAcknowledgements.map(([patchId, acknowledgements]) => [
      patchId,
      new Map(acknowledgements),
    ]),
  );
  state.interventionSequence = checkpoint.interventionSequence;
  state.lastTargetPlayerId = checkpoint.lastTargetPlayerId;
  state.rollbackCheckpoint = checkpoint.rollbackCheckpoint === null
    ? null
    : structuredClone(checkpoint.rollbackCheckpoint);
  state.cityCoreTagCount = checkpoint.cityCoreTagCount;
  state.processedReservationIds = new Set(checkpoint.processedReservationIds);
  return state;
}

export function checksumOf(state: GameState): string {
  const canonical = JSON.stringify(canonicalValue(snapshotOf(state)));
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function canonicalValue(value: unknown): unknown {
  if (typeof value === "number") return Math.round(value * 1_000) / 1_000;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}
