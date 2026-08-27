import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera.js";
import { FollowCamera } from "@babylonjs/core/Cameras/followCamera.js";
import { Engine } from "@babylonjs/core/Engines/engine.js";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { Scene } from "@babylonjs/core/scene.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import "@babylonjs/core/Meshes/instancedMesh.js";
import {
  ServerMessageSchema,
  encodeMessage,
  type ClientMessage,
  type MatchSnapshot,
  type Obstacle,
  type PlayerSnapshot,
  type WorldSpec,
} from "@dopagaki/contracts";
import {
  DEFAULT_WORLD_SPEC,
  calculateChunkWindow,
  chunkAtPosition,
  chunkId,
  computeMapChecksum,
  createChunkObstacles,
  createWorldMetadata,
  type ChunkMetadata,
  type WorldMetadata,
} from "@dopagaki/world-core";
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
const worldLabel = required<HTMLElement>("#world-label");
const seedLabel = required<HTMLElement>("#seed-label");
const eventText = required<HTMLElement>("#event-text");
const patchWarning = required<HTMLElement>("#patch-warning");
const patchCountdown = required<HTMLElement>("#patch-countdown");
const patchOperation = required<HTMLElement>("#patch-operation");
const patchReason = required<HTMLElement>("#patch-reason");
const patchEffect = required<HTMLElement>("#patch-effect");
const scoreList = required<HTMLOListElement>("#score-list");
const playerPosition = required<HTMLElement>("#player-position");
const performanceLabel = required<HTMLElement>("#performance-label");
const dangerBanner = required<HTMLElement>("#danger-banner");
const connectionLabel = required<HTMLElement>("#connection-label");
const resultTitle = required<HTMLElement>("#result-title");
const resultDetail = required<HTMLElement>("#result-detail");

const engine = new Engine(canvas, false, { preserveDrawingBuffer: false, stencil: false });
const renderScale = Number(import.meta.env.VITE_RENDER_SCALE ?? "2.25");
engine.setHardwareScalingLevel(Number.isFinite(renderScale) ? Math.max(1, renderScale) : 2.25);
const scene = new Scene(engine);
scene.skipPointerMovePicking = true;
scene.clearColor = new Color4(0.025, 0.06, 0.065, 1);
scene.fogEnabled = true;
scene.fogMode = Scene.FOGMODE_EXP2;
scene.fogDensity = 0.0025;
scene.fogColor = new Color3(0.025, 0.065, 0.07);

const overviewCamera = new ArcRotateCamera("overview", -Math.PI / 2.35, 1.03, 410, Vector3.Zero(), scene);
overviewCamera.lowerRadiusLimit = 230;
overviewCamera.upperRadiusLimit = 540;
overviewCamera.attachControl(canvas, true);
const followCamera = new FollowCamera("follow", new Vector3(0, 14, 20), scene);
followCamera.radius = 24;
followCamera.heightOffset = 12;
followCamera.rotationOffset = 180;
followCamera.cameraAcceleration = 0.08;
followCamera.maxCameraSpeed = 16;
followCamera.maxZ = 6_000;
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
const roadMaterial = material("road", "#173839");
const markingMaterial = material("marking", "#a9cbb8", "#183c34");
const alleyMaterial = material("alley", "#112f30");
const chunkMaterial = material("chunk-grid", "#1f5550", "#0e4a3d");
const poleMaterial = material("streetlight-pole", "#274442");
const lampMaterial = material("streetlight-lamp", "#ffe5a4", "#d5a839");

function createUnitBox(name: string, value: StandardMaterial): Mesh {
  const master = MeshBuilder.CreateBox(name, { size: 1 }, scene);
  master.material = value;
  master.position.y = -1_000;
  master.isPickable = false;
  return master;
}

function placeBoxInstance(
  master: Mesh,
  name: string,
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
  depth: number,
  parent?: TransformNode,
): AbstractMesh {
  const instance = master.createInstance(name);
  if (parent !== undefined) instance.parent = parent;
  instance.position.set(x, y, z);
  instance.scaling.set(width, height, depth);
  instance.isPickable = false;
  instance.freezeWorldMatrix();
  return instance;
}

const groundMaster = createUnitBox("ground-prefab", groundMaterial);
const roadMaster = createUnitBox("road-prefab", roadMaterial);
const markingMaster = createUnitBox("marking-prefab", markingMaterial);
const alleyMaster = createUnitBox("alley-prefab", alleyMaterial);
const chunkBorderMaster = createUnitBox("chunk-border-prefab", chunkMaterial);
const poleMaster = MeshBuilder.CreateCylinder(
  "streetlight-pole-prefab",
  { height: 1, diameter: 1, tessellation: 6 },
  scene,
);
poleMaster.material = poleMaterial;
poleMaster.position.y = -1_000;
const lampMaster = MeshBuilder.CreateSphere(
  "streetlight-lamp-prefab",
  { diameter: 1, segments: 4 },
  scene,
);
lampMaster.material = lampMaterial;
lampMaster.position.y = -1_000;

