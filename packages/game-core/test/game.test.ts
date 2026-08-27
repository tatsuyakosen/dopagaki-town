import { describe, expect, it } from "vitest";
import {
  TAG_PROTECTION_MS,
  acknowledgeMapChecksum,
  checksumOf,
  createGame,
  gameCheckpointOf,
  markHumanDisconnected,
  replaceBotWithHuman,
  restoreGame,
  restoreHumanControl,
  snapshotOf,
  startGame,
  stepGame,
} from "../src/index.js";

describe("authoritative tag rules", () => {
  it("replaces a runner Bot with the first human", () => {
    const game = createGame({ seed: 20260827, durationMs: 5_000 });
    const player = replaceBotWithHuman(game, "human-1", "Player");

    expect(player.kind).toBe("HUMAN");
    expect(player.role).toBe("RUNNER");
    expect(game.players.filter((item) => item.kind === "BOT")).toHaveLength(3);
  });

  it("changes the oni once and applies the three-second tag lock", () => {
    const game = createGame({ seed: 7, durationMs: 10_000 });
    startGame(game);
    for (const player of game.players) player.kind = "HUMAN";
    const oni = game.players.find((player) => player.role === "ONI");
    const runner = game.players.find((player) => player.role === "RUNNER");
    expect(oni).toBeDefined();
    expect(runner).toBeDefined();
    if (oni === undefined || runner === undefined) return;
    oni.position = { x: 0, z: 0 };
    runner.position = { x: 0.5, z: 0 };

    stepGame(game, {}, 50);

    expect(oni.role).toBe("RUNNER");
    expect(runner.role).toBe("ONI");
    expect(game.tagLockedUntilMs).toBe(game.nowMs + TAG_PROTECTION_MS);
    expect(game.players.filter((player) => player.role === "ONI")).toHaveLength(1);
  });

  it("finishes with the shortest oni duration as winner", () => {
    const game = createGame({ seed: 10, durationMs: 500 });
    startGame(game);
    for (let elapsed = 0; elapsed < 500; elapsed += 50) stepGame(game, {}, 50);

    const minimum = Math.min(...game.players.map((player) => player.oniDurationMs));
    const winner = game.players.find((player) => player.id === game.winnerId);
    expect(game.status).toBe("FINISHED");
    expect(winner?.oniDurationMs).toBe(minimum);
  });

  it("produces the same checksum for the same seed and inputs", () => {
    const run = (): string => {
      const game = createGame({ seed: 99, durationMs: 2_000, patchIntervalMs: 700 });
      startGame(game);
      while (game.status === "RUNNING") stepGame(game, {}, 50);
      return checksumOf(game);
    };

    expect(run()).toBe(run());
  });

  it("keeps a human outside an active CITY CORE barrier collider", () => {
    const game = createGame({ seed: 20260827, durationMs: 10_000 });
    const human = replaceBotWithHuman(game, "human-collider", "Collider Tester");
    for (const player of game.players) player.kind = "HUMAN";
    for (const obstacle of game.obstacles) {
      if (obstacle.kind === "BARRIER") obstacle.active = obstacle.id === "barrier-0";
    }
    human.position = { x: -58, z: 0 };
    startGame(game);

    for (let index = 0; index < 30; index += 1) {
      stepGame(game, {
        [human.id]: { x: 1, z: 0, sprint: false },
      }, 50);
    }

    expect(human.position.x).toBeLessThan(-52.8);
  });

  it("activates the collider only after the warning interval completes", () => {
    const game = createGame({ seed: 20260827, durationMs: 7_000, patchIntervalMs: 6_000 });
    startGame(game);
    while (game.nowMs < 5_950) stepGame(game, {}, 50);
    expect(game.cityCore.warningStartedAtMs).not.toBeNull();
    expect(game.cityCore.patchPhase).toBe("PREPARED");
    expect(game.cityCore.affectedChunkIds).toHaveLength(2);
    expect(game.obstacles.filter((obstacle) => obstacle.kind === "BARRIER" && obstacle.active)).toHaveLength(0);

    stepGame(game, {}, 50);
    expect(game.mapVersion).toBe(2);
    expect(game.cityCore.patchPhase).toBe("IDLE");
    expect(game.obstacles.filter((obstacle) => obstacle.kind === "BARRIER" && obstacle.active)).toHaveLength(1);
  });

  it("applies all three allowlisted operations with rejected candidates in AI Replay", () => {
    const game = createGame({ seed: 20260827, durationMs: 18_000, patchIntervalMs: 6_000 });
    startGame(game);
    while (game.status === "RUNNING") stepGame(game, {}, 50);

    const commits = game.aiReplay.filter((entry) => entry.phase === "PATCH_COMMITTED");
    const decisions = game.aiReplay.filter((entry) => entry.phase === "CANDIDATES_EVALUATED");
    expect(commits.map((entry) => entry.summary)).toEqual(expect.arrayContaining([
      expect.stringContaining("raise_barrier"),
      expect.stringContaining("open_alley"),
      expect.stringContaining("spawn_rooftop_bridge"),
    ]));
    expect(decisions).toHaveLength(3);
    for (const decision of decisions) {
      expect(decision.candidates).toHaveLength(3);
      expect(decision.candidates[0]?.violations.map((violation) => violation.id)).toContain("F-06");
      expect(decision.selectedPatchId).toBe(decision.candidates[2]?.patch.patchId);
    }
    expect(game.mapVersion).toBe(4);
    expect(game.navigationEdges.some((edge) => edge.kind === "ALLEY" && edge.active)).toBe(true);
    expect(game.navigationEdges.some((edge) => edge.kind === "BRIDGE" && edge.active)).toBe(true);
    expect(game.obstacles.find((obstacle) => obstacle.id === "alley-gate-core")?.active).toBe(false);
    expect(game.obstacles.find((obstacle) => obstacle.id === "bridge-core")?.active).toBe(true);
  });

  it("rolls back to the previous MapVersion on a client checksum mismatch", () => {
    for (let seed = 1; seed <= 10; seed += 1) {
      const game = createGame({ seed, durationMs: 7_000, patchIntervalMs: 6_000 });
      startGame(game);
      while (game.mapVersion === 1 && game.status === "RUNNING") stepGame(game, {}, 50);
      const patchId = game.cityCore.lastAppliedPatchId;
      expect(patchId).not.toBeNull();
      if (patchId === null) continue;

      expect(acknowledgeMapChecksum(game, "client-bad", patchId, 2, "deadbeef")).toBe(false);
      expect(game.mapVersion).toBe(1);
      expect(game.rollbackCount).toBe(1);
      expect(game.aiReplay.at(-1)?.phase).toBe("ROLLBACK");
    }
  });

  it("reproduces a CITY CORE-assisted tag with the CITY_CORE strategy Bot", () => {
    const game = createGame({ seed: 20260827, durationMs: 2_000, patchIntervalMs: 6_000 });
    const cityBot = game.players.find((player) => player.strategy === "CITY_CORE");
    const oni = game.players.find((player) => player !== cityBot);
    expect(cityBot).toBeDefined();
    expect(oni).toBeDefined();
    if (cityBot === undefined || oni === undefined) return;
    for (const player of game.players) player.kind = "HUMAN";
    startGame(game);
    stepGame(game, {}, 50);
    for (const player of game.players) player.role = "RUNNER";
    oni.role = "ONI";
    cityBot.kind = "BOT";
    oni.kind = "BOT";
    cityBot.position = { ...game.cityCore.target };
    oni.position = { x: game.cityCore.target.x + 2.5, z: game.cityCore.target.z };
    stepGame(game, {}, 50);

    expect(cityBot.role).toBe("ONI");
    expect(game.cityCoreTagCount).toBe(1);
    expect(game.aiReplay.at(-1)?.phase).toBe("TAG_CHANGED");
  });

  it("stops and excludes a disconnected human from tag resolution until restored", () => {
    const game = createGame({ seed: 20260827, durationMs: 2_000, patchIntervalMs: 6_000 });
    const human = replaceBotWithHuman(game, "human-reconnect", "Reconnect Runner");
    const target = game.players.find((player) => player.id !== human.id);
    expect(target).toBeDefined();
    if (target === undefined) return;
    for (const player of game.players) player.role = "RUNNER";
    human.role = "ONI";
    human.position = { x: 0, z: 0 };
    target.position = { x: 2, z: 0 };
    startGame(game);
    markHumanDisconnected(game, human.id);

    stepGame(game, {}, 1_000);
    expect(human.position).toEqual({ x: 0, z: 0 });
    expect(human.role).toBe("ONI");
    expect(target.role).toBe("RUNNER");

    restoreHumanControl(game, human.id, "Reconnect Runner");
    stepGame(game, {}, 50);
    expect(human.role).toBe("RUNNER");
    expect(target.role).toBe("ONI");
  });

  it("restores a prepared intervention checkpoint deterministically", () => {
    const original = createGame({ seed: 20260827, durationMs: 8_000, patchIntervalMs: 6_000 });
    startGame(original);
    stepGame(original, {}, 50);
    expect(original.cityCore.patchPhase).toBe("PREPARED");

    const restored = restoreGame(gameCheckpointOf(original));
    expect(snapshotOf(restored)).toEqual(snapshotOf(original));
    while (original.status === "RUNNING") {
      stepGame(original, {}, 50);
      stepGame(restored, {}, 50);
    }
    expect(checksumOf(restored)).toBe(checksumOf(original));
  });
});
