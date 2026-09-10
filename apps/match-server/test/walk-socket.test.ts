import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocket, type RawData } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { attachWalkSocket } from "../src/walk-socket.js";
import type { WalkServerMessage } from "../../../packages/contracts/src/social.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture() {
  const server = createServer(); const dispose = attachWalkSocket(server);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sockets: WebSocket[] = [];
  cleanup.push(async () => { sockets.forEach(s => s.terminate()); dispose(); await new Promise<void>(done => server.close(() => done())); });
  const connect = async () => {
    const socket = new WebSocket(`ws://${address}/ws/walk`, { origin: `http://${address}` }); sockets.push(socket);
    await once(socket, "open"); return socket;
  };
  return { connect, address, sockets };
}
function next<T extends WalkServerMessage["type"]>(socket: WebSocket, type: T, predicate: (m: Extract<WalkServerMessage, { type: T }>) => boolean = () => true): Promise<Extract<WalkServerMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off("message", handler); reject(new Error(`Timed out: ${type}`)); }, 3000);
    const handler = (data: RawData) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
      const message = JSON.parse(bytes.toString()) as WalkServerMessage;
      if (message.type === type && predicate(message as Extract<WalkServerMessage, { type: T }>)) {
        clearTimeout(timeout); socket.off("message", handler); resolve(message as Extract<WalkServerMessage, { type: T }>);
      }
    };
    socket.on("message", handler);
  });
}
describe("walk WebSocket transport", () => {
  it("creates, invites, synchronizes poses and chats, and reconnects over real sockets", async () => {
    const { connect } = await fixture(); const a = await connect();
    const first = next(a, "WELCOME"); a.send(JSON.stringify({ type: "CREATE", stage: "fixture", name: "A" })); const host = await first;
    const b = await connect(); const joined = next(b, "WELCOME");
    b.send(JSON.stringify({ type: "JOIN", room: host.room, stage: "fixture", name: "B" })); const guest = await joined;
    const movement = next(b, "STATE", s => s.peers.some(p => p.id === host.playerId && p.pose.x === 15));
    a.send(JSON.stringify({ type: "POSE", seq: 1, pose: { x: 15, y: 1, z: 0, yaw: .2, paused: false } })); await movement;
    const chat = next(a, "STATE", s => s.chats.some(c => c.text === "待ってるよ"));
    b.send(JSON.stringify({ type: "CHAT", text: "待ってるよ" })); expect((await chat).chats.at(-1)?.name).toBe("B");
    b.close(); await once(b, "close");
    const again = await connect(); const resumed = next(again, "WELCOME");
    again.send(JSON.stringify({ type: "JOIN", room: host.room, stage: "fixture", name: "B", token: guest.token }));
    expect((await resumed).playerId).toBe(guest.playerId);
  });
  it("rejects cross-origin handshakes and malformed commands", async () => {
    const { address, sockets, connect } = await fixture();
    const bad = new WebSocket(`ws://${address}/ws/walk`, { origin: "https://unrelated.example" }); sockets.push(bad);
    const error = await new Promise<Error>(done => bad.once("error", done)); expect(error.message).toContain("403");
    const socket = await connect(); const reply = next(socket, "ERROR"); socket.send("not-json"); expect((await reply).code).toBe("BAD_MESSAGE");
  });
  it("closes oversized and flooding connections", async () => {
    const { connect } = await fixture(); const large = await connect();
    const closed = once(large, "close"); large.send("x".repeat(3000)); expect((await closed)[0]).toBe(1009);
    const flood = await connect(); const limited = once(flood, "close");
    for (let i = 0; i < 35; i++) flood.send(JSON.stringify({ type: "LEAVE" }));
    expect((await limited)[0]).toBe(1008);
  });
});
