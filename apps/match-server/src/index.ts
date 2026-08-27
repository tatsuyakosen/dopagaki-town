import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ClientMessageSchema,
  encodeMessage,
  type Movement,
  type ServerMessage,
} from "@dopagaki/contracts";
import {
  createGame,
  letBotTakeOver,
  replaceBotWithHuman,
  snapshotOf,
  startGame,
  stepGame,
  type GameState,
} from "@dopagaki/game-core";
import { WebSocket, WebSocketServer } from "ws";

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

interface ClientState {
  playerId: string | null;
  displayName: string;
  input: Movement;
}

let seed = INITIAL_SEED;
let game = newGame(seed);
let playerSequence = 0;
const clients = new Map<WebSocket, ClientState>();

function newGame(nextSeed: number): GameState {
  return createGame({
    seed: nextSeed,
    durationMs: MATCH_DURATION_MS,
    patchIntervalMs: PATCH_INTERVAL_MS,
    humanSpeedMultiplier: HUMAN_SPEED_MULTIPLIER,
  });
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(encodeMessage(message));
}

function sendSnapshot(socket: WebSocket): void {
  send(socket, { type: "SNAPSHOT", snapshot: snapshotOf(game) });
}

function broadcastSnapshot(): void {
  const message: ServerMessage = { type: "SNAPSHOT", snapshot: snapshotOf(game) };
  const payload = encodeMessage(message);
  for (const socket of clients.keys()) {
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  }
}

function restartGame(): void {
  seed += 1;
  game = newGame(seed);
  for (const [socket, client] of clients) {
    if (client.playerId === null) continue;
    replaceBotWithHuman(game, client.playerId, client.displayName);
    send(socket, { type: "WELCOME", playerId: client.playerId, matchId: game.matchId });
  }
  if ([...clients.values()].some((client) => client.playerId !== null)) startGame(game);
  broadcastSnapshot();
}

function joinGame(socket: WebSocket, client: ClientState, playerName?: string): void {
  if (client.playerId !== null) {
    send(socket, { type: "WELCOME", playerId: client.playerId, matchId: game.matchId });
    sendSnapshot(socket);
    return;
  }
  if (game.status === "FINISHED") restartGame();
  playerSequence += 1;
  const playerId = `human-${playerSequence}`;
  const displayName = playerName ?? `Player ${playerSequence}`;
  try {
    replaceBotWithHuman(game, playerId, displayName);
  } catch (error) {
    send(socket, { type: "ERROR", message: error instanceof Error ? error.message : "Room is full" });
    return;
  }
  client.playerId = playerId;
  client.displayName = displayName;
  send(socket, { type: "WELCOME", playerId, matchId: game.matchId });
  if (game.status === "WAITING") startGame(game);
  broadcastSnapshot();
}

function handleMessage(socket: WebSocket, client: ClientState, payload: string): void {
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    send(socket, { type: "ERROR", message: "JSONを解釈できません" });
    return;
  }
  const parsed = ClientMessageSchema.safeParse(decoded);
  if (!parsed.success) {
    send(socket, { type: "ERROR", message: "不正なメッセージです" });
    return;
  }

  switch (parsed.data.type) {
    case "JOIN":
      joinGame(socket, client, parsed.data.playerName);
      break;
    case "INPUT":
      if (client.playerId !== null) client.input = parsed.data.movement;
      break;
    case "RESTART":
      if (game.status === "FINISHED") restartGame();
      break;
    case "PING":
      send(socket, { type: "PONG", sentAt: parsed.data.sentAt });
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
    response.end(JSON.stringify({ ok: true, status: game.status, clients: clients.size }));
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
  const client: ClientState = {
    playerId: null,
    displayName: "Player",
    input: { x: 0, z: 0, sprint: false },
  };
  clients.set(socket, client);
  socket.on("message", (data) => {
    let payload: string;
    if (Array.isArray(data)) payload = Buffer.concat(data).toString("utf8");
    else if (data instanceof ArrayBuffer) payload = Buffer.from(new Uint8Array(data)).toString("utf8");
    else payload = data.toString("utf8");
    handleMessage(socket, client, payload);
  });
  socket.on("close", () => {
    clients.delete(socket);
    if (client.playerId !== null) letBotTakeOver(game, client.playerId);
  });
  socket.on("error", () => {
    socket.close();
  });
});

setInterval(() => {
  const inputs: Record<string, Movement> = {};
  for (const client of clients.values()) {
    if (client.playerId !== null) inputs[client.playerId] = client.input;
  }
  stepGame(game, inputs, TICK_MS);
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
