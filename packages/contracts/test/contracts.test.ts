import { describe, expect, it } from "vitest";
import { ClientMessageSchema, MapPatchSchema, MatchSnapshotSchema } from "../src/index.js";

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
