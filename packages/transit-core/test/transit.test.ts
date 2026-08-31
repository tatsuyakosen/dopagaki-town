import { describe, expect, it } from "vitest";
import { DEFAULT_WORLD_SPEC, createStationMetadata } from "@dopagaki/world-core";
import { createFixtureTransitGraph, resolveTransitGraph } from "../src/index.js";

describe("transit fixture", () => {
  const stations = createStationMetadata(DEFAULT_WORLD_SPEC);

  it("generates the same Osaka-area graph and 2-4 game-minute timetable at 6x time", () => {
    const graph = createFixtureTransitGraph(20260827, stations);
    const replay = createFixtureTransitGraph(20260827, stations);

    expect(graph).toEqual(replay);
    expect(graph.stations.map((station) => station.name)).toEqual([
      "大阪",
      "福島",
      "天満",
      "中崎町",
      "京橋",
      "西九条",
    ]);
    expect(graph.routes).toHaveLength(12);
    for (const route of graph.routes) {
      const times = graph.timetable
        .filter((departure) => departure.routeId === route.id)
        .map((departure) => departure.departureAtMs);
      for (let index = 1; index < times.length; index += 1) {
        const current = times[index];
        const previous = times[index - 1];
        expect(current).toBeDefined();
        expect(previous).toBeDefined();
        expect((current ?? 0) - (previous ?? 0)).toBeGreaterThanOrEqual(20_000);
        expect((current ?? 0) - (previous ?? 0)).toBeLessThanOrEqual(40_000);
        expect([20_000, 30_000, 40_000]).toContain((current ?? 0) - (previous ?? 0));
      }
    }
  });

  it("falls back to the fixture after an adapter timeout", async () => {
    const graph = await resolveTransitGraph({
      seed: 42,
      stations,
      timeoutMs: 5,
      loadExternal: () => new Promise(() => undefined),
    });
    expect(graph.source).toBe("FIXTURE");
    expect(graph.stations).toHaveLength(6);
  });
});
