import { describe, expect, it } from "vitest";
import {
  TAG_PROTECTION_MS,
  acknowledgeMapChecksum,
  cancelTransit,
  checksumOf,
  createGame,
  gameCheckpointOf,
  markHumanDisconnected,
  replaceBotWithHuman,
  reserveTransit,
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

  it("reserves fare idempotently and rejects insufficient balance without changing it", () => {
    const game = createGame({ seed: 20260827, durationMs: 60_000 });
    const human = replaceBotWithHuman(game, "human-transit", "Transit Player");
    const station = game.transitGraph.stations[0];
    const departure = game.transitGraph.timetable.find((candidate) => {
      const route = game.transitGraph.routes.find((item) => item.id === candidate.routeId);
      return route?.fromStationId === station?.id;
    });
    const route = game.transitGraph.routes.find((candidate) => candidate.id === departure?.routeId);
    expect(station).toBeDefined();
    expect(departure).toBeDefined();
    expect(route).toBeDefined();
    if (station === undefined || departure === undefined || route === undefined) return;
    human.position = { ...station.position };
    human.transit.balanceYen = route.fareYen - 1;

    const rejected = reserveTransit(game, human.id, "reservation-insufficient", departure.id);
    expect(rejected).toMatchObject({ accepted: false, code: "INSUFFICIENT_BALANCE" });
    expect(human.transit.balanceYen).toBe(route.fareYen - 1);
    expect(human.transit.reservedFareYen).toBe(0);

    human.transit.balanceYen = 1_000;
    const accepted = reserveTransit(game, human.id, "reservation-ok", departure.id);
    const duplicate = reserveTransit(game, human.id, "reservation-ok", departure.id);
    expect(accepted).toMatchObject({ accepted: true, code: "RESERVED" });
    expect(duplicate).toMatchObject({ accepted: true, code: "ALREADY_RESERVED" });
    expect(human.transit.balanceYen).toBe(1_000);
    expect(human.transit.reservedFareYen).toBe(route.fareYen);
  });

  it("commits fare once, restores in-transit checkpoint, and protects arrival for three seconds", () => {
    const game = createGame({ seed: 20260827, durationMs: 60_000, patchIntervalMs: 60_000 });
    const human = replaceBotWithHuman(game, "human-trip", "Trip Player");
    const station = game.transitGraph.stations[0];
    const departure = game.transitGraph.timetable.find((candidate) => {
      const route = game.transitGraph.routes.find((item) => item.id === candidate.routeId);
      return route?.fromStationId === station?.id;
    });
    const route = game.transitGraph.routes.find((candidate) => candidate.id === departure?.routeId);
    expect(station).toBeDefined();
    expect(departure).toBeDefined();
    expect(route).toBeDefined();
    if (station === undefined || departure === undefined || route === undefined) return;
    human.position = { ...station.position };
    expect(reserveTransit(game, human.id, "reservation-trip", departure.id).accepted).toBe(true);
    startGame(game);
    while (game.nowMs < departure.departureAtMs) stepGame(game, {}, 50);
    expect(human.transit.phase).toBe("IN_TRANSIT");
    expect(human.transit.balanceYen).toBe(1_000 - route.fareYen);

    const oni = game.players.find((player) => player.id !== human.id);
    expect(oni).toBeDefined();
    if (oni === undefined) return;
    for (const player of game.players) {
      player.kind = "HUMAN";
      player.role = "RUNNER";
    }
    oni.role = "ONI";
    oni.position = { ...human.position };
    stepGame(game, {}, 50);
    expect(oni.role).toBe("ONI");
    expect(human.role).toBe("RUNNER");

    const restored = restoreGame(gameCheckpointOf(game));
    const restoredHuman = restored.players.find((player) => player.id === human.id);
    expect(restoredHuman?.transit).toEqual(human.transit);
    expect(restored.processedReservationIds).toEqual(game.processedReservationIds);
    while (game.nowMs < departure.arrivalAtMs) {
      stepGame(game, {}, 50);
      stepGame(restored, {}, 50);
    }
    expect(human.transit.phase).toBe("ARRIVING");
    expect(restoredHuman?.transit.phase).toBe("ARRIVING");
    expect(restoredHuman?.position).toEqual(human.position);
    expect(human.protectedUntilMs).toBe(game.nowMs + 3_000);
    expect(checksumOf(restored)).toBe(checksumOf(game));

    for (let elapsed = 0; elapsed < 3_000; elapsed += 50) {
      stepGame(game, {}, 50);
    }
    expect(human.transit.phase).toBe("ON_FOOT");
    expect(human.transit.balanceYen).toBe(1_000 - route.fareYen);
    expect(reserveTransit(game, human.id, "reservation-trip", departure.id)).toMatchObject({
      accepted: false,
      code: "DUPLICATE_RESERVATION",
    });
  });

  it("releases a missed or cancelled reservation without debiting fare", () => {
    const game = createGame({ seed: 20260827, durationMs: 60_000, patchIntervalMs: 60_000 });
    const human = replaceBotWithHuman(game, "human-miss", "Miss Player");
    const station = game.transitGraph.stations[0];
    const departure = game.transitGraph.timetable.find((candidate) => {
      const route = game.transitGraph.routes.find((item) => item.id === candidate.routeId);
      return route?.fromStationId === station?.id;
    });
    expect(station).toBeDefined();
    expect(departure).toBeDefined();
    if (station === undefined || departure === undefined) return;
    human.position = { ...station.position };
    expect(reserveTransit(game, human.id, "reservation-cancel", departure.id).accepted).toBe(true);
    expect(reserveTransit(game, human.id, "reservation-conflict", departure.id)).toMatchObject({
      accepted: false,
      code: "DUPLICATE_RESERVATION",
    });
    expect(cancelTransit(game, human.id, "reservation-cancel")).toMatchObject({
      accepted: true,
      code: "CANCELLED",
    });
    expect(cancelTransit(game, human.id, "reservation-cancel")).toMatchObject({
      accepted: false,
      code: "DUPLICATE_RESERVATION",
    });
    expect(reserveTransit(game, human.id, "reservation-conflict", departure.id)).toMatchObject({
      accepted: false,
      code: "DUPLICATE_RESERVATION",
    });
    expect(human.transit.balanceYen).toBe(1_000);

    expect(reserveTransit(game, human.id, "reservation-miss", departure.id).accepted).toBe(true);
    human.position = { x: -500, z: 0 };
    startGame(game);
    stepGame(game, {}, 50);
    expect(human.transit.phase).toBe("ON_FOOT");
    expect(human.transit.balanceYen).toBe(1_000);
    expect(human.transit.reservation).toBeNull();
  });

  it("releases a reservation when a disconnected player misses departure", () => {
    const game = createGame({ seed: 20260827, durationMs: 60_000, patchIntervalMs: 60_000 });
    const human = replaceBotWithHuman(game, "human-disconnected-trip", "Disconnected Player");
    const station = game.transitGraph.stations[0];
    const departure = game.transitGraph.timetable.find((candidate) => {
      const route = game.transitGraph.routes.find((item) => item.id === candidate.routeId);
      return route?.fromStationId === station?.id;
    });
    expect(station).toBeDefined();
    expect(departure).toBeDefined();
    if (station === undefined || departure === undefined) return;
    human.position = { ...station.position };
    expect(reserveTransit(game, human.id, "reservation-disconnect", departure.id).accepted).toBe(true);
    startGame(game);
    markHumanDisconnected(game, human.id);

    while (game.nowMs < departure.departureAtMs) stepGame(game, {}, 50);

    expect(human.transit.phase).toBe("ON_FOOT");
    expect(human.transit.balanceYen).toBe(1_000);
    expect(human.transit.reservedFareYen).toBe(0);
    expect(human.transit.reservation).toBeNull();
  });
});
