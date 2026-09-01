import { randomBytes } from "node:crypto";
import type {
  ClientMessage,
  MatchMode,
  MatchSnapshot,
  Movement,
  NetworkMatchSnapshot,
} from "@dopagaki/contracts";
import {
  acknowledgeMapChecksum,
  cancelTransit as cancelGameTransit,
  createGame,
  gameCheckpointOf,
  letBotTakeOver,
  markHumanDisconnected,
  networkSnapshotOf,
  replaceBotWithHuman,
  reserveTransit as reserveGameTransit,
  restoreGame,
  restoreHumanControl,
  snapshotOf,
  startGame,
  stepGame,
  type GameCheckpoint,
  type GameState,
  type TransitActionResult,
} from "@dopagaki/game-core";
import {
  DirectorCoordinator,
  type DirectorAdapter,
  type DirectorCoordinatorStatus,
} from "./director-coordinator.js";

type JoinMessage = Extract<ClientMessage, { type: "JOIN" }>;

export const RECONNECT_WINDOW_MS = 30_000;
export const ONI_TAKEOVER_MS = 10_000;

const IDLE_INPUT: Movement = { x: 0, z: 0, sprint: false };

export interface MatchRoomConfig {
  seed: number;
  durationMs: number;
  demoSeed?: number;
  demoDurationMs?: number;
  defaultMode?: MatchMode;
  patchIntervalMs: number;
  humanSpeedMultiplier: number;
  now?: () => number;
  tokenFactory?: () => string;
  directorAdapter?: DirectorAdapter;
  directorTimeoutMs?: number;
}

interface PlayerSession {
  playerToken: string;
  playerId: string;
  displayName: string;
  connectionId: string | null;
  input: Movement;
  lastInputSeq: number;
  lastAckedEventId: number;
  lastAckedMapVersion: number;
  disconnectedAtMs: number | null;
  takeoverAtMs: number | null;
  expiresAtMs: number | null;
  botControlled: boolean;
}

export interface WelcomePayload {
  playerId: string;
  matchId: string;
  playerToken: string;
  resumed: boolean;
  lastInputSeq: number;
  lastEventId: number;
  mapVersion: number;
  replacedConnectionId: string | null;
}

export type JoinResult =
  | { ok: true; welcome: WelcomePayload }
  | { ok: false; code: "ROOM_FULL" | "SESSION_EXPIRED" | "INVALID_SESSION"; message: string };

interface SessionCheckpoint extends Omit<PlayerSession, "connectionId"> {
  wasConnected: boolean;
}

export interface RoomCheckpoint {
  version: number;
  capturedAtMs: number;
  matchMode?: MatchMode;
  seed: number;
  matchInstanceSequence?: number;
  playerSequence: number;
  game: GameCheckpoint;
  sessions: SessionCheckpoint[];
}

export class MatchRoom {
  game: GameState;

  private readonly config: MatchRoomConfig;
  private readonly now: () => number;
  private readonly tokenFactory: () => string;
  private mode: MatchMode;
  private seed: number;
  private matchInstanceSequence = 0;
  private playerSequence = 0;
  private readonly sessions = new Map<string, PlayerSession>();
  private readonly connectionTokens = new Map<string, string>();
  private readonly directorCoordinator: DirectorCoordinator | null;

  constructor(config: MatchRoomConfig) {
    this.config = config;
    this.mode = config.defaultMode ?? "STANDARD";
    this.seed = this.profileFor(this.mode).seed;
    this.now = config.now ?? Date.now;
    this.tokenFactory = config.tokenFactory ?? (() => randomBytes(24).toString("hex"));
    this.game = this.createGame(this.seed);
    const directorAdapter = config.directorAdapter;
    this.directorCoordinator = directorAdapter === undefined
      ? null
      : new DirectorCoordinator({
          currentGame: () => this.game,
          adapter: directorAdapter,
          ...(config.directorTimeoutMs === undefined ? {} : { timeoutMs: config.directorTimeoutMs }),
        });
  }

