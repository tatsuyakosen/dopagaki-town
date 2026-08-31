import { describe, expect, it } from "vitest";
import {
  ClientMessageSchema,
  MapPatchSchema,
  MatchSnapshotSchema,
  ServerMessageSchema,
  TransitGraphSchema,
} from "../src/index.js";

describe("runtime contracts", () => {
  it("accepts a normalized movement payload", () => {
    const result = ClientMessageSchema.parse({
      type: "INPUT",
      seq: 3,
      movement: { x: 1, z: 0, sprint: false },
    });

    expect(result.type).toBe("INPUT");
  });

  it("rejects a malformed snapshot", () => {
    expect(() => MatchSnapshotSchema.parse({ matchId: "broken" })).toThrow();
  });

  it("validates reconnect tokens and acknowledgement metadata", () => {
    const playerToken = "a".repeat(48);
    expect(ClientMessageSchema.parse({
      type: "JOIN",
      playerName: "Reconnect Player",
      matchMode: "DEMO",
      playerToken,
      lastAckedEventId: 12,
      mapVersion: 3,
    })).toMatchObject({ type: "JOIN", matchMode: "DEMO", playerToken, lastAckedEventId: 12, mapVersion: 3 });
    expect(() => ClientMessageSchema.parse({ type: "JOIN", playerToken: "short" })).toThrow();
    expect(() => ClientMessageSchema.parse({ type: "JOIN", matchMode: "CUSTOM" })).toThrow();
    expect(ServerMessageSchema.parse({
      type: "WELCOME",
      playerId: "human-1",
      matchId: "local-1",
      playerToken,
      resumed: true,
      lastInputSeq: 7,
      lastEventId: 12,
      mapVersion: 3,
    })).toMatchObject({ type: "WELCOME", resumed: true, playerToken });
  });

  it("validates idempotent transit reservation and cancellation messages", () => {
    expect(ClientMessageSchema.parse({
      type: "TRANSIT_RESERVE",
      reservationId: "reservation-1",
      departureId: "departure-1",
    })).toMatchObject({ type: "TRANSIT_RESERVE", reservationId: "reservation-1" });
    expect(ClientMessageSchema.parse({
      type: "TRANSIT_CANCEL",
      reservationId: "reservation-1",
    })).toMatchObject({ type: "TRANSIT_CANCEL", reservationId: "reservation-1" });
    expect(() => ClientMessageSchema.parse({
      type: "TRANSIT_RESERVE",
      reservationId: "",
      departureId: "departure-1",
    })).toThrow();
  });

  it("rejects transit graphs with broken references or inconsistent times", () => {
    const graph = {
      source: "FIXTURE",
      seed: 20260827,
      stations: ["osaka", "fukushima", "temma", "nakazakicho"].map((id, index) => ({
        id,
        name: id,
        chunkId: `chunk-${index}`,
        position: { x: index * 100, z: 0 },
      })),
      routes: [{
        id: "route-osaka-fukushima",
        fromStationId: "osaka",
        toStationId: "fukushima",
        durationMs: 10_000,
        fareYen: 140,
        transfers: 0,
      }],
      timetable: [{
        id: "departure-1",
        routeId: "route-osaka-fukushima",
        departureAtMs: 20_000,
        arrivalAtMs: 30_000,
      }],
    } as const;

    const parsed = TransitGraphSchema.parse(graph);
    expect(parsed.routes).toHaveLength(1);
    expect(ServerMessageSchema.parse({
      type: "ROOM_CONFIG",
      matchId: "match-20260827",
      matchMode: "DEMO",
      durationMs: 180_000,
      seed: graph.seed,
      transitGraph: parsed,
    })).toMatchObject({ type: "ROOM_CONFIG", matchId: "match-20260827" });
    expect(() => TransitGraphSchema.parse({
      ...graph,
      routes: [{ ...graph.routes[0], toStationId: "unknown" }],
    })).toThrow();
    expect(() => TransitGraphSchema.parse({
      ...graph,
      timetable: [{ ...graph.timetable[0], arrivalAtMs: 30_001 }],
    })).toThrow();
  });

  it("accepts the allowlisted MapPatch DSL and rejects unknown operations", () => {
    const patch = {
      patchId: "patch-contract",
      baseMapVersion: 1,
      reason: "route_mix",
      targetZone: "chunk-10-10",
      target: { x: 125, z: 125 },
      targetPlayerId: null,
      warningSec: 6,
      operations: [{
        type: "spawn_rooftop_bridge",
        anchorId: "roof-a",
        bridgeId: "bridge-a",
        obstacle: { id: "bridge-a", kind: "BRIDGE", x: 125, z: 125, width: 80, depth: 8, height: 1, elevation: 14, active: true },
        edge: { id: "edge-a", fromNodeId: "10:10", toNodeId: "11:11", kind: "BRIDGE", active: true },
      }],
      expectedEffect: { encounterRatePct: 12, routeDiversityPct: 8 },
    };
    expect(MapPatchSchema.parse(patch).operations[0]?.type).toBe("spawn_rooftop_bridge");
    expect(() => MapPatchSchema.parse({
      ...patch,
      operations: [{ ...patch.operations[0], type: "delete_city" }],
    })).toThrow();
    const bridgeOperation = patch.operations[0];
    if (bridgeOperation === undefined) throw new Error("bridge operation fixture missing");
    expect(() => MapPatchSchema.parse({
      ...patch,
      operations: [{
        ...bridgeOperation,
        obstacle: { ...bridgeOperation.obstacle, kind: "BUILDING" },
      }],
    })).toThrow();
  });
});
