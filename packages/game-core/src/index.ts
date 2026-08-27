import type {
  BotStrategy,
  MatchSnapshot,
  Movement,
  Obstacle,
  PlayerSnapshot,
  Vec2,
} from "@dopagaki/contracts";
import {
  DEFAULT_WORLD_SPEC,
  createCityObstacles,
  createRoadGraph,
  distanceBetween,
  findRoadPath,
  nearestRoadNode,
  pointCollides,
  segmentIsClear,
  type RoadNode,
} from "@dopagaki/world-core";

export const WORLD_HALF_SIZE = DEFAULT_WORLD_SPEC.halfSize;
export const PLAYER_RADIUS = 1.35;
export const TAG_DISTANCE = 3.2;
export const TAG_PROTECTION_MS = 3_000;
export const DEFAULT_MATCH_DURATION_MS = 10 * 60 * 1_000;
export const DEFAULT_PATCH_INTERVAL_MS = 20_000;

const HUMAN_SPEED = 10.5;
const BOT_SPEED = 9.4;
const ROAD_GRAPH = createRoadGraph(DEFAULT_WORLD_SPEC);

export interface GameConfig {
  seed: number;
  durationMs?: number;
  patchIntervalMs?: number;
}

export interface GameState extends MatchSnapshot {
  durationMs: number;
  patchIntervalMs: number;
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
  };
}

export function createGame(config: GameConfig): GameState {
  const random = new SeededRandom(config.seed);
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
  const patchIntervalMs = config.patchIntervalMs ?? DEFAULT_PATCH_INTERVAL_MS;

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
    remainingMs: config.durationMs ?? DEFAULT_MATCH_DURATION_MS,
    mapVersion: 1,
    lastEventId: 0,
    lastEventText: "入場者を待っています",
    winnerId: null,
    tagLockedUntilMs: 0,
    players,
    obstacles: [
      ...createCityObstacles(DEFAULT_WORLD_SPEC, config.seed),
      ...BARRIER_ANCHORS.map((barrier) => ({ ...barrier })),
    ],
    cityCore: {
      position: { x: 0, z: 0 },
      target: { x: firstTarget.x, z: firstTarget.z },
      warningStartedAtMs: null,
      patchAppliesAtMs: patchIntervalMs,
      radius: 28,
      patchIndex: firstBarrierIndex,
    },
    durationMs: config.durationMs ?? DEFAULT_MATCH_DURATION_MS,
    patchIntervalMs,
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

export function letBotTakeOver(state: GameState, playerId: string): void {
  const player = state.players.find((item) => item.id === playerId);
  if (player === undefined) return;
  player.kind = "BOT";
  player.strategy = player.role === "ONI" ? "CHASE" : "CITY_CORE";
  player.connected = false;
  player.displayName = `${player.displayName} (Bot)`;
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
  const path = findRoadPath(ROAD_GRAPH, startNode.id, goalNode.id, state.obstacles);
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
    return player.position.z <= 0 ? { x: 0, z: 200 } : { x: 0, z: -200 };
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

  const goal = runnerRoadGoal(state, player, oni);
  return { ...directionToRoadGoal(state, player, goal), sprint: false };
}

function collides(state: GameState, x: number, z: number): boolean {
  return pointCollides(state.obstacles, { x, z }, PLAYER_RADIUS);
}

function movePlayer(state: GameState, player: PlayerSnapshot, movement: Movement, deltaMs: number): void {
  const direction = normalized(movement);
  const baseSpeed = player.kind === "HUMAN" ? HUMAN_SPEED : BOT_SPEED;
  const speed = baseSpeed * (movement.sprint && player.kind === "HUMAN" ? 1.12 : 1);
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

  if (appliedX === player.position.x && appliedZ === player.position.z && (dx !== 0 || dz !== 0)) {
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

function updateCityCore(state: GameState, deltaMs: number): void {
  const warningDuration = Math.min(5_000, Math.max(1_000, state.patchIntervalMs * 0.45));
  if (
    state.cityCore.warningStartedAtMs === null &&
    state.nowMs >= state.cityCore.patchAppliesAtMs - warningDuration
  ) {
    state.cityCore.warningStartedAtMs = state.nowMs;
    state.lastEventId += 1;
    state.lastEventText = "CITY COREが道路改築を予告";
  }

  const targetDelta = subtract(state.cityCore.target, state.cityCore.position);
  const travel = normalized(targetDelta);
  const travelDistance = Math.min(length(targetDelta), (deltaMs / 1_000) * 18);
  state.cityCore.position.x += travel.x * travelDistance;
  state.cityCore.position.z += travel.z * travelDistance;

  if (state.nowMs < state.cityCore.patchAppliesAtMs) return;

  for (const obstacle of state.obstacles) {
    if (obstacle.kind === "BARRIER") obstacle.active = false;
  }
  const activeBarrier = state.obstacles.find(
    (obstacle) => obstacle.id === `barrier-${state.cityCore.patchIndex}`,
  );
  if (activeBarrier !== undefined) activeBarrier.active = true;

  state.mapVersion += 1;
  state.lastEventId += 1;
  state.lastEventText = `MapPatch v${state.mapVersion}: 道路隆起を適用`;

  const nextIndex = (state.cityCore.patchIndex + 1 + (state.seed % 2)) % BARRIER_ANCHORS.length;
  const nextTarget = BARRIER_ANCHORS[nextIndex] ?? BARRIER_ANCHORS[0];
  if (nextTarget === undefined) return;
  state.cityCore.patchIndex = nextIndex;
  state.cityCore.target = { x: nextTarget.x, z: nextTarget.z };
  state.cityCore.warningStartedAtMs = null;
  state.cityCore.patchAppliesAtMs += state.patchIntervalMs;
}

function applyTag(state: GameState): void {
  if (state.nowMs < state.tagLockedUntilMs) return;
  const oni = state.players.find((player) => player.role === "ONI");
  if (oni === undefined) return;
  const target = state.players.find(
    (player) =>
      player.role === "RUNNER" &&
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

  for (const player of state.players) {
    const movement = player.kind === "BOT" ? botMovement(state, player) : inputs[player.id];
    movePlayer(state, player, movement ?? { x: 0, z: 0, sprint: false }, appliedDeltaMs);
  }

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
    players: state.players.map((player) => ({
      ...player,
      position: { ...player.position },
      velocity: { ...player.velocity },
    })),
    obstacles: state.obstacles.map((obstacle) => ({ ...obstacle })),
    cityCore: {
      ...state.cityCore,
      position: { ...state.cityCore.position },
      target: { ...state.cityCore.target },
    },
  };
}

export function checksumOf(state: GameState): string {
  const canonical = JSON.stringify(snapshotOf(state), (_key, value: unknown) =>
    typeof value === "number" ? Math.round(value * 1_000) / 1_000 : value,
  );
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
