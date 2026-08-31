import {
  MapPatchSchema,
  StageSpecSchema,
  type ConstraintViolation,
  type MapPatch,
  type MapPatchOperation,
  type NavigationEdge,
  type Obstacle,
  type PatchEvaluation,
  type PlayerSnapshot,
  type StageSpec,
  type WorldSpec,
} from "@dopagaki/contracts";
/*
 * External Director output is allowed to propose only schema-valid data. The
 * deterministic verifier below remains the authority for accepting a patch.
 */
import {
  chunkAtPosition,
  chunkId,
  chunkIdsForBounds,
  createRoadGraph,
  distanceBetween,
  edgeIsBlocked,
  findRoadPath,
  nearestRoadNode,
  roadPathDistance,
  type RoadGraph,
  type WorldMetadata,
} from "@dopagaki/world-core";

export interface VerifierContext {
  world: WorldSpec;
  metadata: WorldMetadata;
  players: PlayerSnapshot[];
  obstacles: Obstacle[];
  navigationEdges: NavigationEdge[];
  currentMapVersion: number;
  appliedPatchIds: ReadonlySet<string>;
  lastTargetPlayerId: string | null;
}

export interface PatchSelection {
  evaluations: PatchEvaluation[];
  selected: MapPatch | null;
}

export interface DirectorPlan {
  source: "FIXTURE" | "EXTERNAL";
  stageSpec: StageSpec;
  candidates: MapPatch[];
}

export interface DirectorResolverOptions {
  seed: number;
  sequence: number;
  context: VerifierContext;
  timeoutMs?: number;
  loadExternal?: () => Promise<unknown>;
}

function cloneObstacle(obstacle: Obstacle): Obstacle {
  return { ...obstacle };
}

function operationEdge(operation: MapPatchOperation): NavigationEdge | null {
  return operation.type === "raise_barrier" ? null : { ...operation.edge };
}

export function operationObstacles(patch: MapPatch): Obstacle[] {
  return patch.operations.map((operation) => cloneObstacle(operation.obstacle));
}

function simulatePatch(
  context: VerifierContext,
  patch: MapPatch,
): { obstacles: Obstacle[]; navigationEdges: NavigationEdge[] } {
  const obstacles = context.obstacles.map(cloneObstacle);
  const navigationEdges = context.navigationEdges.map((edge) => ({ ...edge }));
  for (const operation of patch.operations) {
    if (operation.type === "raise_barrier") {
      for (const obstacle of obstacles) {
        if (obstacle.kind === "BARRIER") obstacle.active = false;
      }
    }
    const existing = obstacles.find((obstacle) => obstacle.id === operation.obstacle.id);
    if (existing === undefined) obstacles.push(cloneObstacle(operation.obstacle));
    else Object.assign(existing, operation.obstacle);
    const edge = operationEdge(operation);
    if (edge !== null) {
      const existingEdge = navigationEdges.find((candidate) => candidate.id === edge.id);
      if (existingEdge === undefined) navigationEdges.push(edge);
      else Object.assign(existingEdge, edge);
    }
  }
  return { obstacles, navigationEdges };
}

function activeNeighbors(
  graph: RoadGraph,
  nodeId: string,
  obstacles: ReadonlyArray<Obstacle>,
  navigationEdges: ReadonlyArray<NavigationEdge>,
): string[] {
  const node = graph.byId.get(nodeId);
  if (node === undefined) return [];
  const extra = navigationEdges.flatMap((edge) => {
    if (!edge.active) return [];
    if (edge.fromNodeId === nodeId) return [edge.toNodeId];
    if (edge.toNodeId === nodeId) return [edge.fromNodeId];
    return [];
  });
  return [...new Set([...node.neighbors, ...extra])].filter((neighborId) => {
    const neighbor = graph.byId.get(neighborId);
    return neighbor !== undefined && !edgeIsBlocked(obstacles, node.position, neighbor.position);
  });
}

function deterministicLatency(patchId: string): number {
  const hash = [...patchId].reduce((total, character) => total + character.charCodeAt(0), 0);
  return 2 + (hash % 5) * 0.25;
}

