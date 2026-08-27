import {
  ArcRotateCamera,
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  FollowCamera,
  HemisphericLight,
  MeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import type { Mesh } from "@babylonjs/core";
import {
  ServerMessageSchema,
  encodeMessage,
  type ClientMessage,
  type MatchSnapshot,
  type Obstacle,
  type PlayerSnapshot,
} from "@dopagaki/contracts";
import "./style.css";

const canvas = document.querySelector<HTMLCanvasElement>("#renderCanvas");
if (canvas === null) throw new Error("renderCanvas is required");

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`${selector} is required`);
  return element;
}

const entryPanel = required<HTMLElement>("#entry-panel");
const hud = required<HTMLElement>("#hud");
const resultPanel = required<HTMLElement>("#result-panel");
const enterButton = required<HTMLButtonElement>("#enter-button");
const restartButton = required<HTMLButtonElement>("#restart-button");
const playerName = required<HTMLInputElement>("#player-name");
const entryError = required<HTMLElement>("#entry-error");
const roleLabel = required<HTMLElement>("#role-label");
const timeLabel = required<HTMLElement>("#time-label");
const mapVersion = required<HTMLElement>("#map-version");
const seedLabel = required<HTMLElement>("#seed-label");
const eventText = required<HTMLElement>("#event-text");
const patchWarning = required<HTMLElement>("#patch-warning");
const patchCountdown = required<HTMLElement>("#patch-countdown");
const scoreList = required<HTMLOListElement>("#score-list");
const playerPosition = required<HTMLElement>("#player-position");
const dangerBanner = required<HTMLElement>("#danger-banner");
const connectionLabel = required<HTMLElement>("#connection-label");
const resultTitle = required<HTMLElement>("#result-title");
const resultDetail = required<HTMLElement>("#result-detail");

const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
const scene = new Scene(engine);
scene.clearColor = new Color4(0.025, 0.06, 0.065, 1);
scene.fogEnabled = true;
scene.fogMode = Scene.FOGMODE_EXP2;
scene.fogDensity = 0.0085;
scene.fogColor = new Color3(0.025, 0.065, 0.07);

const overviewCamera = new ArcRotateCamera("overview", -Math.PI / 2.35, 1.03, 165, Vector3.Zero(), scene);
overviewCamera.lowerRadiusLimit = 75;
overviewCamera.upperRadiusLimit = 190;
overviewCamera.attachControl(canvas, true);
const followCamera = new FollowCamera("follow", new Vector3(0, 14, 20), scene);
followCamera.radius = 21;
followCamera.heightOffset = 10;
followCamera.rotationOffset = 180;
followCamera.cameraAcceleration = 0.08;
followCamera.maxCameraSpeed = 16;
scene.activeCamera = overviewCamera;

const ambient = new HemisphericLight("ambient", new Vector3(0, 1, 0), scene);
ambient.intensity = 0.72;
ambient.diffuse = new Color3(0.64, 0.9, 0.82);
ambient.groundColor = new Color3(0.025, 0.055, 0.06);
const moon = new DirectionalLight("moon", new Vector3(-0.45, -1, 0.4), scene);
moon.intensity = 0.9;
moon.diffuse = new Color3(0.5, 0.72, 0.75);

function material(name: string, diffuse: string, emissive?: string): StandardMaterial {
  const value = new StandardMaterial(name, scene);
  value.diffuseColor = Color3.FromHexString(diffuse);
  value.specularColor = new Color3(0.08, 0.1, 0.1);
  if (emissive !== undefined) value.emissiveColor = Color3.FromHexString(emissive);
  return value;
}

const groundMaterial = material("asphalt", "#0d2929");
groundMaterial.roughness = 1;
const ground = MeshBuilder.CreateGround("ground", { width: 180, height: 180 }, scene);
ground.material = groundMaterial;