[groundMaterial, roadMaterial, markingMaterial, alleyMaterial, chunkMaterial, poleMaterial, lampMaterial].forEach(
  (value) => value.freeze(),
);

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
const targetRing = MeshBuilder.CreateTorus("patch-target", { diameter: 56, thickness: 0.22, tessellation: 64 }, scene);
targetRing.position.y = 0.25;
targetRing.material = cityCoreMaterial;
targetRing.isVisible = false;
const barrierPreviewMaterial = material("barrier-preview", "#6f314c", "#ff4770");
barrierPreviewMaterial.alpha = 0.5;
const barrierPreview = MeshBuilder.CreateBox("barrier-preview", { size: 1 }, scene);
barrierPreview.material = barrierPreviewMaterial;
barrierPreview.isVisible = false;

interface PlayerVisual {
  root: TransformNode;
  body: Mesh;
  target: Vector3;
}

const playerVisuals = new Map<string, PlayerVisual>();
const obstacleVisuals = new Map<string, AbstractMesh>();
const obstacleActiveStates = new Map<string, boolean>();
const buildingMaterials = [
  material("building-a", "#173c3b", "#061a18"),
  material("building-b", "#204744", "#081e1c"),
  material("building-c", "#123432", "#061816"),
];
const stationMaterial = material("station", "#183b50", "#0e6b80");
const barrierMaterial = material("barrier", "#582839", "#ff365f");
const roofMaterial = material("rooftop", "#28514d", "#092522");
const runnerMaterial = material("runner", "#168266", "#34eeb2");
const localMaterial = material("local", "#0f647c", "#45d9ff");
const oniMaterial = material("oni", "#8c2032", "#ff304f");
const buildingMasters = buildingMaterials.map((value, index) => createUnitBox(`building-prefab-${index}`, value));
const stationMaster = createUnitBox("station-prefab", stationMaterial);
const roofMaster = createUnitBox("rooftop-prefab", roofMaterial);
[...buildingMaterials, stationMaterial, barrierMaterial, roofMaterial, runnerMaterial, localMaterial, oniMaterial].forEach(
  (value) => value.freeze(),
);

function hashName(value: string): number {
  return [...value].reduce((hash, char) => hash + char.charCodeAt(0), 0);
}

function createObstacleVisual(obstacle: Obstacle, parent?: TransformNode): AbstractMesh {
  let mesh: AbstractMesh;
  if (obstacle.kind === "BUILDING") {
    const master = buildingMasters[hashName(obstacle.id) % buildingMasters.length] ?? buildingMasters[0];
    if (master === undefined) throw new Error("At least one building prefab is required");
    mesh = master.createInstance(obstacle.id);
    mesh.scaling.set(obstacle.width, obstacle.height, obstacle.depth);
    mesh.position.set(obstacle.x, obstacle.height / 2, obstacle.z);
    if (parent !== undefined) mesh.parent = parent;
    mesh.freezeWorldMatrix();
    if (hashName(obstacle.id) % 4 === 0) {
      const roof = roofMaster.createInstance(`${obstacle.id}-roof`);
      roof.scaling.set(obstacle.width * 0.72, 0.7, obstacle.depth * 0.72);
      roof.position.set(obstacle.x, obstacle.height + 0.35, obstacle.z);
      if (parent !== undefined) roof.parent = parent;
      roof.freezeWorldMatrix();
    }
  } else if (obstacle.kind === "STATION") {
    mesh = stationMaster.createInstance(obstacle.id);
    mesh.scaling.set(obstacle.width, obstacle.height, obstacle.depth);
    mesh.position.set(obstacle.x, obstacle.height / 2, obstacle.z);
    if (parent !== undefined) mesh.parent = parent;
    mesh.freezeWorldMatrix();
    const canopy = roofMaster.createInstance(`${obstacle.id}-canopy`);
    canopy.scaling.set(obstacle.width * 1.18, 0.5, obstacle.depth * 1.45);
    canopy.position.set(obstacle.x, obstacle.height + 0.25, obstacle.z);
    if (parent !== undefined) canopy.parent = parent;
    canopy.freezeWorldMatrix();
  } else {
    mesh = MeshBuilder.CreateBox(
      obstacle.id,
      { width: obstacle.width, depth: obstacle.depth, height: obstacle.height },
      scene,
    );
    mesh.position.set(obstacle.x, (obstacle.elevation ?? 0) + obstacle.height / 2, obstacle.z);
    mesh.material = obstacle.kind === "BRIDGE" ? roofMaterial : barrierMaterial;
    if (parent !== undefined) mesh.parent = parent;
    mesh.freezeWorldMatrix();
  }
  return mesh;
}

