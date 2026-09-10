import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { createServer, preview } from "vite";
import { WebSocket, type RawData } from "ws";
import { WalkStageSchema, type WalkServerMessage } from "../packages/contracts/src/social.js";

function next<T extends WalkServerMessage["type"]>(socket: WebSocket, type: T, check: (value: Extract<WalkServerMessage, { type: T }>) => boolean = () => true): Promise<Extract<WalkServerMessage, { type: T }>> {
  return new Promise((done, reject) => {
    const timeout = setTimeout(() => { socket.off("message", receive); reject(new Error("SHARED_WALK_TIMEOUT")); }, 5000);
    const receive = (data: RawData) => {
      const buffer = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
      const value = JSON.parse(buffer.toString()) as WalkServerMessage;
      if (value.type === "ERROR") { clearTimeout(timeout); socket.off("message", receive); reject(new Error(value.code)); return; }
      if (value.type === type && check(value as Extract<WalkServerMessage, { type: T }>)) {
        clearTimeout(timeout); socket.off("message", receive); done(value as Extract<WalkServerMessage, { type: T }>);
      }
    };
    socket.on("message", receive);
  });
}
async function verify(): Promise<void> {
  const stage = WalkStageSchema.parse(process.argv[2] ?? "fixture");
  for (const mode of ["development", "preview"] as const) {
    const configFile = resolve("apps/game-client/vite.config.ts");
    const app = mode === "development"
      ? await createServer({ configFile, logLevel: "error", server: { host: "127.0.0.1", port: 0, strictPort: false } })
      : await preview({ configFile, logLevel: "error", preview: { host: "127.0.0.1", port: 0, strictPort: false } });
    if ("listen" in app) await app.listen();
    const server = app.httpServer!;
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const sockets: WebSocket[] = [];
    try {
      const page = await fetch(`${origin}/walk.html`); assert.equal(page.status, 200); assert((await page.text()).includes('id="social-panel"'));
      if (stage !== "fixture") {
        const response = await fetch(`${origin}/api/city/stages/${stage}`); assert.equal(response.status, 200);
        const manifest = await response.json() as { mode: string }; assert.equal(manifest.mode, "survey");
      }
      const connect = async () => {
        const socket = new WebSocket(`${origin.replace("http:", "ws:")}/ws/walk`, { origin }); sockets.push(socket); await once(socket, "open"); return socket;
      };
      const host = await connect(), first = next(host, "WELCOME");
      host.send(JSON.stringify({ type: "CREATE", stage, name: "Host" })); const welcome = await first;
      for (let i = 1; i < 4; i++) {
        const guest = await connect(), joined = next(guest, "WELCOME");
        guest.send(JSON.stringify({ type: "JOIN", room: welcome.room, stage, name: `Guest ${i}` })); await joined;
      }
      const four = await next(host, "STATE", state => state.peers.length === 4); assert.equal(four.peers.length, 4);
      const begin = performance.now();
      const synced = next(sockets[3]!, "STATE", state => state.peers.find(p => p.id === welcome.playerId)?.pose.x === 10);
      host.send(JSON.stringify({ type: "POSE", seq: 1, pose: { x: 10, y: 3, z: 5, yaw: 0, paused: false } }));
      const state = await synced; const latencyMs = Math.round(performance.now() - begin);
      const chatted = next(sockets[2]!, "STATE", state => state.chats.at(-1)?.text === "同じ街で合流");
      sockets[1]!.send(JSON.stringify({ type: "CHAT", text: "同じ街で合流" })); await chatted;
      assert(!JSON.stringify(state).includes(welcome.token));
      console.log(JSON.stringify({ mode, data: stage === "fixture" ? "synthetic" : "survey-cache", players: 4,
        result: "passed", snapshotBytes: Buffer.byteLength(JSON.stringify(state)), localPoseDeliveryMs: latencyMs,
        scope: "HTTP + WebSocket only; no WebGL, rendered avatars, or measured FPS" }));
    } finally {
      for (const socket of sockets) socket.terminate();
      if ("close" in app) await app.close();
      else await new Promise<void>(done => server.close(() => done()));
    }
  }
}
void verify().catch(() => { console.error("SHARED_WALK_VERIFICATION_FAILED"); process.exitCode = 1; });
