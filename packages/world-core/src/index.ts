import type { Obstacle, Vec2, WorldSpec } from "@dopagaki/contracts";

export interface RoadNode {
  id: string;
  position: Vec2;
  neighbors: string[];
}

export interface RoadGraph {
  nodes: RoadNode[];
  byId: Map<string, RoadNode>;
}

export const DEFAULT_WORLD_SPEC: WorldSpec = {
  sizeMeters: 500,
  halfSize: 250,
  chunksPerAxis: 3,
  chunkSizeMeters: 500 / 3,
  activeChunkRadius: 1,
  roadOffsets: [-200, -100, 0, 100, 200],
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

export function createCityObstacles(spec: WorldSpec, seed: number): Obstacle[] {
  const random = new WorldRandom(seed);
  const obstacles: Obstacle[] = [];
  const roadHalf = spec.roadWidth / 2;
  const alley = 8;
  const sidewalk = 5;

  for (let xIndex = 0; xIndex < spec.roadOffsets.length - 1; xIndex += 1) {
    const leftRoad = spec.roadOffsets[xIndex];
    const rightRoad = spec.roadOffsets[xIndex + 1];
    if (leftRoad === undefined || rightRoad === undefined) continue;
    const usableLeft = leftRoad + roadHalf + sidewalk;
    const usableRight = rightRoad - roadHalf - sidewalk;
    const cellWidth = usableRight - usableLeft;
    const buildingWidth = (cellWidth - alley) / 2;

    for (let zIndex = 0; zIndex < spec.roadOffsets.length - 1; zIndex += 1) {
      const topRoad = spec.roadOffsets[zIndex];
      const bottomRoad = spec.roadOffsets[zIndex + 1];
      if (topRoad === undefined || bottomRoad === undefined) continue;
      const usableTop = topRoad + roadHalf + sidewalk;
      const usableBottom = bottomRoad - roadHalf - sidewalk;
      const cellDepth = usableBottom - usableTop;
      const buildingDepth = (cellDepth - alley) / 2;

      for (let localX = 0; localX < 2; localX += 1) {
        for (let localZ = 0; localZ < 2; localZ += 1) {
          const x = usableLeft + buildingWidth / 2 + localX * (buildingWidth + alley);
          const z = usableTop + buildingDepth / 2 + localZ * (buildingDepth + alley);
          const height = 16 + Math.floor(random.next() * 29);
          obstacles.push({
            id: `building-${xIndex}-${zIndex}-${localX}-${localZ}`,
            kind: "BUILDING",
            x,
            z,
            width: buildingWidth,
            depth: buildingDepth,
            height,
            active: true,
          });
        }
      }
    }
  }

  obstacles.push(
    {
      id: "station-kita",
      kind: "STATION",
      x: 0,
      z: -238,
      width: 44,
      depth: 12,
      height: 7,
      active: true,
    },
    {
      id: "station-minami",
      kind: "STATION",
      x: 0,
      z: 238,
      width: 44,
      depth: 12,
      height: 7,
      active: true,
    },
  );

  return obstacles;
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
