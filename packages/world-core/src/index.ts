import type { Obstacle, Vec2, WorldSpec } from "@dopagaki/contracts";

export interface ChunkCoordinate {
  x: number;
  z: number;
}

export interface ChunkMetadata extends ChunkCoordinate {
  id: string;
  center: Vec2;
  seed: number;
  zone: "CORE" | "URBAN" | "STATION";
}

export interface StationMetadata {
  id: string;
  name: string;
  chunkId: string;
  position: Vec2;
}

export interface MutationAnchor {
  id: string;
  chunkIds: string[];
  position: Vec2;
  width: number;
  depth: number;
  height: number;
}

export interface WorldMetadata {
  chunks: ChunkMetadata[];
  stations: StationMetadata[];
  mutationAnchors: MutationAnchor[];
}

export interface ChunkWindow {
  focus: ChunkCoordinate;
  preloadFocus: ChunkCoordinate;
  activeIds: string[];
  preloadIds: string[];
}

export interface RoadNode {
  id: string;
  position: Vec2;
  neighbors: string[];
}

export interface RoadGraph {
  nodes: RoadNode[];
  byId: Map<string, RoadNode>;
}

export interface ChunkPatchRequest {
  patchId: string;
  baseMapVersion: number;
  obstacle: Obstacle;
}

export interface PreparedChunkPatch extends ChunkPatchRequest {
  phase: "PREPARED";
  affectedChunkIds: string[];
  checksum: string;
}

export interface CommittedChunkPatch extends Omit<PreparedChunkPatch, "phase"> {
  phase: "COMMITTED";
  committedMapVersion: number;
}

export const DEFAULT_WORLD_SPEC: WorldSpec = {
  sizeMeters: 5_000,
  halfSize: 2_500,
  chunksPerAxis: 20,
  chunkSizeMeters: 250,
  activeChunkRadius: 1,
  preloadChunkRadius: 2,
  roadOffsets: Array.from({ length: 21 }, (_value, index) => -2_500 + index * 250),
  roadWidth: 18,
};