  private createGame(seed: number): GameState {
    const game = createGame({
      seed,
      durationMs: this.profileFor(this.mode).durationMs,
      patchIntervalMs: this.config.patchIntervalMs,
      humanSpeedMultiplier: this.config.humanSpeedMultiplier,
    });
    if (this.matchInstanceSequence > 0) {
      game.matchId = `${game.matchId}-r${this.matchInstanceSequence}`;
    }
    return game;
  }

  private profileFor(mode: MatchMode): { seed: number; durationMs: number } {
    if (mode === "DEMO") {
      return {
        seed: this.config.demoSeed ?? this.config.seed,
        durationMs: this.config.demoDurationMs ?? 180_000,
      };
    }
    return { seed: this.config.seed, durationMs: this.config.durationMs };
  }

  private activateMode(mode: MatchMode): void {
    if (this.playerSequence > 0) this.matchInstanceSequence += 1;
    const profile = this.profileFor(mode);
    this.mode = mode;
    this.seed = profile.seed;
    this.game = this.createGame(this.seed);
  }

  private uniqueToken(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = this.tokenFactory();
      if (token.length >= 32 && !this.sessions.has(token)) return token;
    }
    throw new Error("Could not allocate a unique player token");
  }

  join(connectionId: string, request: JoinMessage): JoinResult {
    this.expireSessions();
    const existingToken = this.connectionTokens.get(connectionId);
    if (existingToken !== undefined) {
      const existing = this.sessions.get(existingToken);
      if (existing === undefined) {
        this.connectionTokens.delete(connectionId);
      } else if (request.playerToken === undefined || request.playerToken === existingToken) {
        return { ok: true, welcome: this.welcome(existing, false, null) };
      } else {
        return { ok: false, code: "INVALID_SESSION", message: "接続済みsessionとtokenが一致しません" };
      }
    }
    if (request.playerToken !== undefined) {
      return this.resume(connectionId, request);
    }
    if (this.sessions.size === 0 && request.matchMode !== undefined) {
      this.activateMode(request.matchMode);
    } else if (this.game.status === "FINISHED") {
      this.restart();
    }

    this.playerSequence += 1;
    const playerId = `human-${this.playerSequence}`;
    const displayName = request.playerName ?? `Player ${this.playerSequence}`;
    try {
      replaceBotWithHuman(this.game, playerId, displayName);
    } catch (error) {
      return {
        ok: false,
        code: "ROOM_FULL",
        message: error instanceof Error ? error.message : "Room is full",
      };
    }

    const playerToken = this.uniqueToken();
    const session: PlayerSession = {
      playerToken,
      playerId,
      displayName,
      connectionId,
      input: { ...IDLE_INPUT },
      lastInputSeq: 0,
      lastAckedEventId: 0,
      lastAckedMapVersion: this.game.mapVersion,
      disconnectedAtMs: null,
      takeoverAtMs: null,
      expiresAtMs: null,
      botControlled: false,
    };
    this.sessions.set(playerToken, session);
    this.connectionTokens.set(connectionId, playerToken);
    if (this.game.status === "WAITING") startGame(this.game);
    return { ok: true, welcome: this.welcome(session, false, null) };
  }

  private resume(connectionId: string, request: JoinMessage): JoinResult {
    const playerToken = request.playerToken;
    if (playerToken === undefined) {
      return { ok: false, code: "INVALID_SESSION", message: "playerToken is required" };
    }
    const session = this.sessions.get(playerToken);
    if (session === undefined) {
      return { ok: false, code: "SESSION_EXPIRED", message: "再接続可能な30秒を超過しました" };
    }
    const now = this.now();
    if (session.expiresAtMs !== null && now >= session.expiresAtMs) {
      this.expireSession(session);
      return { ok: false, code: "SESSION_EXPIRED", message: "再接続可能な30秒を超過しました" };
    }
    const player = restoreHumanControl(this.game, session.playerId, session.displayName);
    if (player === null) {
      this.sessions.delete(playerToken);
      return { ok: false, code: "INVALID_SESSION", message: "復帰対象のプレイヤーが見つかりません" };
    }

    const replacedConnectionId = session.connectionId;
    if (replacedConnectionId !== null) this.connectionTokens.delete(replacedConnectionId);
    session.connectionId = connectionId;
    session.input = { ...IDLE_INPUT };
    session.disconnectedAtMs = null;
    session.takeoverAtMs = null;
    session.expiresAtMs = null;
    session.botControlled = false;
    session.lastAckedEventId = Math.max(
      session.lastAckedEventId,
      Math.min(request.lastAckedEventId ?? 0, this.game.lastEventId),
    );
    session.lastAckedMapVersion = Math.min(request.mapVersion ?? this.game.mapVersion, this.game.mapVersion);
    this.connectionTokens.set(connectionId, playerToken);
    return { ok: true, welcome: this.welcome(session, true, replacedConnectionId) };
  }

  private welcome(
    session: PlayerSession,
    resumed: boolean,
    replacedConnectionId: string | null,
  ): WelcomePayload {
    return {
      playerId: session.playerId,
      matchId: this.game.matchId,
      playerToken: session.playerToken,
      resumed,
      lastInputSeq: session.lastInputSeq,
      lastEventId: this.game.lastEventId,
      mapVersion: this.game.mapVersion,
      replacedConnectionId,
    };
  }

  disconnect(connectionId: string): void {
    const playerToken = this.connectionTokens.get(connectionId);
    if (playerToken === undefined) return;
    this.connectionTokens.delete(connectionId);
    const session = this.sessions.get(playerToken);
    if (session === undefined || session.connectionId !== connectionId) return;
    const now = this.now();
    session.connectionId = null;
    session.input = { ...IDLE_INPUT };
    session.disconnectedAtMs = now;
    session.takeoverAtMs = now + ONI_TAKEOVER_MS;
    session.expiresAtMs = now + RECONNECT_WINDOW_MS;
    markHumanDisconnected(this.game, session.playerId);
  }

  setInput(connectionId: string, seq: number, movement: Movement): boolean {
    const session = this.sessionForConnection(connectionId);
    if (session === null || seq <= session.lastInputSeq) return false;
    session.lastInputSeq = seq;
    session.input = { ...movement };
    return true;
  }

  acknowledgePatch(
    connectionId: string,
    patchId: string,
    mapVersion: number,
    checksum: string,
  ): boolean {
    const session = this.sessionForConnection(connectionId);
    if (session === null) return false;
    const accepted = acknowledgeMapChecksum(
      this.game,
      session.playerId,
      patchId,
      mapVersion,
      checksum,
    );
    if (accepted) session.lastAckedMapVersion = mapVersion;
    return accepted;
  }

  reserveTransit(
    connectionId: string,
    reservationId: string,
    departureId: string,
  ): TransitActionResult | null {
    const session = this.sessionForConnection(connectionId);
    if (session === null) return null;
    return reserveGameTransit(this.game, session.playerId, reservationId, departureId);
  }

  cancelTransit(connectionId: string, reservationId: string): TransitActionResult | null {
    const session = this.sessionForConnection(connectionId);
    if (session === null) return null;
    return cancelGameTransit(this.game, session.playerId, reservationId);
  }

  tick(deltaMs: number): void {
    this.expireSessions();
    const inputs: Record<string, Movement> = {};
    for (const session of this.sessions.values()) {
      if (session.connectionId !== null) inputs[session.playerId] = session.input;
    }
    stepGame(this.game, inputs, deltaMs, {
      autoPrepareDirector: this.directorCoordinator === null,
    });
    this.directorCoordinator?.poll();
  }

  snapshot(): MatchSnapshot {
    return snapshotOf(this.game);
  }

  networkSnapshot(): NetworkMatchSnapshot {
    return networkSnapshotOf(this.game);
  }

  restart(): void {
    this.directorCoordinator?.reset();
    this.matchInstanceSequence += 1;
    this.seed = this.mode === "DEMO" ? this.profileFor("DEMO").seed : this.seed + 1;
    this.game = this.createGame(this.seed);
    for (const session of this.sessions.values()) {
      replaceBotWithHuman(this.game, session.playerId, session.displayName);
      session.lastAckedEventId = 0;
      session.lastAckedMapVersion = this.game.mapVersion;
      session.lastInputSeq = 0;
      session.input = { ...IDLE_INPUT };
      if (session.connectionId === null) {
        markHumanDisconnected(this.game, session.playerId);
        if (session.botControlled) letBotTakeOver(this.game, session.playerId);
      }
    }
    if ([...this.sessions.values()].some((session) => session.connectionId !== null)) startGame(this.game);
  }

  connectedCount(): number {
    return this.connectionTokens.size;
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  get matchMode(): MatchMode {
    return this.mode;
  }

  directorStatus(): DirectorCoordinatorStatus | null {
    return this.directorCoordinator?.status() ?? null;
  }

  checkpoint(): RoomCheckpoint {
    return {
      version: 3,
      capturedAtMs: this.now(),
      matchMode: this.mode,
      seed: this.seed,
      matchInstanceSequence: this.matchInstanceSequence,
      playerSequence: this.playerSequence,
      game: gameCheckpointOf(this.game),
      sessions: [...this.sessions.values()].map((session) => ({
        playerToken: session.playerToken,
        playerId: session.playerId,
        displayName: session.displayName,
        input: { ...session.input },
        lastInputSeq: session.lastInputSeq,
        lastAckedEventId: session.lastAckedEventId,
        lastAckedMapVersion: session.lastAckedMapVersion,
        disconnectedAtMs: session.disconnectedAtMs,
        takeoverAtMs: session.takeoverAtMs,
        expiresAtMs: session.expiresAtMs,
        botControlled: session.botControlled,
        wasConnected: session.connectionId !== null,
      })),
    };
  }

  static restore(
    checkpoint: RoomCheckpoint,
    config: MatchRoomConfig,
  ): MatchRoom {
    if (checkpoint.version !== 2 && checkpoint.version !== 3) {
      throw new Error(`Unsupported Room checkpoint v${checkpoint.version}`);
    }
    const room = new MatchRoom(config);
    room.mode = checkpoint.matchMode ?? "STANDARD";
    room.seed = checkpoint.seed;
    room.matchInstanceSequence = checkpoint.matchInstanceSequence ?? 0;
    room.playerSequence = checkpoint.playerSequence;
    room.game = restoreGame(checkpoint.game);
    const now = room.now();
    for (const saved of checkpoint.sessions) {
      const session: PlayerSession = {
        playerToken: saved.playerToken,
        playerId: saved.playerId,
        displayName: saved.displayName,
        connectionId: null,
        input: { ...IDLE_INPUT },
        lastInputSeq: saved.lastInputSeq,
        lastAckedEventId: saved.lastAckedEventId,
        lastAckedMapVersion: saved.lastAckedMapVersion,
        disconnectedAtMs: saved.wasConnected ? now : saved.disconnectedAtMs,
        takeoverAtMs: saved.wasConnected ? now + ONI_TAKEOVER_MS : saved.takeoverAtMs,
        expiresAtMs: saved.wasConnected ? now + RECONNECT_WINDOW_MS : saved.expiresAtMs,
        botControlled: saved.botControlled,
      };
      room.sessions.set(session.playerToken, session);
      if (saved.wasConnected) markHumanDisconnected(room.game, session.playerId);
    }
    room.expireSessions();
    return room;
  }

  private sessionForConnection(connectionId: string): PlayerSession | null {
    const token = this.connectionTokens.get(connectionId);
    if (token === undefined) return null;
    return this.sessions.get(token) ?? null;
  }

  private expireSessions(): void {
    const now = this.now();
    for (const session of [...this.sessions.values()]) {
      if (session.connectionId !== null) continue;
      const player = this.game.players.find((candidate) => candidate.id === session.playerId);
      if (
        !session.botControlled &&
        player?.role === "ONI" &&
        session.takeoverAtMs !== null &&
        now >= session.takeoverAtMs
      ) {
        letBotTakeOver(this.game, session.playerId);
        session.botControlled = true;
      }
      if (session.expiresAtMs !== null && now >= session.expiresAtMs) this.expireSession(session);
    }
  }

  private expireSession(session: PlayerSession): void {
    if (!session.botControlled) letBotTakeOver(this.game, session.playerId);
    this.sessions.delete(session.playerToken);
    if (session.connectionId !== null) this.connectionTokens.delete(session.connectionId);
  }
}
