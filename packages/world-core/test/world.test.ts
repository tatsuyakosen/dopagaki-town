import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORLD_SPEC,
  calculateChunkWindow,
  commitChunkPatch,
  createChunkObstacles,
  createRoadGraph,
  createWorldMetadata,
  findRoadPath,
  prepareChunkPatch,
} from "../src/index.js";

describe("5km logical city", () => {
  it("generates deterministic metadata for 400 chunks, six stations, and mutation anchors", () => {
    const world = createWorldMetadata(DEFAULT_WORLD_SPEC, 20260827);
    const replay = createWorldMetadata(DEFAULT_WORLD_SPEC, 20260827);

    expect(DEFAULT_WORLD_SPEC.sizeMeters).toBe(5_000);
    expect(DEFAULT_WORLD_SPEC.chunkSizeMeters).toBe(250);
    expect(world).toEqual(replay);
    expect(world.chunks).toHaveLength(400);
    expect(new Set(world.chunks.map((chunk) => chunk.id)).size).toBe(400);
    expect(world.stations).toHaveLength(6);
    expect(world.mutationAnchors).toHaveLength(40);
  });

  it("generates deterministic active detail without placing buildings on boundary roads", () => {
    const coordinate = { x: 9, z: 9 };
    const obstacles = createChunkObstacles(DEFAULT_WORLD_SPEC, 20260827, coordinate);
    const replay = createChunkObstacles(DEFAULT_WORLD_SPEC, 20260827, coordinate);

    expect(obstacles).toEqual(replay);
    expect(obstacles).toHaveLength(4);
    for (const obstacle of obstacles) {
      const nearestVerticalRoad = Math.min(
        ...DEFAULT_WORLD_SPEC.roadOffsets.map((road) => Math.abs(obstacle.x - road)),
      );
      const nearestHorizontalRoad = Math.min(
        ...DEFAULT_WORLD_SPEC.roadOffsets.map((road) => Math.abs(obstacle.z - road)),
      );
      expect(nearestVerticalRoad).toBeGreaterThan(obstacle.width / 2 + DEFAULT_WORLD_SPEC.roadWidth / 2);
      expect(nearestHorizontalRoad).toBeGreaterThan(obstacle.depth / 2 + DEFAULT_WORLD_SPEC.roadWidth / 2);
    }
  });

  it("keeps only a 5x5 preload and 3x3 active window during a full out-and-back traversal", () => {
    let maximumPreloaded = 0;
    let maximumActive = 0;
    for (const direction of [1, -1]) {
      for (let offset = -2_499; offset <= 2_499; offset += 25) {
        const x = direction === 1 ? offset : -offset;
        const window = calculateChunkWindow(
          DEFAULT_WORLD_SPEC,
          { x, z: x / 3 },
          { x: direction, z: direction / 3 },
        );
        maximumPreloaded = Math.max(maximumPreloaded, window.preloadIds.length);
        maximumActive = Math.max(maximumActive, window.activeIds.length);
        expect(new Set(window.preloadIds).size).toBe(window.preloadIds.length);
        expect(window.activeIds.every((id) => window.preloadIds.includes(id))).toBe(true);
      }
    }

    const center = calculateChunkWindow(DEFAULT_WORLD_SPEC, { x: 0, z: 0 });
    expect(center.preloadIds).toHaveLength(25);
    expect(center.activeIds).toHaveLength(9);
    expect(maximumPreloaded).toBe(25);
    expect(maximumActive).toBe(9);
  });

  it("reroutes the wide-area A* graph when CITY CORE closes one road edge", () => {
    const graph = createRoadGraph(DEFAULT_WORLD_SPEC);
    const direct = findRoadPath(graph, "9:10", "10:10", []);
    const rerouted = findRoadPath(graph, "9:10", "10:10", [
      {
        id: "barrier-test",
        kind: "BARRIER",
        x: -125,
        z: 0,
        width: 3,
        depth: 22,
        height: 7,
        active: true,
      },
    ]);

    expect(graph.nodes).toHaveLength(441);
    expect(direct.map((node) => node.id)).toEqual(["9:10", "10:10"]);
    expect(rerouted.length).toBeGreaterThan(direct.length);
  });

  it("prepares every affected boundary chunk before committing a patch atomically", () => {
    const prepared = prepareChunkPatch(DEFAULT_WORLD_SPEC, {
      patchId: "patch-boundary",
      baseMapVersion: 4,
      obstacle: {
        id: "barrier-boundary",
        kind: "BARRIER",
        x: -125,
        z: 0,
        width: 3,
        depth: 22,
        height: 7,
        active: true,
      },
    });

    expect(prepared.phase).toBe("PREPARED");
    expect(prepared.affectedChunkIds).toHaveLength(2);
    expect(() => commitChunkPatch(prepared, 3)).toThrow(/expected v4/);
    const committed = commitChunkPatch(prepared, 4);
    expect(committed.phase).toBe("COMMITTED");
    expect(committed.committedMapVersion).toBe(5);
    expect(() => commitChunkPatch(committed, 5)).toThrow(/already committed/);
  });

  it("rejects static city geometry from the patch preparation boundary", () => {
    expect(() => prepareChunkPatch(DEFAULT_WORLD_SPEC, {
      patchId: "patch-forbidden-building",
      baseMapVersion: 1,
      obstacle: {
        id: "forbidden-building",
        kind: "BUILDING",
        x: 0,
        z: 0,
        width: 20,
        depth: 20,
        height: 30,
        active: true,
      },
    })).toThrow(/protected static/);
  });
});