const roadMaterial = material("road", "#173839");
const markingMaterial = material("marking", "#a9cbb8", "#183c34");
for (const offset of [-42, 0, 42]) {
  const verticalRoad = MeshBuilder.CreateBox(`road-v-${offset}`, { width: 12, depth: 180, height: 0.08 }, scene);
  verticalRoad.position.set(offset, 0.04, 0);
  verticalRoad.material = roadMaterial;
  const horizontalRoad = MeshBuilder.CreateBox(`road-h-${offset}`, { width: 180, depth: 12, height: 0.09 }, scene);
  horizontalRoad.position.set(0, 0.045, offset);
  horizontalRoad.material = roadMaterial;

  for (let line = -78; line <= 78; line += 13) {
    const verticalMark = MeshBuilder.CreateBox(`vm-${offset}-${line}`, { width: 0.18, depth: 5.4, height: 0.02 }, scene);
    verticalMark.position.set(offset, 0.1, line);
    verticalMark.material = markingMaterial;
    const horizontalMark = MeshBuilder.CreateBox(`hm-${offset}-${line}`, { width: 5.4, depth: 0.18, height: 0.02 }, scene);
    horizontalMark.position.set(line, 0.105, offset);
    horizontalMark.material = markingMaterial;
  }
}

const cityCoreMaterial = material("city-core", "#4e1d4b", "#ff43cf");
const cityCore = new TransformNode("CITY CORE", scene);
const coreBody = MeshBuilder.CreatePolyhedron("core-body", { type: 2, size: 2.4 }, scene);
coreBody.parent = cityCore;
coreBody.position.y = 4.5;
coreBody.material = cityCoreMaterial;
const coreRing = MeshBuilder.CreateTorus("core-ring", { diameter: 8, thickness: 0.13, tessellation: 48 }, scene);
coreRing.parent = cityCore;
coreRing.position.y = 2.1;
coreRing.material = cityCoreMaterial;
const targetRing = MeshBuilder.CreateTorus("patch-target", { diameter: 28, thickness: 0.18, tessellation: 64 }, scene);
targetRing.position.y = 0.25;
targetRing.material = cityCoreMaterial;
targetRing.isVisible = false;

interface PlayerVisual {
  root: TransformNode;
  body: Mesh;
  target: Vector3;
}

const playerVisuals = new Map<string, PlayerVisual>();
const obstacleVisuals = new Map<string, Mesh>();
const buildingMaterials = [
  material("building-a", "#173c3b", "#061a18"),
  material("building-b", "#204744", "#081e1c"),
  material("building-c", "#123432", "#061816"),
];
const stationMaterial = material("station", "#183b50", "#0e6b80");
const barrierMaterial = material("barrier", "#582839", "#ff365f");
const runnerMaterial = material("runner", "#168266", "#34eeb2");
const localMaterial = material("local", "#0f647c", "#45d9ff");
const oniMaterial = material("oni", "#8c2032", "#ff304f");

function hashName(value: string): number {
  return [...value].reduce((hash, char) => hash + char.charCodeAt(0), 0);
}

function syncObstacle(obstacle: Obstacle): void {
  let mesh = obstacleVisuals.get(obstacle.id);
  if (mesh === undefined) {
    mesh = MeshBuilder.CreateBox(
      obstacle.id,
      { width: obstacle.width, depth: obstacle.depth, height: obstacle.height },
      scene,
    );
    mesh.position.set(obstacle.x, obstacle.height / 2, obstacle.z);
    if (obstacle.kind === "BARRIER") mesh.material = barrierMaterial;
    else if (obstacle.kind === "STATION") mesh.material = stationMaterial;
    else mesh.material = buildingMaterials[hashName(obstacle.id) % buildingMaterials.length] ?? stationMaterial;
    obstacleVisuals.set(obstacle.id, mesh);
  }
  mesh.setEnabled(obstacle.active);
}

function createPlayerVisual(player: PlayerSnapshot): PlayerVisual {
  const root = new TransformNode(`player-${player.id}`, scene);
  const body = MeshBuilder.CreateCapsule(
    `body-${player.id}`,
    { height: 3.5, radius: 0.85, tessellation: 8, subdivisions: 2 },
    scene,
  );
  body.parent = root;
  body.position.y = 1.8;
  const ring = MeshBuilder.CreateTorus(`ring-${player.id}`, { diameter: 2.6, thickness: 0.12, tessellation: 24 }, scene);
  ring.parent = root;
  ring.position.y = 0.15;
  ring.material = player.id === localPlayerId ? localMaterial : runnerMaterial;
  const visual = {
    root,
    body,
    target: new Vector3(player.position.x, 0, player.position.z),
  };
  playerVisuals.set(player.id, visual);
  return visual;
}

