import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { CityManifestSchema } from "../../../packages/contracts/src/city.js";
import { WalkClientSchema, type WalkServerMessage } from "../../../packages/contracts/src/social.js";
import { readStage } from "../../city-builder/src/service.js";
import { createFixture } from "../../game-client/src/walk/fixture.js";
import { WalkHub } from "./walk-hub.js";

export function attachWalkSocket(server: EventEmitter, hub = new WalkHub(async stage => {
  const manifest = CityManifestSchema.parse(stage === "fixture" ? createFixture() : JSON.parse((await readStage(stage, false)).toString()) as unknown);
  if (stage !== "fixture" && manifest.mode !== "survey") throw new Error("SURVEY_REQUIRED");
  return { halfSize: manifest.playableHalfSize, spawn: manifest.spawn };
})): () => void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
  const alive = new Set<WebSocket>();
  function onUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (request.url !== "/ws/walk") return;
    let allowed = false;
    try { const origin = new URL(request.headers.origin ?? ""); allowed = ["http:", "https:"].includes(origin.protocol) && origin.host === request.headers.host; } catch { /* No browser origin. */ }
    if (!allowed || hub.counts.connections >= 128) { socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, ws => wss.emit("connection", ws));
  }
  server.on("upgrade", onUpgrade);
  wss.on("connection", (socket: WebSocket) => {
    const id = randomUUID(); let count = 0, windowStart = Date.now();
    const joinDeadline = setTimeout(() => socket.close(1008, "Join timeout"), 10_000);
    const send = (message: WalkServerMessage): void => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 64 * 1024) { socket.terminate(); return; }
      if (message.type === "WELCOME") clearTimeout(joinDeadline);
      socket.send(JSON.stringify(message));
    };
    if (!hub.connect(id, send)) { clearTimeout(joinDeadline); socket.close(1013); return; }
    alive.add(socket);
    socket.on("pong", () => alive.add(socket));
    socket.on("message", data => {
      if (Date.now() - windowStart >= 1000) { count = 0; windowStart = Date.now(); }
      if (++count > 30) { socket.close(1008, "Rate limit"); return; }
      try {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
        const parsed = WalkClientSchema.safeParse(JSON.parse(bytes.toString()) as unknown);
        if (!parsed.success) { send({ type: "ERROR", code: "BAD_MESSAGE" }); return; }
        void hub.handle(id, parsed.data);
      } catch { send({ type: "ERROR", code: "BAD_MESSAGE" }); }
    });
    socket.on("close", () => { clearTimeout(joinDeadline); alive.delete(socket); hub.disconnect(id); });
    socket.on("error", () => socket.terminate());
  });
  const snapshots = setInterval(() => hub.tick(), 100); snapshots.unref();
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!alive.delete(socket)) socket.terminate(); else socket.ping();
    }
  }, 15_000); heartbeat.unref();
  const close = (): void => {
    clearInterval(snapshots); clearInterval(heartbeat); server.off("upgrade", onUpgrade); server.off("close", close);
    for (const socket of wss.clients) socket.terminate(); wss.close();
  };
  server.once("close", close);
  return close;
}
