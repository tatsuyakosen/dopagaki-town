import { describe, expect, it } from "vitest";
import type { MapPatch, Obstacle, PlayerSnapshot, PlayerTransitState } from "@dopagaki/contracts";
import {
  DEFAULT_WORLD_SPEC,
  createWorldMetadata,
} from "@dopagaki/world-core";
import {
  createFixturePatchCandidates,
  evaluatePatch,
  selectPatchCandidate,
  type VerifierContext,
} from "../src/index.js";

function players(): PlayerSnapshot[] {
  const transit = (): PlayerTransitState => ({
    phase: "ON_FOOT",
    balanceYen: 1_000,
    reservedFareYen: 0,
    currentStationId: null,
    reservation: null,
    arrivalAtMs: null,
  });
  return [
    { id: "p1", displayName: "P1", kind: "BOT", strategy: "CHASE", role: "ONI", position: { x: -34, z: 0 }, velocity: { x: 0, z: 0 }, oniDurationMs: 0, protectedUntilMs: 0, connected: true, transit: transit() },
    { id: "p2", displayName: "P2", kind: "BOT", strategy: "CITY_CORE", role: "RUNNER", position: { x: 34, z: 0 }, velocity: { x: 0, z: 0 }, oniDurationMs: 0, protectedUntilMs: 0, connected: true, transit: transit() },
    { id: "p3", displayName: "P3", kind: "BOT", strategy: "RAIL", role: "RUNNER", position: { x: 0, z: -34 }, velocity: { x: 0, z: 0 }, oniDurationMs: 0, protectedUntilMs: 0, connected: true, transit: transit() },
    { id: "p4", displayName: "P4", kind: "BOT", strategy: "CHASE", role: "RUNNER", position: { x: 0, z: 34 }, velocity: { x: 0, z: 0 }, oniDurationMs: 0, protectedUntilMs: 0, connected: true, transit: transit() },
  ];
}

function context(overrides: Partial<VerifierContext> = {}): VerifierContext {
  return {
    world: DEFAULT_WORLD_SPEC,
    metadata: createWorldMetadata(DEFAULT_WORLD_SPEC, 20260827),
    players: players(),
    obstacles: [],
    navigationEdges: [],
    currentMapVersion: 1,
    appliedPatchIds: new Set(),
    lastTargetPlayerId: null,
    ...overrides,
  };
}

function validPatch(testContext = context()): MapPatch {
  return createFixturePatchCandidates(0, testContext)[2] as MapPatch;
}

describe("F-01 through F-08 map patch verifier", () => {
  it("rejects station and biased candidates, then selects the valid fixture candidate", () => {
    const testContext = context();
    const candidates = createFixturePatchCandidates(0, testContext);
    const decision = selectPatchCandidate(candidates, testContext);

    expect(candidates).toHaveLength(3);
    expect(decision.evaluations[0]?.violations.map((violation) => violation.id)).toContain("F-06");
    expect(decision.evaluations[1]?.violations.map((violation) => violation.id)).toContain("F-04");
    expect(decision.selected?.patchId).toBe(candidates[2]?.patchId);
  });

  it("enforces warning constraints F-01 and F-02", () => {
    const patch = validPatch();
    patch.target = { ...(players()[0]?.position ?? { x: 0, z: 0 }) };
    patch.warningSec = 0;
    const violations = evaluatePatch(patch, context()).violations.map((violation) => violation.id);
    expect(violations).toContain("F-01");
    expect(violations).toContain("F-02");
  });

  it("requires two exits for every player under F-03", () => {
    const edgePlayer = players()[0];
    if (edgePlayer === undefined) throw new Error("player fixture missing");
    edgePlayer.position = { x: -2_499, z: -2_499 };
    const testContext = context({ players: [edgePlayer, ...players().slice(1)] });
    const patch = validPatch(testContext);
    patch.operations = [{
      type: "raise_barrier",
      anchorId: "corner-east",
      obstacle: { id: "corner-barrier", kind: "BARRIER", x: -2_375, z: -2_500, width: 3, depth: 22, height: 7, active: true },
    }];
    patch.target = { x: -2_375, z: -2_500 };
    expect(evaluatePatch(patch, testContext).violations.map((violation) => violation.id)).toContain("F-03");
  });

  it("blocks repeated targeting under F-05", () => {
    const testContext = context({ lastTargetPlayerId: "p1" });
    const patch = validPatch(testContext);
    patch.targetPlayerId = "p1";
    expect(evaluatePatch(patch, testContext).violations.map((violation) => violation.id)).toContain("F-05");
  });

  it("detects complete oni separation under F-07", () => {
    const barriers: Obstacle[] = [
      { id: "left", kind: "BARRIER", x: -125, z: 0, width: 3, depth: 22, height: 7, active: true },
      { id: "right", kind: "BARRIER", x: 125, z: 0, width: 3, depth: 22, height: 7, active: true },
      { id: "top", kind: "BARRIER", x: 0, z: -125, width: 22, depth: 3, height: 7, active: true },
      { id: "bottom", kind: "BARRIER", x: 0, z: 125, width: 22, depth: 3, height: 7, active: true },
    ];
    const separatedPlayers = players();
    const runnerPositions = [{ x: 250, z: 0 }, { x: -250, z: 0 }, { x: 0, z: 250 }];
    separatedPlayers.filter((player) => player.role === "RUNNER").forEach((player, index) => {
      player.position = runnerPositions[index] ?? { x: 0, z: -250 };
    });
    const testContext = context({ obstacles: barriers, players: separatedPlayers });
    const patch = createFixturePatchCandidates(1, testContext)[2] as MapPatch;
    const operation = patch.operations[0];
    if (operation?.type === "open_alley") operation.edge.active = false;
    expect(evaluatePatch(patch, testContext).violations.map((violation) => violation.id)).toContain("F-07");
  });

  it("enforces update budget F-08", () => {
    const patch = validPatch();
    const operation = patch.operations[0];
    if (operation === undefined) throw new Error("operation fixture missing");
    operation.obstacle.width = 1_500;
    operation.obstacle.depth = 1_500;
    expect(evaluatePatch(patch, context()).violations.map((violation) => violation.id)).toContain("F-08");
  });

  it("rejects stale versions and duplicate patch IDs", () => {
    const patch = validPatch();
    const testContext = context({ currentMapVersion: 2, appliedPatchIds: new Set([patch.patchId]) });
    const violations = evaluatePatch(patch, testContext).violations.map((violation) => violation.id);
    expect(violations).toContain("VERSION");
    expect(violations).toContain("DUPLICATE");
  });
});