function syncPlayer(player: PlayerSnapshot): void {
  const visual = playerVisuals.get(player.id) ?? createPlayerVisual(player);
  visual.target.set(player.position.x, 0, player.position.z);
  visual.body.material = player.role === "ONI" ? oniMaterial : player.id === localPlayerId ? localMaterial : runnerMaterial;
  if (Math.hypot(player.velocity.x, player.velocity.z) > 0.1) {
    visual.root.rotation.y = Math.atan2(player.velocity.x, player.velocity.z);
  }
  if (player.id === localPlayerId && followCamera.lockedTarget !== visual.body) {
    followCamera.lockedTarget = visual.body;
    scene.activeCamera = followCamera;
  }
}

let socket: WebSocket | null = null;
let localPlayerId: string | null = null;
let latestSnapshot: MatchSnapshot | null = null;
let inputSequence = 0;
let lastEventId = -1;
let enteredName = "Runner";
const keys = new Set<string>();

function socketUrl(): string {
  const configured = import.meta.env.VITE_MATCH_WS_URL as string | undefined;
  if (configured !== undefined && configured.length > 0) return configured;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  if (location.port === "5173") return `${protocol}//${location.hostname}:3001/ws`;
  return `${protocol}//${location.host}/ws`;
}

function sendMessage(message: ClientMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(encodeMessage(message));
}