function syncObstacle(obstacle: Obstacle, shouldRender = true): void {
  let mesh = obstacleVisuals.get(obstacle.id);
  if (mesh === undefined) {
    mesh = createObstacleVisual(obstacle);
    obstacleVisuals.set(obstacle.id, mesh);
  }
  const enabled = obstacle.active && shouldRender;
  if (obstacleActiveStates.get(obstacle.id) === enabled) return;
  obstacleActiveStates.set(obstacle.id, enabled);
  mesh.setEnabled(enabled);
}

interface ChunkVisual {
  root: TransformNode;
  detailRoot: TransformNode | null;
  active: boolean;
}

const chunkVisuals = new Map<string, ChunkVisual>();
let worldMetadata: WorldMetadata | null = null;
let worldMetadataById = new Map<string, ChunkMetadata>();
let worldMetadataKey = "";
let activeChunkIds = new Set<string>();
let preloadedChunkIds = new Set<string>();
let navigationUpdateMs = 0;

function createPreloadedChunk(metadata: ChunkMetadata, world: WorldSpec): ChunkVisual {
  const root = new TransformNode(`preload-${metadata.id}`, scene);
  const half = world.chunkSizeMeters / 2;
  const left = metadata.center.x - half;
  const right = metadata.center.x + half;
  const top = metadata.center.z - half;
  const bottom = metadata.center.z + half;
  const halfRoad = world.roadWidth / 2;

  placeBoxInstance(
    groundMaster,
    `${metadata.id}-ground`,
    metadata.center.x,
    -0.02,
    metadata.center.z,
    world.chunkSizeMeters,
    0.04,
    world.chunkSizeMeters,
    root,
  );
  placeBoxInstance(roadMaster, `${metadata.id}-road-l`, left + halfRoad / 2, 0.04, metadata.center.z, halfRoad, 0.08, world.chunkSizeMeters, root);
  placeBoxInstance(roadMaster, `${metadata.id}-road-r`, right - halfRoad / 2, 0.04, metadata.center.z, halfRoad, 0.08, world.chunkSizeMeters, root);
  placeBoxInstance(roadMaster, `${metadata.id}-road-t`, metadata.center.x, 0.045, top + halfRoad / 2, world.chunkSizeMeters, 0.09, halfRoad, root);
  placeBoxInstance(roadMaster, `${metadata.id}-road-b`, metadata.center.x, 0.045, bottom - halfRoad / 2, world.chunkSizeMeters, 0.09, halfRoad, root);
  placeBoxInstance(markingMaster, `${metadata.id}-mark-l`, left + halfRoad / 2, 0.1, metadata.center.z, 0.18, 0.02, world.chunkSizeMeters - 20, root);
  placeBoxInstance(markingMaster, `${metadata.id}-mark-t`, metadata.center.x, 0.105, top + halfRoad / 2, world.chunkSizeMeters - 20, 0.02, 0.18, root);
  placeBoxInstance(chunkBorderMaster, `${metadata.id}-border-x`, metadata.center.x, 0.14, top, world.chunkSizeMeters, 0.03, 0.18, root);
  placeBoxInstance(chunkBorderMaster, `${metadata.id}-border-z`, left, 0.14, metadata.center.z, 0.18, 0.03, world.chunkSizeMeters, root);
  return { root, detailRoot: null, active: false };
}

