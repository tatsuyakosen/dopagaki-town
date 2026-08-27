import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ClientMessageSchema,
  encodeMessage,
  type ClientMessage,
  type ServerMessage,
} from "@dopagaki/contracts";
import { WebSocket, WebSocketServer } from "ws";
import { MatchRoom } from "./room.js";

const PORT = Number.parseInt(process.env.PORT ?? "3001", 10);
const MATCH_DURATION_MS = Number.parseInt(process.env.MATCH_DURATION_MS ?? "600000", 10);
const PATCH_INTERVAL_MS = Number.parseInt(process.env.PATCH_INTERVAL_MS ?? "20000", 10);
const configuredHumanSpeedMultiplier = Number.parseFloat(process.env.HUMAN_SPEED_MULTIPLIER ?? "1");
const HUMAN_SPEED_MULTIPLIER = Number.isFinite(configuredHumanSpeedMultiplier) && configuredHumanSpeedMultiplier > 0
  ? configuredHumanSpeedMultiplier
  : 1;
const TICK_MS = 50;
const SNAPSHOT_MS = 100;
const INITIAL_SEED = Number.parseInt(process.env.MATCH_SEED ?? "20260827", 10);

const room = new MatchRoom({
  seed: INITIAL_SEED,
  durationMs: MATCH_DURATION_MS,
  patchIntervalMs: PATCH_INTERVAL_MS,
  humanSpeedMultiplier: HUMAN_SPEED_MULTIPLIER,
});
let connectionSequence = 0;
const clients = new Map<WebSocket, string>();
const socketsByConnectionId = new Map<string, WebSocket>();

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(encodeMessage(message));
}

function broadcastSnapshot(): void {
  const message: ServerMessage = { type: "SNAPSHOT", snapshot: room.snapshot() };
  const payload = encodeMessage(message);
  for (const socket of clients.keys()) {
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  }
}

function restartGame(): void {
  room.restart();
  broadcastSnapshot();
}

function joinGame(
  socket: WebSocket,
  connectionId: string,
  request: Extract<ClientMessage, { type: "JOIN" }>,
): void {
  const result = room.join(connectionId, request);
  if (!result.ok) {
    send(socket, { type: "ERROR", code: result.code, message: result.message });
    return;
  }
  const { replacedConnectionId, ...welcome } = result.welcome;
  if (replacedConnectionId !== null && replacedConnectionId !== connectionId) {
    socketsByConnectionId.get(replacedConnectionId)?.close(4001, "Replaced by reconnect");
  }
  send(socket, { type: "WELCOME", ...welcome });
  broadcastSnapshot();
}

function handleMessage(socket: WebSocket, connectionId: string, payload: string): void {
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    send(socket, { type: "ERROR", code: "BAD_MESSAGE", message: "JSONを解釈できません" });
    return;
  }
  const parsed = ClientMessageSchema.safeParse(decoded);
  if (!parsed.success) {
    send(socket, { type: "ERROR", code: "BAD_MESSAGE", message: "不正なメッセージです" });
    return;
  }

  switch (parsed.data.type) {
    case "JOIN":
      joinGame(socket, connectionId, parsed.data);
      break;
    case "INPUT":
      room.setInput(connectionId, parsed.data.seq, parsed.data.movement);
      break;
    case "RESTART":
      if (room.game.status === "FINISHED") restartGame();
      break;
    case "PING":
      send(socket, { type: "PONG", sentAt: parsed.data.sentAt });
      break;
    case "PATCH_APPLIED":
      room.acknowledgePatch(
        connectionId,
        parsed.data.patchId,
        parsed.data.mapVersion,
        parsed.data.checksum,
      );
      broadcastSnapshot();
      break;
  }
}

const clientDist = normalize(join(dirname(fileURLToPath(import.meta.url)), "../../game-client/dist"));
const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const httpServer = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      status: room.game.status,
      clients: room.connectedCount(),
      sessions: room.sessionCount(),
    }));
    return;
  }

  if (!existsSync(clientDist)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Game client is not built. Run npm run dev or npm run build.");
    return;
  }

  const rawPath = request.url?.split("?")[0] ?? "/";
  const requestedPath = rawPath === "/" ? "/index.html" : rawPath;
  const safePath = normalize(requestedPath).replace(/^(\.\.(\/|\\|$))+/, "");
  let filePath = join(clientDist, safePath);
  if (!filePath.startsWith(clientDist)) {
    response.writeHead(403);
    response.end();
    return;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) filePath = join(clientDist, "index.html");
  response.writeHead(200, { "content-type": mimeTypes[extname(filePath)] ?? "application/octet-stream" });
  createReadStream(filePath).pipe(response);
});

const webSocketServer = new WebSocketServer({ noServer: true });
httpServer.on("upgrade", (request, socket, head) => {
  if (request.url !== "/ws") {
    socket.destroy();
    return;
  }
  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    webSocketServer.emit("connection", webSocket, request);
  });
});

webSocketServer.on("connection", (socket) => {
  connectionSequence += 1;
  const connectionId = `connection-${connectionSequence}`;
  clients.set(socket, connectionId);
  socketsByConnectionId.set(connectionId, socket);
  socket.on("message", (data) => {
    let payload: string;
    if (Array.isArray(data)) payload = Buffer.concat(data).toString("utf8");
    else if (data instanceof ArrayBuffer) payload = Buffer.from(new Uint8Array(data)).toString("utf8");
    else payload = data.toString("utf8");
    handleMessage(socket, connectionId, payload);
  });
  socket.on("close", () => {
    clients.delete(socket);
    socketsByConnectionId.delete(connectionId);
    room.disconnect(connectionId);
  });
  socket.on("error", () => {
    socket.close();
  });
});

setInterval(() => {
  room.tick(TICK_MS);
}, TICK_MS).unref();

setInterval(broadcastSnapshot, SNAPSHOT_MS).unref();

httpServer.listen(PORT, "0.0.0.0", () => {
  process.stdout.write(`DOPAGAKI match server listening on http://127.0.0.1:${PORT}\n`);
});

function shutdown(): void {
  webSocketServer.close();
  httpServer.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
