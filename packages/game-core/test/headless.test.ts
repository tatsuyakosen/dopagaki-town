import { describe, expect, it } from "vitest";
import { chunkAtPosition, chunkId, pointCollides } from "@dopagaki/world-core";
import { checksumOf, createGame, replaceBotWithHuman, startGame, stepGame } from "../src/index.js";

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
  }, 30_000);

  it("completes a full ten-minute 5km match without Bot/building overlap", () => {
    const game = createGame({ seed: 20260827 });
    startGame(game);
    let steps = 0;
    while (game.status === "RUNNING") {
      stepGame(game, {}, 50);
      steps += 1;
      if (steps % 20 === 0) {
        for (const player of game.players) {
          const playerChunkId = chunkId(chunkAtPosition(game.world, player.position));
          const nearbyObstacles = game.staticObstaclesByChunk.get(playerChunkId) ?? [];
          expect(
            pointCollides([...nearbyObstacles, ...game.obstacles], player.position, 1.3),
            `${player.id} collided at ${player.position.x},${player.position.z}`,
          ).toBe(false);
        }
      }
    }

    expect(game.nowMs).toBe(600_000);
    expect(game.mapVersion).toBeGreaterThan(20);
    expect(game.players.filter((player) => player.role === "ONI")).toHaveLength(1);
  });

  it("moves from one 5km edge to the other and back without boundary drift", () => {
    const game = createGame({
      seed: 20260827,
      durationMs: 12_000,
      patchIntervalMs: 60_000,
      humanSpeedMultiplier: 100,
    });
    const human = replaceBotWithHuman(game, "human-traversal", "Traversal Tester");
    human.position = { x: 0, z: -2_498 };
    startGame(game);
    const visitedChunks = new Set<string>();

    for (let index = 0; index < 96; index += 1) {
      stepGame(game, { [human.id]: { x: 0, z: 1, sprint: false } }, 50);
      visitedChunks.add(chunkId(chunkAtPosition(game.world, human.position)));
    }
    expect(human.position.z).toBeGreaterThan(2_450);
    expect(human.position.x).toBe(0);

    for (let index = 0; index < 96; index += 1) {
      stepGame(game, { [human.id]: { x: 0, z: -1, sprint: false } }, 50);
      visitedChunks.add(chunkId(chunkAtPosition(game.world, human.position)));
    }
    expect(human.position.z).toBeLessThan(-2_400);
    expect(human.position.x).toBe(0);
    expect(visitedChunks.size).toBeGreaterThanOrEqual(20);
  });
});