function setChunkActive(
  visual: ChunkVisual,
  metadata: ChunkMetadata,
  world: WorldSpec,
  seed: number,
  active: boolean,
): void {
  if (visual.active === active) return;
  visual.active = active;
  if (!active) {
    visual.detailRoot?.dispose();
    visual.detailRoot = null;
    return;
  }

  const detailRoot = new TransformNode(`active-${metadata.id}`, scene);
  detailRoot.parent = visual.root;
  visual.detailRoot = detailRoot;
  for (const obstacle of createChunkObstacles(world, seed, metadata)) {
    createObstacleVisual(obstacle, detailRoot);
  }
  const alleySpan = world.chunkSizeMeters - world.roadWidth - 10;
  placeBoxInstance(alleyMaster, `${metadata.id}-alley-v`, metadata.center.x, 0.055, metadata.center.z, 8, 0.05, alleySpan, detailRoot);
  placeBoxInstance(alleyMaster, `${metadata.id}-alley-h`, metadata.center.x, 0.06, metadata.center.z, alleySpan, 0.05, 8, detailRoot);

  const lightOffset = world.chunkSizeMeters / 2 - world.roadWidth - 3;
  for (const [suffix, x, z] of [
    ["nw", metadata.center.x - lightOffset, metadata.center.z - lightOffset],
    ["se", metadata.center.x + lightOffset, metadata.center.z + lightOffset],
  ] as const) {
    const pole = poleMaster.createInstance(`${metadata.id}-pole-${suffix}`);
    pole.parent = detailRoot;
    pole.position.set(x, 2.7, z);
    pole.scaling.set(0.24, 5.4, 0.24);
    pole.freezeWorldMatrix();
    const lamp = lampMaster.createInstance(`${metadata.id}-lamp-${suffix}`);
    lamp.parent = detailRoot;
    lamp.position.set(x, 5.5, z);
    lamp.scaling.setAll(0.65);
    lamp.freezeWorldMatrix();
  }
}

function resetStreamedWorld(): void {
  for (const visual of chunkVisuals.values()) visual.root.dispose();
  chunkVisuals.clear();
  worldMetadataById.clear();
  activeChunkIds.clear();
  preloadedChunkIds.clear();
}

function syncStreamedWorld(
  world: WorldSpec,
  seed: number,
  player: Pick<PlayerSnapshot, "position" | "velocity">,
): void {
  const startedAt = performance.now();
  const metadataKey = `${seed}:${world.sizeMeters}:${world.chunksPerAxis}:${world.chunkSizeMeters}`;
  if (metadataKey !== worldMetadataKey) {
    resetStreamedWorld();
    worldMetadata = createWorldMetadata(world, seed);
    worldMetadataById = new Map(worldMetadata.chunks.map((chunk) => [chunk.id, chunk]));
    worldMetadataKey = metadataKey;
  }
  if (worldMetadata === null) return;

  const window = calculateChunkWindow(world, player.position, player.velocity);
  const nextActiveIds = new Set(window.activeIds);
  const nextPreloadedIds = new Set(window.preloadIds);
  for (const [id, visual] of chunkVisuals) {
    if (nextPreloadedIds.has(id)) continue;
    visual.root.dispose();
    chunkVisuals.delete(id);
  }
  for (const id of nextPreloadedIds) {
    const metadata = worldMetadataById.get(id);
    if (metadata === undefined) continue;
    const visual = chunkVisuals.get(id) ?? createPreloadedChunk(metadata, world);
    chunkVisuals.set(id, visual);
    setChunkActive(visual, metadata, world, seed, nextActiveIds.has(id));
  }
  activeChunkIds = nextActiveIds;
  preloadedChunkIds = nextPreloadedIds;
  navigationUpdateMs = performance.now() - startedAt;

  document.body.dataset.activeChunks = String(activeChunkIds.size);
  document.body.dataset.preloadedChunks = String(preloadedChunkIds.size);
  document.body.dataset.loadedChunks = String(chunkVisuals.size);
  document.body.dataset.worldChunks = String(worldMetadata.chunks.length);
  document.body.dataset.chunkFocus = `${window.focus.x},${window.focus.z}`;
  document.body.dataset.navigationMode = "GRAPH_COLLIDER";
  document.body.dataset.navmeshMs = navigationUpdateMs.toFixed(3);
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

function syncPlayer(player: PlayerSnapshot, shouldRender: boolean): void {
  if (!shouldRender) {
    const existing = playerVisuals.get(player.id);
    existing?.root.dispose();
    playerVisuals.delete(player.id);
    return;
  }
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
interface PersistedPlayerSession {
  playerToken: string;
  playerName: string;
  playerId: string;
  matchId: string;
  lastAckedEventId: number;
  mapVersion: number;
  lastAcknowledgedPatchKey: string;
}

const SESSION_STORAGE_KEY = "dopagaki.player-session.v1";
let lastPersistedSessionPayload = "";

function readPersistedSession(): PersistedPlayerSession | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedPlayerSession>;
    if (
      typeof parsed.playerToken !== "string" ||
      typeof parsed.playerName !== "string" ||
      typeof parsed.playerId !== "string" ||
      typeof parsed.matchId !== "string" ||
      typeof parsed.lastAckedEventId !== "number" ||
      typeof parsed.mapVersion !== "number" ||
      typeof parsed.lastAcknowledgedPatchKey !== "string"
    ) return null;
    return parsed as PersistedPlayerSession;
  } catch {
    return null;
  }
}