function addViolation(
  violations: ConstraintViolation[],
  id: ConstraintViolation["id"],
  message: string,
): void {
  if (!violations.some((violation) => violation.id === id)) violations.push({ id, message });
}

export function evaluatePatch(patch: MapPatch, context: VerifierContext): PatchEvaluation {
  const violations: ConstraintViolation[] = [];
  const graph = createRoadGraph(context.world);
  const simulated = simulatePatch(context, patch);

  if (patch.baseMapVersion !== context.currentMapVersion) {
    addViolation(violations, "VERSION", `baseMapVersion v${patch.baseMapVersion} is stale`);
  }
  if (context.appliedPatchIds.has(patch.patchId)) {
    addViolation(violations, "DUPLICATE", `patchId ${patch.patchId} was already used`);
  }

  const nearestDistance = Math.min(
    ...context.players.map((player) => distanceBetween(player.position, patch.target)),
  );
  if (nearestDistance <= 50 && patch.warningSec <= 0) {
    addViolation(violations, "F-01", "50m以内の変更には事前予告が必要です");
  }
  if (patch.warningSec < 5) {
    addViolation(violations, "F-02", "視界内変更の予告は5秒以上必要です");
  }

  const routeCountByPlayer: Record<string, number> = {};
  for (const player of context.players) {
    const node = nearestRoadNode(graph, player.position);
    const routeCount = Math.min(2, activeNeighbors(graph, node.id, simulated.obstacles, simulated.navigationEdges).length);
    routeCountByPlayer[player.id] = routeCount;
    if (routeCount < 2) addViolation(violations, "F-03", `${player.id}の有効経路が2本未満です`);
  }

  for (const [index, player] of context.players.entries()) {
    const start = nearestRoadNode(graph, player.position);
    const goalId = start.neighbors[index % Math.max(1, start.neighbors.length)];
    if (goalId === undefined) continue;
    const before = findRoadPath(graph, start.id, goalId, context.obstacles, context.navigationEdges);
    const after = findRoadPath(graph, start.id, goalId, simulated.obstacles, simulated.navigationEdges);
    const beforeDistance = roadPathDistance(before);
    const afterDistance = roadPathDistance(after);
    if (before.length > 0 && (after.length === 0 || afterDistance >= beforeDistance * 1.5)) {
      addViolation(violations, "F-04", `${player.id}だけの最短経路が50%以上悪化します`);
    }
  }

  if (patch.targetPlayerId !== null && patch.targetPlayerId === context.lastTargetPlayerId) {
    addViolation(violations, "F-05", `${patch.targetPlayerId}への連続介入です`);
  }

  const targetsStation = context.metadata.stations.some(
    (station) => distanceBetween(station.position, patch.target) <= 80,
  );
  const targetsTransitProtectedPlayer = context.players.some(
    (player) =>
      (player.transit.phase === "IN_TRANSIT" || player.transit.phase === "ARRIVING") &&
      distanceBetween(player.position, patch.target) <= 80,
  );
  if (targetsStation || targetsTransitProtectedPlayer) {
    addViolation(violations, "F-06", "駅構内・乗車中・到着地点は改築対象外です");
  }

  const oni = context.players.find((player) => player.role === "ONI");
  if (oni !== undefined) {
    const oniNode = nearestRoadNode(graph, oni.position);
    for (const runner of context.players.filter((player) => player.role === "RUNNER")) {
      const runnerNode = nearestRoadNode(graph, runner.position);
      const path = findRoadPath(graph, oniNode.id, runnerNode.id, simulated.obstacles, simulated.navigationEdges);
      if (path.length === 0) addViolation(violations, "F-07", `${runner.id}と鬼が完全分断されます`);
    }
  }

  const affectedChunkIds = new Set(
    patch.operations.flatMap((operation) =>
      chunkIdsForBounds(
        context.world,
        operation.obstacle.x,
        operation.obstacle.z,
        operation.obstacle.width,
        operation.obstacle.depth,
      ),
    ),
  );
  if (patch.operations.length > 2 || affectedChunkIds.size > 4) {
    addViolation(violations, "F-08", "同時変形または更新チャンクの予算を超えています");
  }

  let rolloutTotal = 0;
  let rolloutSamples = 0;
  if (oni !== undefined) {
    const oniNode = nearestRoadNode(graph, oni.position);
    for (const runner of context.players.filter((player) => player.role === "RUNNER")) {
      const runnerNode = nearestRoadNode(graph, runner.position);
      const route = findRoadPath(graph, oniNode.id, runnerNode.id, simulated.obstacles, simulated.navigationEdges);
      for (const strategyWeight of [0.92, 1, 1.08]) {
        rolloutTotal += route.length === 0 ? 0 : 1_000 / (1 + roadPathDistance(route) * strategyWeight);
        rolloutSamples += 1;
      }
    }
  }
  const rolloutScore = rolloutSamples === 0 ? 0 : rolloutTotal / rolloutSamples
    + patch.expectedEffect.encounterRatePct * 0.01
    + patch.expectedEffect.routeDiversityPct * 0.005;
  return {
    patch,
    accepted: violations.length === 0,
    violations,
    routeCountByPlayer,
    rolloutScore,
    latencyMs: deterministicLatency(patch.patchId),
    estimatedCostYen: 0,
  };
}

