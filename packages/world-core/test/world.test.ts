import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORLD_SPEC,
  createCityObstacles,
  createRoadGraph,
  findRoadPath,
} from "../src/index.js";

describe("500m low-poly city", () => {
  it("generates deterministic buildings outside every road corridor", () => {
    const obstacles = createCityObstacles(DEFAULT_WORLD_SPEC, 20260827);
    const replay = createCityObstacles(DEFAULT_WORLD_SPEC, 20260827);
    const buildings = obstacles.filter((obstacle) => obstacle.kind === "BUILDING");

    expect(obstacles).toEqual(replay);
    expect(buildings).toHaveLength(64);
    for (const building of buildings) {
      const overlapsVerticalRoad = DEFAULT_WORLD_SPEC.roadOffsets.some(
        (road) => Math.abs(building.x - road) < building.width / 2 + DEFAULT_WORLD_SPEC.roadWidth / 2,
      );
      const overlapsHorizontalRoad = DEFAULT_WORLD_SPEC.roadOffsets.some(
        (road) => Math.abs(building.z - road) < building.depth / 2 + DEFAULT_WORLD_SPEC.roadWidth / 2,
      );
      expect(overlapsVerticalRoad || overlapsHorizontalRoad).toBe(false);
    }
  });

  it("reroutes A* when CITY CORE closes one road edge", () => {
    const graph = createRoadGraph(DEFAULT_WORLD_SPEC);
    const direct = findRoadPath(graph, "1:2", "2:2", []);
    const rerouted = findRoadPath(graph, "1:2", "2:2", [
      {
        id: "barrier-test",
        kind: "BARRIER",
        x: -50,
        z: 0,
        width: 3,
        depth: 22,
        height: 6,
        active: true,
      },
    ]);

    expect(direct.map((node) => node.id)).toEqual(["1:2", "2:2"]);
    expect(rerouted.length).toBeGreaterThan(direct.length);
    expect(rerouted.map((node) => node.id)).not.toEqual(direct.map((node) => node.id));
  });
});