const persistedSession = readPersistedSession();
let playerToken: string | null = persistedSession?.playerToken ?? null;
let inputSequence = 0;
let lastEventId = persistedSession?.lastAckedEventId ?? -1;
let lastKnownMapVersion = persistedSession?.mapVersion ?? 1;
let lastKnownMatchId = persistedSession?.matchId ?? "";
let lastScoreboardUpdateAt = Number.NEGATIVE_INFINITY;
let lastAcknowledgedPatchKey = persistedSession?.lastAcknowledgedPatchKey ?? "";
let enteredName = persistedSession?.playerName ?? "Runner";
let connectionTimeoutId: number | null = null;
let reconnectTimeoutId: number | null = null;
let reconnectAttempt = 0;
let reconnectCount = 0;
const keys = new Set<string>();
const latencySamples: number[] = [];

function persistPlayerSession(): void {
  if (playerToken === null || localPlayerId === null || lastKnownMatchId.length === 0) return;
  const value: PersistedPlayerSession = {
    playerToken,
    playerName: enteredName,
    playerId: localPlayerId,
    matchId: lastKnownMatchId,
    lastAckedEventId: Math.max(0, lastEventId),
    mapVersion: lastKnownMapVersion,
    lastAcknowledgedPatchKey,
  };
  const payload = JSON.stringify(value);
  if (payload === lastPersistedSessionPayload) return;
  lastPersistedSessionPayload = payload;
  window.sessionStorage.setItem(SESSION_STORAGE_KEY, payload);
}

function clearPlayerSession(): void {
  window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
  playerToken = null;
  localPlayerId = null;
  lastKnownMatchId = "";
  lastEventId = -1;
  lastKnownMapVersion = 1;
  lastAcknowledgedPatchKey = "";
  reconnectAttempt = 0;
  lastPersistedSessionPayload = "";
  delete document.body.dataset.playerId;
}

function socketUrl(): string {
  const configured = import.meta.env.VITE_MATCH_WS_URL as string | undefined;
  if (configured !== undefined && configured.length > 0) return configured;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  if (import.meta.env.DEV) {
    const matchServerPort = String(import.meta.env.VITE_MATCH_PORT ?? "3001");
    return `${protocol}//${location.hostname}:${matchServerPort}/ws`;
  }
  return `${protocol}//${location.host}/ws`;
}

function clearConnectionTimeout(): void {
  if (connectionTimeoutId === null) return;
  window.clearTimeout(connectionTimeoutId);
  connectionTimeoutId = null;
}

function clearReconnectTimeout(): void {
  if (reconnectTimeoutId === null) return;
  window.clearTimeout(reconnectTimeoutId);
  reconnectTimeoutId = null;
}

function scheduleReconnect(): void {
  if (playerToken === null || reconnectTimeoutId !== null) return;
  const delayMs = Math.min(5_000, 250 * 2 ** Math.min(reconnectAttempt, 5));
  reconnectAttempt += 1;
  connectionLabel.textContent = `RECONNECTING ${reconnectAttempt}`;
  reconnectTimeoutId = window.setTimeout(() => {
    reconnectTimeoutId = null;
    connect();
  }, delayMs);
}

function sendMessage(message: ClientMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(encodeMessage(message));
}