export function selectPatchCandidate(
  candidates: MapPatch[],
  context: VerifierContext,
): PatchSelection {
  const evaluations = candidates.slice(0, 3).map((candidate) => evaluatePatch(candidate, context));
  const selectedEvaluation = evaluations
    .filter((evaluation) => evaluation.accepted)
    .sort((a, b) => b.rolloutScore - a.rolloutScore || a.patch.patchId.localeCompare(b.patch.patchId))[0];
  return { evaluations, selected: selectedEvaluation?.patch ?? null };
}

export function createFixtureStageSpec(
  seed: number,
  metadata: WorldMetadata,
  players: PlayerSnapshot[],
  world: WorldSpec,
): StageSpec {
  const initialOni = players.find((player) => player.role === "ONI")?.id ?? players[0]?.id ?? "player-1";
  return {
    seed,
    theme: "rail-vs-rooftop",
    stations: metadata.stations.slice(0, 6).map((station) => station.id),
    spawnZones: players.map((player) => chunkId(chunkAtPosition(world, player.position))),
    initialOni,
    routes: ["street", "alley", "rooftop"],
    mutationAnchors: metadata.mutationAnchors.slice(0, 8).map((anchor) => anchor.id),
    cityCoreSpawn: chunkId({ x: 10, z: 10 }),
  };
}

function patch(
  patchId: string,
  baseMapVersion: number,
  reason: string,
  target: { x: number; z: number },
  targetPlayerId: string | null,
  operation: MapPatchOperation,
  expectedEffect: { encounterRatePct: number; routeDiversityPct: number },
  world: WorldSpec,
): MapPatch {
  return {
    patchId,
    baseMapVersion,
    reason,
    targetZone: chunkId(chunkAtPosition(world, target)),
    target: { x: target.x, z: target.z },
    targetPlayerId,
    warningSec: 6,
    operations: [operation],
    expectedEffect,
  };
}

