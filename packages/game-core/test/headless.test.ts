import { describe, expect, it } from "vitest";
import { checksumOf, createGame, startGame, stepGame } from "../src/index.js";

function runSeed(seed: number): { checksum: string; roleCount: number; oniTime: number; mapVersion: number } {
  const game = createGame({ seed, durationMs: 10_000, patchIntervalMs: 2_500 });
  startGame(game);
  while (game.status === "RUNNING") stepGame(game, {}, 50);
  return {
    checksum: checksumOf(game),
    roleCount: game.players.filter((player) => player.role === "ONI").length,
    oniTime: game.players.reduce((sum, player) => sum + player.oniDurationMs, 0),
    mapVersion: game.mapVersion,
  };
}

describe("100-seed headless gate", () => {
  it("completes deterministically without violating core invariants", () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const first = runSeed(seed);
      const replay = runSeed(seed);
      expect(first.checksum, `seed ${seed} replay`).toBe(replay.checksum);
      expect(first.roleCount, `seed ${seed} oni count`).toBe(1);
      expect(first.oniTime, `seed ${seed} oni time`).toBe(10_000);
      expect(first.mapVersion, `seed ${seed} CITY CORE patches`).toBeGreaterThan(1);
    }
  });
});