function connect(): void {
  clearConnectionTimeout();
  clearReconnectTimeout();
  socket?.close();
  entryError.textContent = "";
  enterButton.disabled = true;
  connectionLabel.textContent = "CONNECTING";
  const currentSocket = new WebSocket(socketUrl());
  socket = currentSocket;
  connectionTimeoutId = window.setTimeout(() => {
    if (socket !== currentSocket) return;
    currentSocket.close();
  }, 5_000);
  currentSocket.addEventListener("open", () => {
    connectionLabel.textContent = "MATCH SERVER ONLINE";
    sendMessage({
      type: "JOIN",
      playerName: enteredName,
      ...(playerToken === null ? {} : {
        playerToken,
        lastAckedEventId: Math.max(0, lastEventId),
        mapVersion: lastKnownMapVersion,
      }),
    });
  });
  currentSocket.addEventListener("message", (event) => {
    let decoded: unknown;
    try {
      decoded = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const parsed = ServerMessageSchema.safeParse(decoded);
    if (!parsed.success) return;
    if (parsed.data.type === "WELCOME") {
      clearConnectionTimeout();
      if (lastKnownMatchId.length > 0 && lastKnownMatchId !== parsed.data.matchId) {
        lastEventId = -1;
        lastAcknowledgedPatchKey = "";
      }
      playerToken = parsed.data.playerToken;
      localPlayerId = parsed.data.playerId;
      lastKnownMatchId = parsed.data.matchId;
      lastKnownMapVersion = parsed.data.mapVersion;
      inputSequence = Math.max(inputSequence, parsed.data.lastInputSeq);
      if (parsed.data.resumed) {
        reconnectCount += 1;
        document.body.dataset.reconnectCount = String(reconnectCount);
      }
      reconnectAttempt = 0;
      document.body.dataset.playerId = localPlayerId;
      document.body.dataset.connectionState = "ONLINE";
      entryPanel.hidden = true;
      hud.hidden = false;
      enterButton.disabled = false;
      persistPlayerSession();
    } else if (parsed.data.type === "SNAPSHOT") {
      latestSnapshot = parsed.data.snapshot;
      syncSnapshot(parsed.data.snapshot);
    } else if (parsed.data.type === "ERROR") {
      entryError.textContent = parsed.data.message;
      enterButton.disabled = false;
      if (parsed.data.code === "SESSION_EXPIRED" || parsed.data.code === "INVALID_SESSION") {
        clearPlayerSession();
        entryPanel.hidden = false;
        hud.hidden = true;
        connectionLabel.textContent = "SESSION EXPIRED";
      }
    } else if (parsed.data.type === "PONG") {
      latencySamples.push(Math.max(0, Date.now() - parsed.data.sentAt));
      if (latencySamples.length > 30) latencySamples.shift();
      const sorted = [...latencySamples].sort((a, b) => a - b);
      const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
      document.body.dataset.latencyP95 = String(p95);
    }
  });
  currentSocket.addEventListener("close", () => {
    if (socket !== currentSocket) return;
    socket = null;
    clearConnectionTimeout();
    document.body.dataset.connectionState = "OFFLINE";
    document.body.dataset.matchStatus = "DISCONNECTED";
    keys.clear();
    if (playerToken !== null) {
      persistPlayerSession();
      scheduleReconnect();
    } else {
      connectionLabel.textContent = "SERVER OFFLINE";
      entryError.textContent = "Match Serverへ接続できません。npm run dev を確認してください。";
      enterButton.disabled = false;
    }
  });
  currentSocket.addEventListener("error", () => currentSocket.close());
}

window.addEventListener("dopagaki:test-disconnect", () => {
  if (import.meta.env.DEV) socket?.close(4000, "Local reconnect test");
});

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
      const offline = player.kind === "HUMAN" && !player.connected ? " [RECONNECTING]" : "";
      name.textContent = `${player.role === "ONI" ? "● " : ""}${player.displayName}${offline}`;
      const score = document.createElement("span");
      score.className = "score";
      score.textContent = `${(player.oniDurationMs / 1_000).toFixed(1)}s`;
      item.append(rank, name, score);
      return item;
    }),
  );
}