function connect(): void {
  entryError.textContent = "";
  enterButton.disabled = true;
  connectionLabel.textContent = "CONNECTING";
  socket = new WebSocket(socketUrl());
  socket.addEventListener("open", () => {
    connectionLabel.textContent = "MATCH SERVER ONLINE";
    sendMessage({ type: "JOIN", playerName: enteredName });
  });
  socket.addEventListener("message", (event) => {
    let decoded: unknown;
    try {
      decoded = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const parsed = ServerMessageSchema.safeParse(decoded);
    if (!parsed.success) return;
    if (parsed.data.type === "WELCOME") {
      localPlayerId = parsed.data.playerId;
      entryPanel.hidden = true;
      hud.hidden = false;
      enterButton.disabled = false;
    } else if (parsed.data.type === "SNAPSHOT") {
      latestSnapshot = parsed.data.snapshot;
      syncSnapshot(parsed.data.snapshot);
    } else if (parsed.data.type === "ERROR") {
      entryError.textContent = parsed.data.message;
      enterButton.disabled = false;
    }
  });
  socket.addEventListener("close", () => {
    connectionLabel.textContent = "SERVER OFFLINE";
    document.body.dataset.matchStatus = "DISCONNECTED";
    if (!entryPanel.hidden) {
      entryError.textContent = "Match Serverへ接続できません。npm run dev を確認してください。";
      enterButton.disabled = false;
    }
  });
  socket.addEventListener("error", () => socket?.close());
}

function formatTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function syncScoreboard(snapshot: MatchSnapshot): void {
  const ranked = [...snapshot.players].sort((a, b) => a.oniDurationMs - b.oniDurationMs);
  scoreList.replaceChildren(
    ...ranked.map((player, index) => {
      const item = document.createElement("li");
      item.classList.toggle("oni", player.role === "ONI");
      item.classList.toggle("local", player.id === localPlayerId);
      const rank = document.createElement("span");
      rank.className = "rank";
      rank.textContent = String(index + 1).padStart(2, "0");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = `${player.role === "ONI" ? "● " : ""}${player.displayName}`;
      const score = document.createElement("span");
      score.className = "score";
      score.textContent = `${(player.oniDurationMs / 1_000).toFixed(1)}s`;
      item.append(rank, name, score);
      return item;
    }),
  );
}

function syncSnapshot(snapshot: MatchSnapshot): void {
  document.body.dataset.matchStatus = snapshot.status;
  timeLabel.textContent = formatTime(snapshot.remainingMs);
  mapVersion.textContent = `v${snapshot.mapVersion}`;
  seedLabel.textContent = String(snapshot.seed);
  for (const obstacle of snapshot.obstacles) syncObstacle(obstacle);
  for (const player of snapshot.players) syncPlayer(player);

  const localPlayer = snapshot.players.find((player) => player.id === localPlayerId);
  if (localPlayer !== undefined) {
    roleLabel.textContent = localPlayer.role === "ONI" ? "鬼 / ONI" : "逃走者";
    roleLabel.style.color = localPlayer.role === "ONI" ? "#ff6977" : "#59f5bd";
    dangerBanner.hidden = localPlayer.role !== "ONI";
    playerPosition.textContent = `X ${localPlayer.position.x.toFixed(1)} / Z ${localPlayer.position.z.toFixed(1)}`;
    playerPosition.dataset.x = localPlayer.position.x.toFixed(3);
    playerPosition.dataset.z = localPlayer.position.z.toFixed(3);
  }

  cityCore.position.x = snapshot.cityCore.position.x;
  cityCore.position.z = snapshot.cityCore.position.z;
  targetRing.position.x = snapshot.cityCore.target.x;
  targetRing.position.z = snapshot.cityCore.target.z;
  const warning = snapshot.cityCore.warningStartedAtMs !== null;
  targetRing.isVisible = warning;
  patchWarning.hidden = !warning;
  if (warning) {
    patchCountdown.textContent = `${Math.max(0, (snapshot.cityCore.patchAppliesAtMs - snapshot.nowMs) / 1_000).toFixed(1)}s`;
  }

  if (snapshot.lastEventId !== lastEventId) {
    lastEventId = snapshot.lastEventId;
    eventText.textContent = snapshot.lastEventText;
  }
  syncScoreboard(snapshot);

  if (snapshot.status === "FINISHED") {
    const winner = snapshot.players.find((player) => player.id === snapshot.winnerId);
    resultTitle.textContent = winner?.id === localPlayerId ? "YOU WIN" : `${winner?.displayName ?? "UNKNOWN"} WINS`;
    resultDetail.textContent = `鬼だった時間 ${(winner?.oniDurationMs ?? 0) / 1_000}秒。最も短い参加者が勝者です。`;
    resultPanel.hidden = false;
    dangerBanner.hidden = true;
  } else {
    resultPanel.hidden = true;
  }
}

enterButton.addEventListener("click", () => {
  enteredName = playerName.value.trim() || "Runner";
  connect();
});
playerName.addEventListener("keydown", (event) => {
  if (event.key === "Enter") enterButton.click();
});
restartButton.addEventListener("click", () => sendMessage({ type: "RESTART" }));

window.addEventListener("keydown", (event) => {
  if (["KeyW", "KeyA", "KeyS", "KeyD", "ShiftLeft", "ShiftRight"].includes(event.code)) {
    keys.add(event.code);
    event.preventDefault();
  }
});
window.addEventListener("keyup", (event) => keys.delete(event.code));
window.addEventListener("blur", () => keys.clear());

setInterval(() => {
  if (localPlayerId === null || latestSnapshot?.status !== "RUNNING") return;
  const x = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
  const z = (keys.has("KeyS") ? 1 : 0) - (keys.has("KeyW") ? 1 : 0);
  inputSequence += 1;
  sendMessage({
    type: "INPUT",
    seq: inputSequence,
    movement: { x, z, sprint: keys.has("ShiftLeft") || keys.has("ShiftRight") },
  });
}, 50);

scene.onBeforeRenderObservable.add(() => {
  for (const visual of playerVisuals.values()) {
    visual.root.position = Vector3.Lerp(visual.root.position, visual.target, 0.22);
  }
  coreBody.rotation.y += 0.018;
  coreBody.rotation.x += 0.008;
  coreRing.rotation.y += 0.014;
  targetRing.rotation.y += 0.006;
});

engine.runRenderLoop(() => scene.render());
window.addEventListener("resize", () => engine.resize());
