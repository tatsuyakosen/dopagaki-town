import { describe, expect, it } from "vitest";
import { MatchRoom, ONI_TAKEOVER_MS, RECONNECT_WINDOW_MS } from "../src/room.js";

function roomFixture(): {
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
  });
  return {
    room,
    advance(milliseconds: number): void {
      now += milliseconds;
    },
  };
}

describe("authoritative reconnect room", () => {
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

  it("keeps a reserved fare exactly once across disconnect and reconnect", () => {
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

  it("sends the fixed transit graph separately from 10Hz snapshots", () => {
    const { room } = roomFixture();

    expect(room.snapshot().transitGraph.timetable.length).toBeGreaterThan(0);
    expect("transitGraph" in room.networkSnapshot()).toBe(false);
  });
});