function syncSnapshot(snapshot: MatchSnapshot): void {
  if (lastKnownMatchId.length > 0 && snapshot.matchId !== lastKnownMatchId) {
    lastEventId = -1;
    lastAcknowledgedPatchKey = "";
  }
  lastKnownMatchId = snapshot.matchId;
  lastKnownMapVersion = snapshot.mapVersion;
  document.body.dataset.matchStatus = snapshot.status;
  timeLabel.textContent = formatTime(snapshot.remainingMs);
  mapVersion.textContent = `v${snapshot.mapVersion}`;
  worldLabel.textContent = `${(snapshot.world.sizeMeters / 1_000).toFixed(0)}km / ${snapshot.world.chunksPerAxis}×${snapshot.world.chunksPerAxis}`;
  seedLabel.textContent = String(snapshot.seed);
  document.body.dataset.worldSize = String(snapshot.world.sizeMeters);
  document.body.dataset.humanPlayers = String(snapshot.players.filter((player) => player.kind === "HUMAN").length);
  document.body.dataset.connectedHumans = String(
    snapshot.players.filter((player) => player.kind === "HUMAN" && player.connected).length,
  );
  document.body.dataset.lastEventId = String(snapshot.lastEventId);

  const localPlayer = snapshot.players.find((player) => player.id === localPlayerId);
  if (localPlayer !== undefined) {
    syncStreamedWorld(snapshot.world, snapshot.seed, localPlayer);
    const snapshotPlayerIds = new Set(snapshot.players.map((player) => player.id));
    for (const id of playerVisuals.keys()) {
      if (snapshotPlayerIds.has(id)) continue;
      playerVisuals.get(id)?.root.dispose();
      playerVisuals.delete(id);
    }
    for (const player of snapshot.players) {
      const playerChunkId = chunkId(chunkAtPosition(snapshot.world, player.position));
      syncPlayer(player, player.id === localPlayer.id || activeChunkIds.has(playerChunkId));
    }
    for (const obstacle of snapshot.obstacles) {
      const obstacleChunkId = chunkId(chunkAtPosition(snapshot.world, obstacle));
      syncObstacle(obstacle, preloadedChunkIds.has(obstacleChunkId));
    }
    const snapshotObstacleIds = new Set(snapshot.obstacles.map((obstacle) => obstacle.id));
    for (const [obstacleId, visual] of obstacleVisuals) {
      if (snapshotObstacleIds.has(obstacleId)) continue;
      visual.setEnabled(false);
      obstacleActiveStates.set(obstacleId, false);
    }
    roleLabel.textContent = localPlayer.role === "ONI" ? "鬼 / ONI" : "逃走者";
    roleLabel.style.color = localPlayer.role === "ONI" ? "#ff6977" : "#59f5bd";
    dangerBanner.hidden = localPlayer.role !== "ONI";
    playerPosition.textContent = `X ${localPlayer.position.x.toFixed(1)} / Z ${localPlayer.position.z.toFixed(1)}`;
    playerPosition.dataset.x = localPlayer.position.x.toFixed(3);
    playerPosition.dataset.z = localPlayer.position.z.toFixed(3);
  }

  cityCore.position.x = snapshot.cityCore.position.x;
  cityCore.position.z = snapshot.cityCore.position.z;
  const cityCoreChunkId = chunkId(chunkAtPosition(snapshot.world, snapshot.cityCore.position));
  cityCore.setEnabled(preloadedChunkIds.has(cityCoreChunkId));
  targetRing.position.x = snapshot.cityCore.target.x;
  targetRing.position.z = snapshot.cityCore.target.z;
  targetRing.scaling.setAll(snapshot.cityCore.radius / 28);
  const warning = snapshot.cityCore.warningStartedAtMs !== null;
  const targetChunkId = chunkId(chunkAtPosition(snapshot.world, snapshot.cityCore.target));
  const targetIsPreloaded = preloadedChunkIds.has(targetChunkId);
  targetRing.isVisible = warning && targetIsPreloaded;
  patchWarning.hidden = !warning;
  if (warning) {
    barrierPreview.isVisible = false;
    const remainingMs = Math.max(0, snapshot.cityCore.patchAppliesAtMs - snapshot.nowMs);
    patchCountdown.textContent = `${(remainingMs / 1_000).toFixed(1)}s`;
    const activePatch = snapshot.cityCore.activePatch;
    const operation = activePatch?.operations[0];
    if (activePatch !== null && activePatch !== undefined) {
      patchOperation.textContent = operation?.type.replaceAll("_", " ").toUpperCase() ?? "MAP PATCH";
      patchReason.textContent = activePatch.reason.replaceAll("_", " ");
      patchEffect.textContent = `R ${snapshot.cityCore.radius}m / encounter ${activePatch.expectedEffect.encounterRatePct >= 0 ? "+" : ""}${activePatch.expectedEffect.encounterRatePct}% / diversity ${activePatch.expectedEffect.routeDiversityPct >= 0 ? "+" : ""}${activePatch.expectedEffect.routeDiversityPct}%`;
    }
    const futureObstacle = operation?.obstacle;
    if (futureObstacle !== undefined && targetIsPreloaded) {
      const riseProgress = Math.max(0, Math.min(1, 1 - remainingMs / 1_000));
      const eased = riseProgress * riseProgress * (3 - 2 * riseProgress);
      barrierPreview.isVisible = true;
      barrierPreview.scaling.set(
        futureObstacle.width,
        operation?.type === "open_alley" ? futureObstacle.height * (1 - eased * 0.9) : futureObstacle.height,
        futureObstacle.depth,
      );
      const targetElevation = futureObstacle.elevation ?? 0;
      const previewY = operation?.type === "raise_barrier"
        ? -futureObstacle.height / 2 + futureObstacle.height * eased
        : operation?.type === "spawn_rooftop_bridge"
          ? targetElevation - 3 + 3 * eased + futureObstacle.height / 2
          : targetElevation + futureObstacle.height / 2;
      barrierPreview.position.set(futureObstacle.x, previewY, futureObstacle.z);
    }
  } else {
    barrierPreview.isVisible = false;
  }

  document.body.dataset.rollbackCount = String(snapshot.rollbackCount);
  document.body.dataset.mapChecksum = snapshot.mapChecksum;
  const lastAppliedPatchId = snapshot.cityCore.lastAppliedPatchId;
  if (lastAppliedPatchId !== null && localPlayerId !== null) {
    const patchKey = `${lastAppliedPatchId}:${snapshot.mapVersion}`;
    const checksum = computeMapChecksum(snapshot.mapVersion, snapshot.obstacles, snapshot.navigationEdges);
    document.body.dataset.clientMapChecksum = checksum;
    if (patchKey !== lastAcknowledgedPatchKey) {
      lastAcknowledgedPatchKey = patchKey;
      sendMessage({
        type: "PATCH_APPLIED",
        patchId: lastAppliedPatchId,
        mapVersion: snapshot.mapVersion,
        checksum,
      });
    }
  }

  if (snapshot.lastEventId > lastEventId) {
    lastEventId = snapshot.lastEventId;
    eventText.textContent = snapshot.lastEventText;
  }
  persistPlayerSession();
  if (snapshot.nowMs - lastScoreboardUpdateAt >= 250 || snapshot.status === "FINISHED") {
    lastScoreboardUpdateAt = snapshot.nowMs;
    syncScoreboard(snapshot);
  }

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
}, 75);

