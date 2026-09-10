import { describe, expect, it } from "vitest";
import { WalkHub, WALK_LIMITS } from "../src/walk-hub.js";
import { WalkClientSchema, type WalkServerMessage } from "../../../packages/contracts/src/social.js";

function setup() {
  let time = 10_000;
  const hub = new WalkHub(() => Promise.resolve({ halfSize: 125, spawn: [0, 1, 0] }), () => time);
  const inbox = new Map<string, WalkServerMessage[]>();
  const add = (id: string): WalkServerMessage[] => {
    const messages: WalkServerMessage[] = []; inbox.set(id, messages); hub.connect(id, m => messages.push(structuredClone(m))); return messages;
  };
  const welcome = (id: string) => inbox.get(id)!.find((m): m is Extract<WalkServerMessage, { type: "WELCOME" }> => m.type === "WELCOME")!;
  const state = (id: string) => inbox.get(id)!.filter((m): m is Extract<WalkServerMessage, { type: "STATE" }> => m.type === "STATE").at(-1)!;
  return { hub, add, welcome, state, advance: (ms: number) => { time += ms; hub.tick(); } };
}

describe("shared city walk", () => {
  it("isolates rooms, binds the exact stage, and never broadcasts reconnect tokens", async () => {
    const { hub, add, welcome, state } = setup();
    add("a"); add("b"); add("other"); const wrong = add("wrong");
    await hub.handle("a", { type: "CREATE", stage: "fixture", name: "A" });
    await hub.handle("other", { type: "CREATE", stage: "fixture", name: "Other" });
    await hub.handle("b", { type: "JOIN", stage: "fixture", room: welcome("a").room, name: "B" });
    await hub.handle("wrong", { type: "JOIN", stage: "a".repeat(24), room: welcome("a").room, name: "Wrong" });
    expect(wrong.at(-1)).toEqual({ type: "ERROR", code: "STAGE_MISMATCH" });
    await hub.handle("a", { type: "CHAT", text: "ここで待ってる" });
    expect(state("b").chats[0]?.text).toBe("ここで待ってる");
    expect(state("other").chats).toEqual([]);
    expect(state("b").peers).toHaveLength(2);
    expect(JSON.stringify(state("b"))).not.toContain(welcome("a").token);
  });
  it("limits rooms to four players, reserves reconnect seats, and frees them after 30 seconds", async () => {
    const { hub, add, welcome, state, advance } = setup(); add("0");
    await hub.handle("0", { type: "CREATE", stage: "fixture", name: "Host" });
    const room = welcome("0").room;
    for (let i = 1; i < 4; i++) { add(`${i}`); await hub.handle(`${i}`, { type: "JOIN", stage: "fixture", room, name: `${i}` }); }
    const full = add("full"); hub.disconnect("1");
    await hub.handle("full", { type: "JOIN", stage: "fixture", room, name: "Full" });
    expect(full.at(-1)).toEqual({ type: "ERROR", code: "ROOM_FULL" });
    advance(30_001);
    await hub.handle("full", { type: "JOIN", stage: "fixture", room, name: "New" });
    expect(state("0").peers).toHaveLength(4);
    expect(new Set(state("0").peers.map(p => p.color)).size).toBe(4);
  });
  it("restores the same player and position after disconnect without duplicating membership", async () => {
    const { hub, add, welcome, state } = setup(); add("a");
    await hub.handle("a", { type: "CREATE", stage: "fixture", name: "A" });
    const first = welcome("a");
    await hub.handle("a", { type: "POSE", seq: 5, pose: { x: 10, y: 1, z: 3, yaw: 0, paused: false } });
    hub.disconnect("a"); add("again");
    await hub.handle("again", { type: "JOIN", room: first.room, stage: "fixture", token: first.token, name: "Renamed" });
    expect(welcome("again").playerId).toBe(first.playerId);
    expect(state("again").peers).toHaveLength(1);
    expect(state("again").peers[0]?.pose.x).toBe(10);
    const duplicate = add("duplicate");
    await hub.handle("duplicate", { type: "JOIN", room: first.room, stage: "fixture", token: first.token, name: "Duplicate" });
    expect(duplicate.at(-1)).toEqual({ type: "ERROR", code: "ALREADY_CONNECTED" });
  });
  it("rejects stale poses and coordinates outside the room and bounds chat history/rate", async () => {
    const { hub, add, state, advance } = setup(); const messages = add("a");
    await hub.handle("a", { type: "CREATE", stage: "fixture", name: "A" });
    const pose = { x: 4, y: 1, z: 2, yaw: 0, paused: false };
    await hub.handle("a", { type: "POSE", seq: 2, pose });
    await hub.handle("a", { type: "POSE", seq: 1, pose: { ...pose, x: 8 } });
    await hub.handle("a", { type: "POSE", seq: 3, pose: { ...pose, x: 1000 } });
    hub.tick(); expect(state("a").peers[0]?.pose.x).toBe(4);
    await hub.handle("a", { type: "CHAT", text: "First" });
    await hub.handle("a", { type: "CHAT", text: "Flood" });
    expect(messages.at(-1)).toEqual({ type: "ERROR", code: "CHAT_RATE_LIMIT" });
    for (let i = 0; i < 30; i++) { advance(1500); await hub.handle("a", { type: "CHAT", text: `${i}` }); }
    expect(state("a").chats).toHaveLength(24);
  });
  it("releases explicit departures and expires idle rooms", async () => {
    const { hub, add, welcome, advance } = setup(); add("a");
    await hub.handle("a", { type: "CREATE", stage: "fixture", name: "A" });
    const room = welcome("a").room;
    await hub.handle("a", { type: "LEAVE" }); hub.disconnect("a"); advance(WALK_LIMITS.idleMs);
    const expired = add("late"); await hub.handle("late", { type: "JOIN", room, stage: "fixture", name: "Late" });
    expect(expired.at(-1)).toEqual({ type: "ERROR", code: "ROOM_EXPIRED" });
    expect(hub.counts.rooms).toBe(0);
  });
  it("does not leak a room when a client disconnects during stage validation", async () => {
    let resolve!: (stage: { halfSize: number; spawn: [number, number, number] }) => void;
    const hub = new WalkHub(() => new Promise(done => { resolve = done; }));
    hub.connect("a", () => {});
    const pending = hub.handle("a", { type: "CREATE", stage: "fixture", name: "A" });
    hub.disconnect("a"); resolve({ halfSize: 125, spawn: [0, 1, 0] }); await pending;
    expect(hub.counts).toEqual({ rooms: 0, connections: 0 });
  });
  it("bounds concurrent room creation and pending connections", async () => {
    const { hub, add } = setup();
    const requests = Array.from({ length: 40 }, (_, i) => { add(`${i}`); return hub.handle(`${i}`, { type: "CREATE", stage: "fixture", name: "Guest" }); });
    await Promise.all(requests); expect(hub.counts.rooms).toBe(32);
    for (let i = 40; i < 128; i++) add(`${i}`);
    expect(hub.connect("overflow", () => {})).toBe(false);
  });
  it("rejects non-finite coordinates, oversized text, unknown commands, and control characters", () => {
    expect(WalkClientSchema.safeParse({ type: "POSE", seq: 1, pose: { x: NaN, y: 0, z: 0, yaw: 0, paused: false } }).success).toBe(false);
    expect(WalkClientSchema.safeParse({ type: "CHAT", text: "x".repeat(141) }).success).toBe(false);
    expect(WalkClientSchema.safeParse({ type: "CHAT", text: "x\u202Ey" }).success).toBe(false);
    expect(WalkClientSchema.safeParse({ type: "RESTART" }).success).toBe(false);
    expect(WalkClientSchema.safeParse({ type: "CREATE", stage: "../../secret", name: "A" }).success).toBe(false);
  });
});
