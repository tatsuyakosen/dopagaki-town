import { describe, expect, it } from "vitest";
import { ClientMessageSchema, MatchSnapshotSchema } from "../src/index.js";

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
});
