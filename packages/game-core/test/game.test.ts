import { describe, expect, it } from "vitest";
import {
  TAG_PROTECTION_MS,
  checksumOf,
  createGame,
  replaceBotWithHuman,
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
});

