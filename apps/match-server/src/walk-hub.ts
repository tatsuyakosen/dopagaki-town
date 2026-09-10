import { randomBytes } from "node:crypto";
import type { WalkChat, WalkClientMessage, WalkPeer, WalkServerMessage } from "../../../packages/contracts/src/social.js";

export type WalkStage = { halfSize: number; spawn: [number, number, number] };
type Member = WalkPeer & { token: string; connection: string | null; disconnectedAt: number; seq: number; nextChatAt: number };
type Room = { id: string; stage: string; bounds: WalkStage; members: Map<string, Member>; chats: WalkChat[]; chatId: number; touched: number };
type Connection = { send: (message: WalkServerMessage) => void; room: Room | null; member: Member | null; pending: boolean; nextJoinAt: number };
export const WALK_LIMITS = { players: 4, rooms: 32, connections: 128, reconnectMs: 30_000, idleMs: 600_000, chats: 24 } as const;

/** Social presence only. Client collisions do not authorize competitive game results. */
export class WalkHub {
  private rooms = new Map<string, Room>();
  private connections = new Map<string, Connection>();
  constructor(private loadStage: (stage: string) => Promise<WalkStage>, private now: () => number = Date.now) {}

  connect(id: string, send: Connection["send"]): boolean {
    if (this.connections.size >= WALK_LIMITS.connections) return false;
    this.connections.set(id, { send, room: null, member: null, pending: false, nextJoinAt: 0 });
    return true;
  }
  disconnect(id: string): void {
    const connection = this.connections.get(id);
    if (connection?.member) {
      connection.member.connection = null;
      connection.member.connected = false;
      connection.member.disconnectedAt = this.now();
    }
    this.connections.delete(id);
  }
  private error(connection: Connection, code: string): void { connection.send({ type: "ERROR", code }); }
  async handle(id: string, message: WalkClientMessage): Promise<void> {
    const connection = this.connections.get(id);
    if (!connection) return;
    if (message.type === "CREATE" || message.type === "JOIN") {
      if (connection.member || connection.pending || this.now() < connection.nextJoinAt) { this.error(connection, "JOIN_BUSY"); return; }
      connection.nextJoinAt = this.now() + 1000;
      connection.pending = true;
      try {
        this.sweep();
        let room: Room | undefined;
        if (message.type === "CREATE") {
          if (this.rooms.size >= WALK_LIMITS.rooms) { this.error(connection, "SERVER_FULL"); return; }
          const bounds = await this.loadStage(message.stage);
          if (!this.connections.has(id)) return;
          // Recheck after asynchronous stage validation to bound concurrent creation.
          if (this.rooms.size >= WALK_LIMITS.rooms) { this.error(connection, "SERVER_FULL"); return; }
          room = { id: randomBytes(16).toString("hex"), stage: message.stage, bounds, members: new Map(), chats: [], chatId: 0, touched: this.now() };
          this.rooms.set(room.id, room);
        } else {
          room = this.rooms.get(message.room);
          if (!room) { this.error(connection, "ROOM_EXPIRED"); return; }
          if (room.stage !== message.stage) { this.error(connection, "STAGE_MISMATCH"); return; }
        }
        let member = message.type === "JOIN" && message.token ? [...room.members.values()].find(p => p.token === message.token) : undefined;
        if (member?.connected) { this.error(connection, "ALREADY_CONNECTED"); return; }
        if (!member) {
          if (room.members.size >= WALK_LIMITS.players) { this.error(connection, "ROOM_FULL"); return; }
          const color = [0, 1, 2, 3].find(c => ![...room.members.values()].some(p => p.color === c))!;
          const [x, y, z] = room.bounds.spawn;
          member = { id: randomBytes(8).toString("hex"), token: randomBytes(24).toString("hex"), name: message.name,
            color, connected: true, pose: { x, y, z, yaw: 0, paused: true },
            connection: id, disconnectedAt: 0, seq: -1, nextChatAt: 0 };
          room.members.set(member.id, member);
        }
        member.connection = id; member.connected = true; member.seq = -1;
        connection.room = room; connection.member = member; room.touched = this.now();
        connection.send({ type: "WELCOME", room: room.id, stage: room.stage, playerId: member.id, token: member.token });
        this.broadcast(room, true);
      } catch { this.error(connection, "STAGE_UNAVAILABLE"); }
      finally { connection.pending = false; }
      return;
    }
    const { room, member } = connection;
    if (!room || !member) { this.error(connection, "JOIN_REQUIRED"); return; }
    if (message.type === "LEAVE") {
      room.members.delete(member.id); connection.room = null; connection.member = null; room.touched = this.now();
      this.broadcast(room); return;
    }
    if (message.type === "POSE") {
      if (message.seq <= member.seq) return;
      if (Math.abs(message.pose.x) > room.bounds.halfSize || Math.abs(message.pose.z) > room.bounds.halfSize) return;
      member.seq = message.seq; member.pose = message.pose;
    } else {
      if (this.now() < member.nextChatAt) { this.error(connection, "CHAT_RATE_LIMIT"); return; }
      member.nextChatAt = this.now() + 1500;
      room.chats.push({ id: ++room.chatId, playerId: member.id, name: member.name, text: message.text });
      if (room.chats.length > WALK_LIMITS.chats) room.chats.shift();
      this.broadcast(room, true);
    }
    room.touched = this.now();
  }
  private broadcast(room: Room, includeChat = false): void {
    const peers = [...room.members.values()].map(({ id, name, color, connected, pose }) => ({ id, name, color, connected, pose }));
    for (const member of room.members.values()) if (member.connection) this.connections.get(member.connection)?.send({ type: "STATE", peers, chats: includeChat ? room.chats : [] });
  }
  private sweep(): void {
    for (const room of this.rooms.values()) {
      for (const member of room.members.values()) if (!member.connected && this.now() - member.disconnectedAt >= WALK_LIMITS.reconnectMs) room.members.delete(member.id);
      if (!room.members.size && this.now() - room.touched >= WALK_LIMITS.idleMs) this.rooms.delete(room.id);
    }
  }
  tick(): void { this.sweep(); for (const room of this.rooms.values()) this.broadcast(room); }
  get counts(): { rooms: number; connections: number } { return { rooms: this.rooms.size, connections: this.connections.size }; }
}