class WorldRandom {
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

function mixSeed(seed: number, x: number, z: number): number {
  let value = seed ^ Math.imul(x + 1, 0x9e3779b1) ^ Math.imul(z + 1, 0x85ebca6b);
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  return value >>> 0;
}

export function chunkId(coordinate: ChunkCoordinate): string {
  return `chunk-${coordinate.x}-${coordinate.z}`;
}

export function chunkAtPosition(spec: WorldSpec, position: Vec2): ChunkCoordinate {
  const x = Math.floor((position.x + spec.halfSize) / spec.chunkSizeMeters);
  const z = Math.floor((position.z + spec.halfSize) / spec.chunkSizeMeters);
  return {
    x: Math.max(0, Math.min(spec.chunksPerAxis - 1, x)),
    z: Math.max(0, Math.min(spec.chunksPerAxis - 1, z)),
  };
}

export function chunkCenter(spec: WorldSpec, coordinate: ChunkCoordinate): Vec2 {
  return {
    x: -spec.halfSize + (coordinate.x + 0.5) * spec.chunkSizeMeters,
    z: -spec.halfSize + (coordinate.z + 0.5) * spec.chunkSizeMeters,
  };
}

function coordinatesInRadius(
  spec: WorldSpec,
  center: ChunkCoordinate,
  radius: number,
): ChunkCoordinate[] {
  const coordinates: ChunkCoordinate[] = [];
  for (let z = center.z - radius; z <= center.z + radius; z += 1) {
    if (z < 0 || z >= spec.chunksPerAxis) continue;
    for (let x = center.x - radius; x <= center.x + radius; x += 1) {
      if (x < 0 || x >= spec.chunksPerAxis) continue;
      coordinates.push({ x, z });
    }
  }
  return coordinates;
}

export function calculateChunkWindow(
  spec: WorldSpec,
  position: Vec2,
  velocity: Vec2 = { x: 0, z: 0 },
): ChunkWindow {
  const focus = chunkAtPosition(spec, position);
  const shiftX = Math.abs(velocity.x) > 0.25 ? Math.sign(velocity.x) : 0;
  const shiftZ = Math.abs(velocity.z) > 0.25 ? Math.sign(velocity.z) : 0;
  const preloadFocus = {
    x: Math.max(0, Math.min(spec.chunksPerAxis - 1, focus.x + shiftX)),
    z: Math.max(0, Math.min(spec.chunksPerAxis - 1, focus.z + shiftZ)),
  };
  const activeIds = coordinatesInRadius(spec, focus, spec.activeChunkRadius).map(chunkId);
  const preloadIds = new Set(
    coordinatesInRadius(spec, preloadFocus, spec.preloadChunkRadius).map(chunkId),
  );
  for (const id of activeIds) preloadIds.add(id);
  return {
    focus,
    preloadFocus,
    activeIds,
    preloadIds: [...preloadIds].sort(),
  };
}

export function createStationMetadata(spec: WorldSpec): StationMetadata[] {
  const last = spec.chunksPerAxis - 3;
  const middle = Math.floor(spec.chunksPerAxis / 2);
  const coordinates: ChunkCoordinate[] = [
    { x: 2, z: 2 },
    { x: middle, z: 2 },
    { x: last, z: 6 },
    { x: 2, z: last - 2 },
    { x: middle, z: last },
    { x: last, z: last },
  ];
  const names = ["北西駅", "北駅", "東駅", "西駅", "南駅", "南東駅"];
  return coordinates.map((coordinate, index) => ({
    id: `station-${index + 1}`,
    name: names[index] ?? `駅${index + 1}`,
    chunkId: chunkId(coordinate),
    position: chunkCenter(spec, coordinate),
  }));
}

export function createMutationAnchors(spec: WorldSpec): MutationAnchor[] {
  const centerRoad = spec.roadOffsets[Math.floor(spec.roadOffsets.length / 2)] ?? 0;
  const anchors: MutationAnchor[] = [];
  for (let index = 0; index < spec.chunksPerAxis; index += 1) {
    const segmentCenter = -spec.halfSize + (index + 0.5) * spec.chunkSizeMeters;
    for (const [axis, position, width, depth] of [
      ["h", { x: segmentCenter, z: centerRoad }, 3, 22],
      ["v", { x: centerRoad, z: segmentCenter }, 22, 3],
    ] as const) {
      anchors.push({
        id: `anchor-${axis}-${index}`,
        chunkIds: chunkIdsForBounds(spec, position.x, position.z, width, depth),
        position,
        width,
        depth,
        height: 7,
      });
    }
  }
  return anchors;
}

export function createWorldMetadata(spec: WorldSpec, seed: number): WorldMetadata {
  const stations = createStationMetadata(spec);
  const stationChunks = new Set(stations.map((station) => station.chunkId));
  const middle = (spec.chunksPerAxis - 1) / 2;
  const chunks: ChunkMetadata[] = [];
  for (let z = 0; z < spec.chunksPerAxis; z += 1) {
    for (let x = 0; x < spec.chunksPerAxis; x += 1) {
      const coordinate = { x, z };
      const id = chunkId(coordinate);
      chunks.push({
        ...coordinate,
        id,
        center: chunkCenter(spec, coordinate),
        seed: mixSeed(seed, x, z),
        zone: stationChunks.has(id)
          ? "STATION"
          : Math.abs(x - middle) <= 1.5 && Math.abs(z - middle) <= 1.5
            ? "CORE"
            : "URBAN",
      });
    }
  }
  return { chunks, stations, mutationAnchors: createMutationAnchors(spec) };
}

export function createChunkObstacles(
  spec: WorldSpec,
  seed: number,
  coordinate: ChunkCoordinate,
): Obstacle[] {
  const id = chunkId(coordinate);
  const station = createStationMetadata(spec).find((item) => item.chunkId === id);
  if (station !== undefined) {
    return [{
      id: station.id,
      kind: "STATION",
      x: station.position.x,
      z: station.position.z,
      width: Math.min(96, spec.chunkSizeMeters - spec.roadWidth - 24),
      depth: 44,
      height: 8,
      active: true,
    }];
  }

  const random = new WorldRandom(mixSeed(seed, coordinate.x, coordinate.z));
  const center = chunkCenter(spec, coordinate);
  const roadHalf = spec.roadWidth / 2;
  const sidewalk = 5;
  const alley = 8;
  const usableSize = spec.chunkSizeMeters - (roadHalf + sidewalk) * 2;
  const buildingSize = (usableSize - alley) / 2;
  const offset = (buildingSize + alley) / 2;
  const obstacles: Obstacle[] = [];
  for (let localZ = 0; localZ < 2; localZ += 1) {
    for (let localX = 0; localX < 2; localX += 1) {
      obstacles.push({
        id: `building-${coordinate.x}-${coordinate.z}-${localX}-${localZ}`,
        kind: "BUILDING",
        x: center.x + (localX === 0 ? -offset : offset),
        z: center.z + (localZ === 0 ? -offset : offset),
        width: buildingSize,
        depth: buildingSize,
        height: 16 + Math.floor(random.next() * 29),
        active: true,
      });
    }
  }
  return obstacles;
}

export function createCityObstacles(spec: WorldSpec, seed: number): Obstacle[] {
  return createWorldMetadata(spec, seed).chunks.flatMap((chunk) =>
    createChunkObstacles(spec, seed, chunk),
  );
}

export function createRoadGraph(spec: WorldSpec): RoadGraph {
  const nodes: RoadNode[] = [];
  const byId = new Map<string, RoadNode>();
  for (let xIndex = 0; xIndex < spec.roadOffsets.length; xIndex += 1) {
    const x = spec.roadOffsets[xIndex];
    if (x === undefined) continue;
    for (let zIndex = 0; zIndex < spec.roadOffsets.length; zIndex += 1) {
      const z = spec.roadOffsets[zIndex];
      if (z === undefined) continue;
      const id = roadNodeId(xIndex, zIndex);
      const neighbors = [
        xIndex > 0 ? roadNodeId(xIndex - 1, zIndex) : null,
        xIndex + 1 < spec.roadOffsets.length ? roadNodeId(xIndex + 1, zIndex) : null,
        zIndex > 0 ? roadNodeId(xIndex, zIndex - 1) : null,
        zIndex + 1 < spec.roadOffsets.length ? roadNodeId(xIndex, zIndex + 1) : null,
      ].filter((neighbor): neighbor is string => neighbor !== null);
      const node = { id, position: { x, z }, neighbors };
      nodes.push(node);
      byId.set(id, node);
    }
  }
  return { nodes, byId };
}

function roadNodeId(xIndex: number, zIndex: number): string {
  return `${xIndex}:${zIndex}`;
}

export function distanceBetween(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function nearestRoadNode(graph: RoadGraph, position: Vec2): RoadNode {
  const first = graph.nodes[0];
  if (first === undefined) throw new Error("Road graph must contain at least one node");
  return graph.nodes.reduce((nearest, node) =>
    distanceBetween(position, node.position) < distanceBetween(position, nearest.position) ? node : nearest,
  );
}

export function pointCollides(
  obstacles: ReadonlyArray<Obstacle>,
  position: Vec2,
  radius = 0,
): boolean {
  return obstacles.some((obstacle) => {
    if (!obstacle.active) return false;
    return (
      Math.abs(position.x - obstacle.x) < obstacle.width / 2 + radius &&
      Math.abs(position.z - obstacle.z) < obstacle.depth / 2 + radius
    );
  });
}

export function segmentIsClear(
  obstacles: ReadonlyArray<Obstacle>,
  start: Vec2,
  end: Vec2,
  radius = 0,
): boolean {
  const distance = distanceBetween(start, end);
  const samples = Math.max(2, Math.ceil(distance / 2));
  for (let index = 1; index < samples; index += 1) {
    const progress = index / samples;
    if (
      pointCollides(
        obstacles,
        {
          x: start.x + (end.x - start.x) * progress,
          z: start.z + (end.z - start.z) * progress,
        },
        radius,
      )
    ) {
      return false;
    }
  }
  return true;
}

export function edgeIsBlocked(
  obstacles: ReadonlyArray<Obstacle>,
  start: Vec2,
  end: Vec2,
): boolean {
  return obstacles.some((obstacle) => {
    if (!obstacle.active || obstacle.kind !== "BARRIER") return false;
    const left = obstacle.x - obstacle.width / 2;
    const right = obstacle.x + obstacle.width / 2;
    const top = obstacle.z - obstacle.depth / 2;
    const bottom = obstacle.z + obstacle.depth / 2;
    if (start.z === end.z) {
      return start.z >= top && start.z <= bottom && Math.max(start.x, end.x) >= left && Math.min(start.x, end.x) <= right;
    }
    if (start.x === end.x) {
      return start.x >= left && start.x <= right && Math.max(start.z, end.z) >= top && Math.min(start.z, end.z) <= bottom;
    }
    return !segmentIsClear([obstacle], start, end);
  });
}

export function findRoadPath(
  graph: RoadGraph,
  startId: string,
  goalId: string,
  obstacles: ReadonlyArray<Obstacle>,
): RoadNode[] {
  const start = graph.byId.get(startId);
  const goal = graph.byId.get(goalId);
  if (start === undefined || goal === undefined) return [];

  const open = new Set([start.id]);
  const cameFrom = new Map<string, string>();
  const cost = new Map<string, number>([[start.id, 0]]);
  const estimated = new Map<string, number>([[start.id, distanceBetween(start.position, goal.position)]]);

  while (open.size > 0) {
    const currentId = [...open].sort((a, b) => {
      const scoreDifference = (estimated.get(a) ?? Number.POSITIVE_INFINITY) - (estimated.get(b) ?? Number.POSITIVE_INFINITY);
      return scoreDifference || a.localeCompare(b);
    })[0];
    if (currentId === undefined) break;
    if (currentId === goal.id) return reconstructPath(graph, cameFrom, currentId);
    open.delete(currentId);
    const current = graph.byId.get(currentId);
    if (current === undefined) continue;

    for (const neighborId of current.neighbors) {
      const neighbor = graph.byId.get(neighborId);
      if (neighbor === undefined || edgeIsBlocked(obstacles, current.position, neighbor.position)) continue;
      const nextCost = (cost.get(currentId) ?? Number.POSITIVE_INFINITY) + distanceBetween(current.position, neighbor.position);
      if (nextCost >= (cost.get(neighborId) ?? Number.POSITIVE_INFINITY)) continue;
      cameFrom.set(neighborId, currentId);
      cost.set(neighborId, nextCost);
      estimated.set(neighborId, nextCost + distanceBetween(neighbor.position, goal.position));
      open.add(neighborId);
    }
  }
  return [];
}

function reconstructPath(graph: RoadGraph, cameFrom: Map<string, string>, currentId: string): RoadNode[] {
  const path: RoadNode[] = [];
  let cursor: string | undefined = currentId;
  while (cursor !== undefined) {
    const node = graph.byId.get(cursor);
    if (node !== undefined) path.push(node);
    cursor = cameFrom.get(cursor);
  }
  return path.reverse();
}

export function chunkIdsForBounds(
  spec: WorldSpec,
  x: number,
  z: number,
  width: number,
  depth: number,
): string[] {
  const minimum = chunkAtPosition(spec, { x: x - width / 2, z: z - depth / 2 });
  const maximum = chunkAtPosition(spec, { x: x + width / 2, z: z + depth / 2 });
  const ids: string[] = [];
  for (let chunkZ = minimum.z; chunkZ <= maximum.z; chunkZ += 1) {
    for (let chunkX = minimum.x; chunkX <= maximum.x; chunkX += 1) {
      ids.push(chunkId({ x: chunkX, z: chunkZ }));
    }
  }
  return ids.sort();
}

function patchChecksum(request: ChunkPatchRequest, affectedChunkIds: string[]): string {
  const canonical = JSON.stringify({
    patchId: request.patchId,
    baseMapVersion: request.baseMapVersion,
    obstacle: request.obstacle,
    affectedChunkIds,
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function prepareChunkPatch(spec: WorldSpec, request: ChunkPatchRequest): PreparedChunkPatch {
  if (request.obstacle.kind !== "BARRIER") {
    throw new Error("M3 chunk patch only accepts a barrier obstacle");
  }
  if (request.baseMapVersion < 1) throw new Error("baseMapVersion must be positive");
  const affectedChunkIds = chunkIdsForBounds(
    spec,
    request.obstacle.x,
    request.obstacle.z,
    request.obstacle.width,
    request.obstacle.depth,
  );
  return {
    ...request,
    obstacle: { ...request.obstacle },
    phase: "PREPARED",
    affectedChunkIds,
    checksum: patchChecksum(request, affectedChunkIds),
  };
}

export function commitChunkPatch(
  patch: PreparedChunkPatch | CommittedChunkPatch,
  currentMapVersion: number,
): CommittedChunkPatch {
  if (patch.phase !== "PREPARED") throw new Error(`Patch ${patch.patchId} was already committed`);
  if (patch.baseMapVersion !== currentMapVersion) {
    throw new Error(`Patch ${patch.patchId} expected v${patch.baseMapVersion}, received v${currentMapVersion}`);
  }
  return {
    ...patch,
    obstacle: { ...patch.obstacle },
    affectedChunkIds: [...patch.affectedChunkIds],
    phase: "COMMITTED",
    committedMapVersion: currentMapVersion + 1,
  };
}
