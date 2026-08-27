import type {
  BotStrategy,
  MatchSnapshot,
  Movement,
  Obstacle,
  PlayerSnapshot,
  Vec2,
} from "@dopagaki/contracts";

export const WORLD_HALF_SIZE = 82;
export const PLAYER_RADIUS = 1.35;
export const TAG_DISTANCE = 3.2;
export const TAG_PROTECTION_MS = 3_000;
export const DEFAULT_MATCH_DURATION_MS = 10 * 60 * 1_000;
export const DEFAULT_PATCH_INTERVAL_MS = 20_000;

const HUMAN_SPEED = 10.5;
const BOT_SPEED = 8.4;

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

function createBuildings(): Obstacle[] {
  const blocks: Array<[string, number, number, number, number, number]> = [
    ["northwest", -56, -55, 25, 28, 16],
    ["north", 0, -57, 32, 23, 22],
    ["northeast", 55, -55, 26, 28, 13],
    ["west", -57, 0, 23, 30, 18],
    ["east", 57, 0, 23, 30, 24],
    ["southwest", -55, 55, 28, 25, 20],
    ["south", 0, 57, 34, 22, 15],
    ["southeast", 56, 55, 25, 27, 19],
    ["inner-nw", -26, -25, 14, 13, 9],
    ["inner-ne", 26, -25, 14, 13, 12],
    ["inner-sw", -26, 26, 14, 14, 11],
    ["inner-se", 26, 26, 14, 14, 14],
  ];

  const buildings: Obstacle[] = blocks.map(([id, x, z, width, depth, height]) => ({
    id: `building-${id}`,
    kind: "BUILDING" as const,
    x,
    z,
    width,
    depth,
    height,
    active: true,
  }));

  buildings.push(
    {
      id: "station-kita",
      kind: "STATION",
      x: 0,
      z: -77,
      width: 18,
      depth: 5,
      height: 5,
      active: true,
    },
    {
      id: "station-minami",
      kind: "STATION",
      x: 0,
      z: 77,
      width: 18,
      depth: 5,
      height: 5,
      active: true,
    },
  );

  return buildings;
}

const BARRIER_ANCHORS: ReadonlyArray<Obstacle> = [
  {
    id: "barrier-0",
    kind: "BARRIER",
    x: 0,
    z: -17,
    width: 18,
    depth: 2.5,
    height: 5,
    active: false,
  },
  {
    id: "barrier-1",
    kind: "BARRIER",
    x: 17,
    z: 0,
    width: 2.5,
    depth: 18,
    height: 5,
    active: false,
  },
  {
    id: "barrier-2",
    kind: "BARRIER",
    x: 0,
    z: 17,
    width: 18,
    depth: 2.5,
    height: 5,
    active: false,
  },
  {
    id: "barrier-3",
    kind: "BARRIER",
    x: -17,
    z: 0,
    width: 2.5,
    depth: 18,
    height: 5,
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
    { x: -42, z: -8 },
    { x: 42, z: -8 },
    { x: -42, z: 10 },
    { x: 42, z: 10 },
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
    obstacles: [...createBuildings(), ...BARRIER_ANCHORS.map((barrier) => ({ ...barrier }))],
    cityCore: {
      position: { x: 0, z: 0 },
      target: { x: firstTarget.x, z: firstTarget.z },
      warningStartedAtMs: null,
      patchAppliesAtMs: patchIntervalMs,
      radius: 14,
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

function botMovement(state: GameState, player: PlayerSnapshot): Movement {
  const oni = state.players.find((candidate) => candidate.role === "ONI");
  if (oni === undefined) return { x: 0, z: 0, sprint: false };

  if (player.role === "ONI") {
    const target = nearestPlayer(
      player,
      state.players.filter((candidate) => candidate.role === "RUNNER"),
    );
    const direction = target === undefined ? { x: 0, z: 0 } : normalized(subtract(target.position, player.position));
    return { ...direction, sprint: false };
  }

  const awayFromOni = normalized(subtract(player.position, oni.position));
  let tactical: Vec2;
  if (player.strategy === "CITY_CORE" && state.cityCore.warningStartedAtMs !== null) {
    tactical = normalized(subtract(state.cityCore.target, player.position));
  } else if (player.strategy === "RAIL") {
    const stationTarget = player.position.z < 0 ? { x: 0, z: 70 } : { x: 0, z: -70 };
    tactical = normalized(subtract(stationTarget, player.position));
  } else {
    tactical = normalized({ x: -awayFromOni.z, z: awayFromOni.x });
  }

  return {
    x: awayFromOni.x * 0.78 + tactical.x * 0.35,
    z: awayFromOni.z * 0.78 + tactical.z * 0.35,
    sprint: false,
  };
}

function collides(state: GameState, x: number, z: number): boolean {
  return state.obstacles.some((obstacle) => {
    if (!obstacle.active) return false;
    const halfWidth = obstacle.width / 2 + PLAYER_RADIUS;
    const halfDepth = obstacle.depth / 2 + PLAYER_RADIUS;
    return Math.abs(x - obstacle.x) < halfWidth && Math.abs(z - obstacle.z) < halfDepth;
  });
}

function movePlayer(state: GameState, player: PlayerSnapshot, movement: Movement, deltaMs: number): void {
  const direction = normalized(movement);
  const baseSpeed = player.kind === "HUMAN" ? HUMAN_SPEED : BOT_SPEED;
  const speed = baseSpeed * (movement.sprint && player.kind === "HUMAN" ? 1.12 : 1);
  const seconds = deltaMs / 1_000;
  const dx = direction.x * speed * seconds;
  const dz = direction.z * speed * seconds;
  const nextX = Math.max(-WORLD_HALF_SIZE, Math.min(WORLD_HALF_SIZE, player.position.x + dx));
  const nextZ = Math.max(-WORLD_HALF_SIZE, Math.min(WORLD_HALF_SIZE, player.position.z + dz));

  let appliedX = player.position.x;
  let appliedZ = player.position.z;
  if (!collides(state, nextX, player.position.z)) appliedX = nextX;
  if (!collides(state, appliedX, nextZ)) appliedZ = nextZ;

  if (appliedX === player.position.x && appliedZ === player.position.z && (dx !== 0 || dz !== 0)) {
    const sidestepX = Math.max(-WORLD_HALF_SIZE, Math.min(WORLD_HALF_SIZE, player.position.x - dz));
    const sidestepZ = Math.max(-WORLD_HALF_SIZE, Math.min(WORLD_HALF_SIZE, player.position.z + dx));
    if (!collides(state, sidestepX, player.position.z)) appliedX = sidestepX;
    if (!collides(state, appliedX, sidestepZ)) appliedZ = sidestepZ;
  }

  player.velocity = {
    x: (appliedX - player.position.x) / Math.max(seconds, 0.001),
    z: (appliedZ - player.position.z) / Math.max(seconds, 0.001),
  };
  player.position = { x: appliedX, z: appliedZ };
}

function updateCityCore(state: GameState): void {
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
  state.cityCore.position.x += travel.x * Math.min(0.22, length(targetDelta));
  state.cityCore.position.z += travel.z * Math.min(0.22, length(targetDelta));

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

  updateCityCore(state);
  applyTag(state);
  state.remainingMs = Math.max(0, endsAtMs - state.nowMs);
  if (state.nowMs >= endsAtMs) finishGame(state);
}

export function snapshotOf(state: GameState): MatchSnapshot {
  return {
    matchId: state.matchId,
    seed: state.seed,
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
