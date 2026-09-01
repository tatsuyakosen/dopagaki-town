import { directorVerifierContextOf } from "@dopagaki/game-core";
import { createFixturePatchCandidates } from "@dopagaki/verifier";
import { describe, expect, it, vi } from "vitest";
import {
  MatchRoom,
  ONI_TAKEOVER_MS,
  RECONNECT_WINDOW_MS,
  type MatchRoomConfig,
} from "../src/room.js";

function roomFixture(overrides: Partial<MatchRoomConfig> = {}): {
  room: MatchRoom;
  advance: (milliseconds: number) => void;
} {
  let now = 1_000_000;
  let tokenSequence = 0;
  const room = new MatchRoom({
    seed: 20260827,
    durationMs: 60_000,
    demoSeed: 777,
    demoDurationMs: 180_000,
    patchIntervalMs: 20_000,
    humanSpeedMultiplier: 1,
    now: () => now,
    tokenFactory: () => `${String(++tokenSequence).padStart(48, "0")}`,
    ...overrides,
  });
  return {
    room,
    advance(milliseconds: number): void {
      now += milliseconds;
    },
  };
}

describe("authoritative reconnect room", () => {
  it("coordinates a schema-valid mock Director response through the authoritative verifier", async () => {
    const observations: Array<Parameters<NonNullable<MatchRoomConfig["directorAdapter"]>>[0]> = [];
    const roomRef: { current: MatchRoom | null } = { current: null };
    const fixture = roomFixture({
      directorAdapter: (observation) => {
        observations.push(observation);
        observation.players[0]!.position.x = 999_999;
        const currentRoom = roomRef.current;
        if (currentRoom === null) throw new Error("Room is not ready");
        return Promise.resolve({
          requestId: observation.requestId,
          stageSpec: currentRoom.game.stageSpec,
          candidates: createFixturePatchCandidates(
            observation.sequence,
            directorVerifierContextOf(currentRoom.game),
          ),
        });
      },
    });
    const room = fixture.room;
    roomRef.current = room;
    expect(room.join("connection-director", { type: "JOIN", playerName: "Director Player" }).ok).toBe(true);

    while (room.game.nowMs < 5_000) room.tick(100);
    await vi.waitFor(() => expect(room.game.cityCore.patchPhase).toBe("PREPARED"));

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      requestId: `${room.game.matchId}:0:1`,
      matchId: room.game.matchId,
      seed: room.game.seed,
      sequence: 0,
      mapVersion: 1,
    });
    expect("displayName" in (observations[0]?.players[0] ?? {})).toBe(false);
    expect(room.game.players[0]?.position.x).not.toBe(999_999);
    expect(room.game.cityCore.activePatch?.patchId).toBe("patch-1-valid");
    const replay = room.game.aiReplay.at(-1);
    expect(replay?.summary).toContain("EXTERNAL Director");
    expect(replay?.candidates[0]?.violations.map((violation) => violation.id)).toContain("F-06");
    expect(replay?.candidates[1]?.violations.map((violation) => violation.id)).toContain("F-04");
    expect(room.directorStatus()).toMatchObject({
      requestCount: 1,
      appliedCount: 1,
      fixtureFallbackCount: 0,
      staleResponseCount: 0,
    });
  });

  it("keeps one Director request in flight and ignores its response after a Room restart", async () => {
    let settle: ((value: unknown) => void) | undefined;
    const pending = new Promise<unknown>((resolve) => {
      settle = resolve;
    });
    let requestCount = 0;
    let requestSignal: AbortSignal | undefined;
    const roomRef: { current: MatchRoom | null } = { current: null };
    const fixture = roomFixture({
      directorTimeoutMs: 10_000,
      directorAdapter: (observation, signal) => {
        requestCount += 1;
        requestSignal = signal;
        const currentRoom = roomRef.current;
        if (currentRoom === null) throw new Error("Room is not ready");
        const response = {
          requestId: observation.requestId,
          stageSpec: structuredClone(currentRoom.game.stageSpec),
          candidates: createFixturePatchCandidates(
            observation.sequence,
            directorVerifierContextOf(currentRoom.game),
          ),
        };
        return pending.then(() => response);
      },
    });
    const room = fixture.room;
    roomRef.current = room;
    expect(room.join("connection-stale", { type: "JOIN", playerName: "Stale Player" }).ok).toBe(true);
    while (room.game.nowMs < 5_000) room.tick(100);
    for (let index = 0; index < 20; index += 1) room.tick(100);
    expect(requestCount).toBe(1);
    expect(room.directorStatus()?.inFlightRequestId).not.toBeNull();

    const oldMatchId = room.game.matchId;
    room.restart();
    expect(room.game.matchId).not.toBe(oldMatchId);
    expect(requestSignal?.aborted).toBe(true);
    if (settle === undefined) throw new Error("Director request was not started");
    settle(undefined);
    await vi.waitFor(() => expect(room.directorStatus()?.staleResponseCount).toBe(1));

    expect(room.game.mapVersion).toBe(1);
    expect(room.game.cityCore.patchPhase).toBe("IDLE");
    expect(room.game.aiReplay.filter((entry) => entry.phase === "CANDIDATES_EVALUATED")).toHaveLength(0);
  });

  it("falls back to the deterministic Fixture when the mock Director response is malformed", async () => {
    const fixture = roomFixture({ directorAdapter: () => Promise.resolve({ malformed: true }) });
    expect(fixture.room.join("connection-fallback", {
      type: "JOIN",
      playerName: "Fallback Player",
    }).ok).toBe(true);
    while (fixture.room.game.nowMs < 5_000) fixture.room.tick(100);
    await vi.waitFor(() => expect(fixture.room.game.cityCore.patchPhase).toBe("PREPARED"));

    expect(fixture.room.game.cityCore.activePatch?.patchId).toBe("patch-1-valid");
    expect(fixture.room.game.aiReplay.at(-1)?.summary).toContain("FIXTURE Director");
    expect(fixture.room.directorStatus()).toMatchObject({
      requestCount: 1,
      appliedCount: 1,
      fixtureFallbackCount: 1,
    });
  });

  it("aborts a timed-out Director adapter and continues with the deterministic Fixture", async () => {
    let requestSignal: AbortSignal | undefined;
    const fixture = roomFixture({
      directorTimeoutMs: 5,
      directorAdapter: (_observation, signal) => {
        requestSignal = signal;
        return new Promise(() => undefined);
      },
    });
    expect(fixture.room.join("connection-timeout", {
      type: "JOIN",
      playerName: "Timeout Player",
    }).ok).toBe(true);
    while (fixture.room.game.nowMs < 5_000) fixture.room.tick(100);
    await vi.waitFor(() => expect(fixture.room.game.cityCore.patchPhase).toBe("PREPARED"));

    expect(requestSignal?.aborted).toBe(true);
    expect(fixture.room.game.cityCore.activePatch?.patchId).toBe("patch-1-valid");
    expect(fixture.room.directorStatus()).toMatchObject({
      requestCount: 1,
      appliedCount: 1,
      fixtureFallbackCount: 1,
      inFlightRequestId: null,
    });
  });

  it("lets the first guest select the fixed demo profile without allowing later joins to switch it", () => {
    const { room } = roomFixture();
    const first = room.join("connection-demo", {
      type: "JOIN",
      playerName: "Demo Guest",
      matchMode: "DEMO",
    });
    expect(first.ok).toBe(true);
    expect(room.matchMode).toBe("DEMO");
    expect(room.game.seed).toBe(777);
    expect(room.game.durationMs).toBe(180_000);

    const demoMatchId = room.game.matchId;
    const second = room.join("connection-standard", {
      type: "JOIN",
      playerName: "Standard Guest",
      matchMode: "STANDARD",
    });
    expect(second.ok).toBe(true);
    expect(room.matchMode).toBe("DEMO");
    expect(room.game.seed).toBe(777);
    expect(room.game.durationMs).toBe(180_000);

    room.restart();
    expect(room.matchMode).toBe("DEMO");
    expect(room.game.seed).toBe(777);
    expect(room.game.matchId).not.toBe(demoMatchId);
  });

  it("resumes the same player within 30 seconds without consuming another Bot", () => {
    const { room, advance } = roomFixture();
    const joined = room.join("connection-1", { type: "JOIN", playerName: "Reconnect Player" });
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    const { playerId, playerToken } = joined.welcome;
    const originalPosition = { ...room.game.players.find((player) => player.id === playerId)?.position };

    room.disconnect("connection-1");
    advance(5_000);
    room.tick(50);
    const disconnected = room.game.players.find((player) => player.id === playerId);
    expect(disconnected?.connected).toBe(false);
    expect(disconnected?.kind).toBe("HUMAN");
    expect(disconnected?.position).toEqual(originalPosition);

    const resumed = room.join("connection-2", {
      type: "JOIN",
      playerName: "Ignored Rename",
      playerToken,
      lastAckedEventId: room.game.lastEventId,
      mapVersion: room.game.mapVersion,
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.welcome.resumed).toBe(true);
    expect(resumed.welcome.playerId).toBe(playerId);
    expect(room.game.players.filter((player) => player.kind === "HUMAN")).toHaveLength(1);
    expect(room.game.players.filter((player) => player.kind === "BOT")).toHaveLength(3);
    expect(room.game.players.find((player) => player.id === playerId)?.displayName).toBe("Reconnect Player");
  });

  it("deduplicates input sequence numbers across a reconnect", () => {
    const { room } = roomFixture();
    const joined = room.join("connection-1", { type: "JOIN", playerName: "Input Player" });
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(room.setInput("connection-1", 7, { x: 1, z: 0, sprint: false })).toBe(true);
    expect(room.setInput("connection-1", 7, { x: -1, z: 0, sprint: false })).toBe(false);
    room.disconnect("connection-1");
    const resumed = room.join("connection-2", {
      type: "JOIN",
      playerToken: joined.welcome.playerToken,
      lastAckedEventId: 0,
      mapVersion: 1,
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.welcome.lastInputSeq).toBe(7);
    expect(room.setInput("connection-2", 6, { x: 1, z: 0, sprint: false })).toBe(false);
    expect(room.setInput("connection-2", 8, { x: 1, z: 0, sprint: false })).toBe(true);
  });

  it("treats a repeated JOIN on one connection as idempotent", () => {
    const { room } = roomFixture();
    const first = room.join("connection-1", { type: "JOIN", playerName: "Single Player" });
    const duplicate = room.join("connection-1", { type: "JOIN", playerName: "Duplicate Player" });
    expect(first.ok).toBe(true);
    expect(duplicate.ok).toBe(true);
    if (!first.ok || !duplicate.ok) return;
    expect(duplicate.welcome.playerId).toBe(first.welcome.playerId);
    expect(duplicate.welcome.playerToken).toBe(first.welcome.playerToken);
    expect(room.sessionCount()).toBe(1);
    expect(room.game.players.filter((player) => player.kind === "HUMAN")).toHaveLength(1);
  });

  it("hands a disconnected oni to a Bot after ten seconds and allows reclaim before expiry", () => {
    const { room, advance } = roomFixture();
    const joined = room.join("connection-1", { type: "JOIN", playerName: "Oni Player" });
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    const human = room.game.players.find((player) => player.id === joined.welcome.playerId);
    const oldOni = room.game.players.find((player) => player.role === "ONI");
    expect(human).toBeDefined();
    expect(oldOni).toBeDefined();
    if (human === undefined || oldOni === undefined) return;
    oldOni.role = "RUNNER";
    human.role = "ONI";

    room.disconnect("connection-1");
    advance(ONI_TAKEOVER_MS - 1);
    room.tick(50);
    expect(human.kind).toBe("HUMAN");
    advance(1);
    room.tick(50);
    expect(human.kind).toBe("BOT");

    advance(5_000);
    const resumed = room.join("connection-2", {
      type: "JOIN",
      playerToken: joined.welcome.playerToken,
      lastAckedEventId: 0,
      mapVersion: room.game.mapVersion,
    });
    expect(resumed.ok).toBe(true);
    expect(human.kind).toBe("HUMAN");
    expect(human.connected).toBe(true);
    expect(human.displayName).toBe("Oni Player");
  });

  it("expires a disconnected runner after 30 seconds", () => {
    const { room, advance } = roomFixture();
    const joined = room.join("connection-1", { type: "JOIN", playerName: "Expired Player" });
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    room.disconnect("connection-1");
    advance(RECONNECT_WINDOW_MS);
    room.tick(50);
    expect(room.sessionCount()).toBe(0);
    expect(room.game.players.find((player) => player.id === joined.welcome.playerId)?.kind).toBe("BOT");
    expect(room.join("connection-2", {
      type: "JOIN",
      playerToken: joined.welcome.playerToken,
      lastAckedEventId: 0,
      mapVersion: 1,
    })).toMatchObject({ ok: false, code: "SESSION_EXPIRED" });
  });

  it("rebuilds an in-memory Room checkpoint and accepts the same token", () => {
    const fixture = roomFixture();
    const joined = fixture.room.join("connection-1", { type: "JOIN", playerName: "Checkpoint Player" });
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    fixture.room.tick(1_000);
    const before = fixture.room.snapshot();
    const checkpoint = fixture.room.checkpoint();
    expect(checkpoint.matchMode).toBe("STANDARD");

    let restoredNow = checkpoint.capturedAtMs;
    const restored = MatchRoom.restore(checkpoint, {
      seed: checkpoint.seed,
      durationMs: 60_000,
      patchIntervalMs: 20_000,
      humanSpeedMultiplier: 1,
      now: () => restoredNow,
      tokenFactory: () => "9".repeat(48),
    });
    expect(restored.snapshot().matchId).toBe(before.matchId);
    expect(restored.snapshot().nowMs).toBe(before.nowMs);
    expect(restored.snapshot().mapVersion).toBe(before.mapVersion);
    expect(restored.matchMode).toBe("STANDARD");
    const resumed = restored.join("connection-restored", {
      type: "JOIN",
      playerToken: joined.welcome.playerToken,
      lastAckedEventId: before.lastEventId,
      mapVersion: before.mapVersion,
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.welcome.playerId).toBe(joined.welcome.playerId);
    restoredNow += 50;
    restored.tick(50);
    expect(restored.game.status).toBe("RUNNING");
  });

  it("[T-03] keeps a reserved fare exactly once across disconnect and reconnect", () => {
    const { room } = roomFixture();
    const joined = room.join("connection-1", { type: "JOIN", playerName: "Rail Player" });
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    const player = room.game.players.find((candidate) => candidate.id === joined.welcome.playerId);
    const station = room.game.transitGraph.stations[0];
    const departure = room.game.transitGraph.timetable.find((candidate) => {
      const route = room.game.transitGraph.routes.find((item) => item.id === candidate.routeId);
      return route?.fromStationId === station?.id;
    });
    expect(player).toBeDefined();
    expect(station).toBeDefined();
    expect(departure).toBeDefined();
    if (player === undefined || station === undefined || departure === undefined) return;
    player.position = { ...station.position };

    expect(room.reserveTransit("connection-1", "room-reservation", departure.id)).toMatchObject({
      accepted: true,
      code: "RESERVED",
    });
    const reservedFare = player.transit.reservedFareYen;
    room.disconnect("connection-1");
    const resumed = room.join("connection-2", {
      type: "JOIN",
      playerToken: joined.welcome.playerToken,
      lastAckedEventId: room.game.lastEventId,
      mapVersion: room.game.mapVersion,
    });
    expect(resumed.ok).toBe(true);
    expect(room.reserveTransit("connection-2", "room-reservation", departure.id)).toMatchObject({
      accepted: true,
      code: "ALREADY_RESERVED",
    });
    expect(player.transit.reservedFareYen).toBe(reservedFare);
    expect(player.transit.balanceYen).toBe(1_000);
  });

  it("[T-04] restores an in-transit Room checkpoint with the same arrival and balance", () => {
    const { room } = roomFixture();
    const joined = room.join("connection-trip", { type: "JOIN", playerName: "Checkpoint Rail Player" });
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    const player = room.game.players.find((candidate) => candidate.id === joined.welcome.playerId);
    const station = room.game.transitGraph.stations[0];
    const departure = room.game.transitGraph.timetable.find((candidate) => {
      const route = room.game.transitGraph.routes.find((item) => item.id === candidate.routeId);
      return route?.fromStationId === station?.id;
    });
    expect(player).toBeDefined();
    expect(station).toBeDefined();
    expect(departure).toBeDefined();
    if (player === undefined || station === undefined || departure === undefined) return;
    player.position = { ...station.position };
    expect(room.reserveTransit("connection-trip", "checkpoint-trip", departure.id)).toMatchObject({
      accepted: true,
      code: "RESERVED",
    });
    while (room.game.nowMs < departure.departureAtMs) room.tick(50);
    expect(player.transit.phase).toBe("IN_TRANSIT");

    const checkpoint = room.checkpoint();
    const restored = MatchRoom.restore(checkpoint, {
      seed: 20260827,
      durationMs: 60_000,
      demoSeed: 777,
      demoDurationMs: 180_000,
      patchIntervalMs: 20_000,
      humanSpeedMultiplier: 1,
      now: () => checkpoint.capturedAtMs,
      tokenFactory: () => "8".repeat(48),
    });
    const restoredPlayer = restored.game.players.find((candidate) => candidate.id === player.id);
    expect(restoredPlayer?.transit).toEqual(player.transit);
    expect(restoredPlayer?.transit.arrivalAtMs).toBe(departure.arrivalAtMs);
    expect(restoredPlayer?.transit.balanceYen).toBe(player.transit.balanceYen);

    while (restored.game.nowMs < departure.arrivalAtMs) restored.tick(50);
    expect(restoredPlayer?.transit.phase).toBe("ARRIVING");
    expect(restoredPlayer?.transit.balanceYen).toBe(player.transit.balanceYen);
  });

  it("sends the fixed transit graph separately from 10Hz snapshots", () => {
    const { room } = roomFixture();

    expect(room.snapshot().transitGraph.timetable.length).toBeGreaterThan(0);
    expect("transitGraph" in room.networkSnapshot()).toBe(false);
  });
});