export function createFixturePatchCandidates(
  sequence: number,
  context: VerifierContext,
): MapPatch[] {
  const prefix = `patch-${sequence + 1}`;
  const station = context.metadata.stations[sequence % context.metadata.stations.length];
  if (station === undefined) throw new Error("Fixture Director requires at least one station");
  const targetPlayer = context.players[0];
  const stationGate = {
    id: `${prefix}-station-gate`, kind: "ALLEY_GATE", x: station.position.x, z: station.position.z,
    width: 10, depth: 3, height: 4, active: false,
  } satisfies Obstacle;
  const stationCandidate = patch(
    `${prefix}-station`, context.currentMapVersion, "players_clustered_at_station", station.position,
    null,
    { type: "open_alley", anchorId: station.chunkId, gateId: stationGate.id, obstacle: stationGate,
      edge: { id: `${prefix}-station-edge`, fromNodeId: "2:2", toNodeId: "3:3", kind: "ALLEY", active: true } },
    { encounterRatePct: 20, routeDiversityPct: 4 }, context.world,
  );

  const biasedObstacle = {
    id: `${prefix}-biased-barrier`, kind: "BARRIER", x: -125, z: 0,
    width: 3, depth: 22, height: 7, active: true,
  } satisfies Obstacle;
  const biasedCandidate = patch(
    `${prefix}-biased`, context.currentMapVersion, "isolate_leading_player", biasedObstacle,
    targetPlayer?.id ?? null,
    { type: "raise_barrier", anchorId: "biased-center-west", obstacle: biasedObstacle },
    { encounterRatePct: 30, routeDiversityPct: -20 }, context.world,
  );

  const operationIndex = sequence % 3;
  let validOperation: MapPatchOperation;
  let validTarget: { x: number; z: number };
  if (operationIndex === 0) {
    const obstacle = {
      id: `${prefix}-barrier`, kind: "BARRIER", x: 625, z: 0,
      width: 3, depth: 22, height: 7, active: true,
    } satisfies Obstacle;
    validTarget = obstacle;
    validOperation = { type: "raise_barrier", anchorId: "anchor-h-12", obstacle };
  } else if (operationIndex === 1) {
    const obstacle = {
      id: "alley-gate-core", kind: "ALLEY_GATE", x: 125, z: 75,
      width: 10, depth: 3, height: 4, active: false,
    } satisfies Obstacle;
    validTarget = obstacle;
    validOperation = {
      type: "open_alley", anchorId: "core-alley", gateId: obstacle.id, obstacle,
      edge: { id: "edge-core-alley", fromNodeId: "10:10", toNodeId: "11:11", kind: "ALLEY", active: true },
    };
  } else {
    const obstacle = {
      id: "bridge-core", kind: "BRIDGE", x: -125, z: 125,
      width: 160, depth: 8, height: 1, elevation: 14, active: true,
    } satisfies Obstacle;
    validTarget = obstacle;
    validOperation = {
      type: "spawn_rooftop_bridge", anchorId: "core-rooftop", bridgeId: obstacle.id, obstacle,
      edge: { id: "edge-core-bridge", fromNodeId: "9:10", toNodeId: "10:11", kind: "BRIDGE", active: true },
    };
  }
  const validCandidate = patch(
    `${prefix}-valid`, context.currentMapVersion, ["encounter_lane", "open_escape_route", "connect_rooftops"][operationIndex] ?? "route_mix",
    validTarget, null, validOperation,
    { encounterRatePct: 12, routeDiversityPct: operationIndex === 0 ? 3 : 14 }, context.world,
  );
  return [stationCandidate, biasedCandidate, validCandidate];
}

function fixtureDirectorPlan(options: DirectorResolverOptions): DirectorPlan {
  return {
    source: "FIXTURE",
    stageSpec: createFixtureStageSpec(
      options.seed,
      options.context.metadata,
      options.context.players,
      options.context.world,
    ),
    candidates: createFixturePatchCandidates(options.sequence, options.context),
  };
}

function parseExternalDirectorPlan(raw: unknown, options: DirectorResolverOptions): DirectorPlan {
  const decoded: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (typeof decoded !== "object" || decoded === null) throw new Error("Director response must be an object");
  const record = decoded as Record<string, unknown>;
  const stageSpec = StageSpecSchema.parse(record.stageSpec);
  if (stageSpec.seed !== options.seed) throw new Error("Director response seed does not match the Room seed");
  if (!Array.isArray(record.candidates) || record.candidates.length < 1 || record.candidates.length > 3) {
    throw new Error("Director response must contain one to three candidates");
  }
  const candidates = record.candidates.map((candidate) => MapPatchSchema.parse(candidate));
  if (candidates.some((candidate) => candidate.baseMapVersion !== options.context.currentMapVersion)) {
    throw new Error("Director response baseMapVersion is stale");
  }
  return { source: "EXTERNAL", stageSpec, candidates };
}

export async function resolveDirectorPlan(options: DirectorResolverOptions): Promise<DirectorPlan> {
  const fallback = fixtureDirectorPlan(options);
  if (options.loadExternal === undefined) return fallback;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Director adapter timeout")), options.timeoutMs ?? 1_000);
    });
    const raw = await Promise.race([options.loadExternal(), timeout]);
    return parseExternalDirectorPlan(raw, options);
  } catch {
    return fallback;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