setInterval(() => {
  if (socket?.readyState === WebSocket.OPEN) sendMessage({ type: "PING", sentAt: Date.now() });
}, 2_000);

let lastPerformanceUpdate = 0;
let lastPredictionFrameAt = performance.now();
scene.onBeforeRenderObservable.add(() => {
  const frameNow = performance.now();
  const predictionDeltaSeconds = Math.min(0.05, Math.max(0, frameNow - lastPredictionFrameAt) / 1_000);
  lastPredictionFrameAt = frameNow;
  for (const [playerId, visual] of playerVisuals) {
    if (playerId === localPlayerId && latestSnapshot?.status === "RUNNING") {
      const inputX = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
      const inputZ = (keys.has("KeyS") ? 1 : 0) - (keys.has("KeyW") ? 1 : 0);
      const magnitude = Math.hypot(inputX, inputZ);
      const sprint = keys.has("ShiftLeft") || keys.has("ShiftRight");
      const predictedSpeed = 10.5 * (sprint ? 1.12 : 1);
      if (magnitude > 0) {
        visual.root.position.x += inputX / magnitude * predictedSpeed * predictionDeltaSeconds;
        visual.root.position.z += inputZ / magnitude * predictedSpeed * predictionDeltaSeconds;
      }
      const reconciliationError = Math.hypot(
        visual.target.x - visual.root.position.x,
        visual.target.z - visual.root.position.z,
      );
      document.body.dataset.reconciliationError = reconciliationError.toFixed(3);
      visual.root.position = Vector3.Lerp(
        visual.root.position,
        visual.target,
        reconciliationError > 25 ? 1 : 0.1,
      );
    } else {
      visual.root.position = Vector3.Lerp(visual.root.position, visual.target, 0.22);
    }
  }
  coreBody.rotation.y += 0.018;
  coreBody.rotation.x += 0.008;
  coreRing.rotation.y += 0.014;
  targetRing.rotation.y += 0.006;
  if (barrierPreview.isVisible) {
    barrierPreviewMaterial.alpha = 0.42 + Math.sin(performance.now() / 100) * 0.12;
  }
  if (performance.now() - lastPerformanceUpdate >= 500) {
    lastPerformanceUpdate = performance.now();
    const fps = engine.getFps();
    const activeMeshes = scene.getActiveMeshes().length;
    const latencyP95 = document.body.dataset.latencyP95 ?? "--";
    performanceLabel.textContent = `FPS ${fps.toFixed(0)} / RTT ${latencyP95}ms / MESH ${activeMeshes} / ${activeChunkIds.size}A ${preloadedChunkIds.size}P / NAV ${navigationUpdateMs.toFixed(1)}ms`;
    performanceLabel.dataset.fps = fps.toFixed(2);
    performanceLabel.dataset.meshes = String(activeMeshes);
    performanceLabel.dataset.activeChunks = String(activeChunkIds.size);
    performanceLabel.dataset.preloadedChunks = String(preloadedChunkIds.size);
    performanceLabel.dataset.navmeshMs = navigationUpdateMs.toFixed(3);
    const chromiumPerformance = performance as Performance & {
      memory?: { usedJSHeapSize: number };
    };
    if (chromiumPerformance.memory !== undefined) {
      document.body.dataset.heapMb = (chromiumPerformance.memory.usedJSHeapSize / 1_048_576).toFixed(2);
    }
  }
});

syncStreamedWorld(
  DEFAULT_WORLD_SPEC,
  20260827,
  { position: { x: 0, z: 0 }, velocity: { x: 0, z: 0 } },
);

document.body.dataset.reconnectCount = "0";
document.body.dataset.connectionState = "OFFLINE";
playerName.value = enteredName;
if (playerToken !== null) connect();

engine.runRenderLoop(() => scene.render());
window.addEventListener("resize", () => engine.resize());
