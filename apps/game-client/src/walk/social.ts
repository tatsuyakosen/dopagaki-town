import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3, Matrix } from "@babylonjs/core/Maths/math.vector.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { WALK_COLORS, WalkRoomIdSchema, type WalkPeer, type WalkClientMessage, type WalkServerMessage } from "../../../../packages/contracts/src/social.js";

function ui<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }
const errors: Record<string, string> = {
  ROOM_EXPIRED: "このルームは終了しました。新しく友達を招待できます。",
  ROOM_FULL: "このルームは4人で満員です。切断した人の席は30秒間保持します。",
  STAGE_MISMATCH: "街のデータが異なります。招待リンクから開き直してください。",
  STAGE_UNAVAILABLE: "街のデータを共有できません。地図から街を作り直してください。",
  SERVER_FULL: "ルームが混み合っています。少し待って再試行してください。",
  CHAT_RATE_LIMIT: "少し間をあけて送信してください。",
  ALREADY_CONNECTED: "同じ参加者が別の画面で接続中です。そちらを退出してから再参加してください。",
  BAD_MESSAGE: "表示名・メッセージに使えない文字が含まれています。",
};
type Avatar = { mesh: Mesh; material: StandardMaterial; label: HTMLSpanElement; target: Vector3; yaw: number; peer: WalkPeer };

export class WalkSocial {
  private socket: WebSocket | undefined;
  private room = "";
  private playerId = "";
  private token = "";
  private seq = 0;
  private chatId = 0;
  private active = false;
  private disposed = false;
  private lastSnapshot = 0;
  private avatars = new Map<string, Avatar>();
  private timer: ReturnType<typeof setInterval>;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private retries = 0;
  private roomFailed = false;
  private memberSignature = "";
  private readonly initialName: HTMLInputElement;

  constructor(private scene: Scene, private player: Mesh, private stage: string | null,
    private paused: () => boolean, private visibleAt: (x: number, z: number) => boolean) {
    this.initialName = ui<HTMLInputElement>("social-name");
    const invited = new URLSearchParams(location.hash.slice(1)).get("room");
    if (invited && WalkRoomIdSchema.safeParse(invited).success) this.room = invited;
    ui("social-panel").hidden = false;
    ui<HTMLButtonElement>("social-create").disabled = !stage;
    ui("social-create").hidden = !!this.room;
    ui("social-join").hidden = !this.room;
    this.status(!stage ? "友達との街歩きは、地図から構築した街で利用できます。" : this.room ? "友達からの招待です。表示名を決めて参加してください。" : "同じ街を最大4人で自由に歩けます。ルームは招待した人だけに共有します。");
    ui("social-create").addEventListener("click", () => this.connect(true));
    ui("social-join").addEventListener("click", () => this.connect(false));
    ui("social-copy").addEventListener("click", () => { void this.copyInvite(); });
    ui("social-leave").addEventListener("click", () => this.leave());
    ui("social-form").addEventListener("submit", event => {
      event.preventDefault(); const input = ui<HTMLInputElement>("social-message");
      const text = input.value.trim(); if (!text || !this.active) return;
      this.send({ type: "CHAT", text }); input.value = "";
    });
    this.timer = setInterval(() => {
      if (!this.active || document.hidden) return;
      const { x, y, z } = this.player.position;
      this.send({ type: "POSE", seq: this.seq++, pose: {
        x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, z: Math.round(z * 100) / 100,
        yaw: Math.atan2(Math.sin(this.player.rotation.y), Math.cos(this.player.rotation.y)), paused: this.paused(),
      } });
    }, 100);
  }
  private status(text: string): void { ui("social-status").textContent = text; }
  private controls(busy: boolean): void {
    ui<HTMLButtonElement>("social-create").disabled = busy || !this.stage;
    ui<HTMLButtonElement>("social-join").disabled = busy || !this.stage;
    this.initialName.disabled = busy;
    ui<HTMLButtonElement>("social-copy").disabled = !this.active;
    ui<HTMLButtonElement>("social-send").disabled = !this.active;
    ui<HTMLInputElement>("social-message").disabled = !this.active;
  }
  private connect(create: boolean): void {
    if (this.disposed || !this.stage || this.socket && this.socket.readyState < WebSocket.CLOSING) return;
    if (!this.initialName.reportValidity()) return;
    this.active = false; this.roomFailed = false; this.controls(true);
    this.status("同じ街に接続しています…");
    const url = new URL("/ws/walk", location.href); url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url); this.socket = socket;
    socket.addEventListener("open", () => {
      if (create) this.send({ type: "CREATE", stage: this.stage!, name: this.initialName.value.trim() });
      else {
        try { this.token = sessionStorage.getItem(`walk-room:${this.room}`) ?? ""; } catch { /* Storage is optional. */ }
        this.send({ type: "JOIN", stage: this.stage!, room: this.room, name: this.initialName.value.trim(), ...(this.token ? { token: this.token } : {}) });
      }
    });
    socket.addEventListener("message", event => {
      if (typeof event.data !== "string" || event.data.length > 32_768) return;
      try { this.receive(JSON.parse(event.data) as WalkServerMessage); } catch { this.status("共有状態を読み取れません。再接続してください。"); }
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.active = false; this.memberSignature = ""; this.clearAvatars(); this.controls(false); ui("social-chat").hidden = true;
      ui("mode-tag").textContent = "自由に街歩き / ひとり";
      if (this.disposed || this.roomFailed) return;
      this.status("接続が切れました。街歩きは続けられます。");
      if (this.room && this.token && this.retries++ < 3) this.reconnect = setTimeout(() => this.connect(false), 1000 * this.retries);
      else { ui("social-join").hidden = !this.room; ui("social-create").hidden = !!this.room; }
    });
    socket.addEventListener("error", () => this.status("友達との接続を利用できません。同じサーバーの招待リンクか確認してください。"));
  }
  private send(message: WalkClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN && this.socket.bufferedAmount < 8192) this.socket.send(JSON.stringify(message));
  }
  private receive(message: WalkServerMessage): void {
    if (message.type === "ERROR") {
      this.status(errors[message.code] ?? "接続を完了できません。再試行してください。");
      if (!this.active) { this.roomFailed = true; this.socket?.close(); this.controls(false); ui("social-leave").hidden = !this.room; }
      return;
    }
    if (message.type === "WELCOME") {
      this.room = message.room; this.playerId = message.playerId; this.token = message.token;
      this.seq = 0; this.retries = 0; this.active = true;
      try { sessionStorage.setItem(`walk-room:${this.room}`, this.token); } catch { /* Reconnect can join afresh. */ }
      history.replaceState(null, "", `${location.pathname}${location.search}#room=${this.room}`);
      ui("social-create").hidden = true; ui("social-join").hidden = true;
      ui("social-copy").hidden = false; ui("social-leave").hidden = false; ui("social-chat").hidden = false;
      this.controls(true); this.status("招待リンクを送ると、この街で合流できます。");
      return;
    }
    if (message.type !== "STATE" || !this.active) return;
    this.lastSnapshot = performance.now();
    const ids = new Set(message.peers.filter(p => p.id !== this.playerId && p.connected).map(p => p.id));
    for (const [id, avatar] of this.avatars) if (!ids.has(id)) { avatar.mesh.dispose(); avatar.material.dispose(); avatar.label.remove(); this.avatars.delete(id); }
    for (const peer of message.peers) {
      if (peer.id === this.playerId || !peer.connected) continue;
      let avatar = this.avatars.get(peer.id);
      if (!avatar) {
        const mesh = MeshBuilder.CreateCapsule(`friend-${peer.id}`, { height: 1.8, radius: .35, tessellation: 8 }, this.scene);
        mesh.isPickable = false; mesh.checkCollisions = false;
        const material = new StandardMaterial(`friend-color-${peer.id}`, this.scene);
        material.diffuseColor = Color3.FromHexString(WALK_COLORS[peer.color]!); material.specularColor.set(.1, .1, .1); mesh.material = material;
        mesh.position.set(peer.pose.x, peer.pose.y, peer.pose.z);
        const label = document.createElement("span"); label.className = "friend-label"; ui("friend-labels").append(label);
        avatar = { mesh, material, label, target: mesh.position.clone(), yaw: peer.pose.yaw, peer }; this.avatars.set(peer.id, avatar);
      }
      avatar.peer = peer; avatar.target.set(peer.pose.x, peer.pose.y, peer.pose.z); avatar.yaw = peer.pose.yaw;
      avatar.label.textContent = `${peer.name}${peer.pose.paused ? " · 休憩中" : ""}`;
    }
    const signature = message.peers.map(p => `${p.id}:${p.name}:${p.connected}`).join("|");
    if (signature !== this.memberSignature) {
      this.memberSignature = signature;
      const list = ui("social-members"); list.replaceChildren();
      for (const peer of message.peers) {
        const item = document.createElement("li"); item.style.borderColor = WALK_COLORS[peer.color]!;
        item.textContent = `${peer.name}${peer.id === this.playerId ? "（自分）" : ""}${peer.connected ? "" : " · 再接続待ち"}`; list.append(item);
      }
      ui("mode-tag").textContent = `自由に街歩き / ${message.peers.filter(p => p.connected).length}人`;
    }
    for (const chat of message.chats) if (chat.id > this.chatId) {
      this.chatId = chat.id;
      const line = document.createElement("p"); const author = document.createElement("strong"); author.textContent = `${chat.name}：`;
      line.append(author, document.createTextNode(chat.text)); const log = ui("social-log"); log.append(line);
      while (log.children.length > 24) log.firstElementChild?.remove(); log.scrollTop = log.scrollHeight;
    }
  }
  update(dt: number): void {
    const camera = this.scene.activeCamera; if (!camera) return;
    const engine = this.scene.getEngine(), viewport = camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
    for (const avatar of this.avatars.values()) {
      const visible = performance.now() - this.lastSnapshot < 5000 && this.visibleAt(avatar.target.x, avatar.target.z);
      avatar.mesh.setEnabled(visible);
      if (Vector3.Distance(avatar.mesh.position, avatar.target) > 10) avatar.mesh.position.copyFrom(avatar.target);
      else Vector3.LerpToRef(avatar.mesh.position, avatar.target, Math.min(1, dt * 10), avatar.mesh.position);
      avatar.mesh.rotation.y = avatar.yaw;
      const point = Vector3.Project(avatar.mesh.position.add(new Vector3(0, 1.5, 0)), Matrix.Identity(), this.scene.getTransformMatrix(), viewport);
      const dx = avatar.target.x - this.player.position.x, dz = avatar.target.z - this.player.position.z;
      avatar.label.hidden = !visible || point.z < 0 || point.z > 1 || Math.hypot(dx, dz) > 60;
      avatar.label.style.left = `${point.x / engine.getRenderWidth() * 100}%`;
      avatar.label.style.top = `${point.y / engine.getRenderHeight() * 100}%`;
    }
  }
  private async copyInvite(): Promise<void> {
    const url = new URL("/walk.html", location.href);
    url.searchParams.set(this.stage === "fixture" ? "fixture" : "stage", this.stage === "fixture" ? "1" : this.stage!);
    if (new URLSearchParams(location.search).get("quality") === "low") url.searchParams.set("quality", "low");
    url.hash = `room=${this.room}`;
    try { await navigator.clipboard.writeText(url.href); this.status("招待リンクをコピーしました。友達に送ってください。"); }
    catch { const input = ui<HTMLInputElement>("social-invite"); input.hidden = false; input.value = url.href; input.focus(); input.select(); this.status("このリンクをコピーして友達に送ってください。"); }
  }
  private clearAvatars(): void { for (const avatar of this.avatars.values()) { avatar.mesh.dispose(); avatar.material.dispose(); avatar.label.remove(); } this.avatars.clear(); }
  private leave(): void {
    clearTimeout(this.reconnect); this.send({ type: "LEAVE" });
    const socket = this.socket; this.socket = undefined; socket?.close();
    try { sessionStorage.removeItem(`walk-room:${this.room}`); } catch { /* Storage is optional. */ }
    this.room = ""; this.token = ""; this.active = false; this.chatId = 0; this.memberSignature = ""; this.clearAvatars();
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    ui("social-create").hidden = false; ui("social-join").hidden = true;
    for (const id of ["social-copy", "social-leave", "social-chat", "social-invite"]) ui(id).hidden = true;
    ui("social-members").replaceChildren(); ui("social-log").replaceChildren(); this.controls(false);
    ui("mode-tag").textContent = "自由に街歩き / ひとり"; this.status("ルームを退出しました。このまま一人で歩けます。");
  }
  dispose(): void { this.disposed = true; clearInterval(this.timer); clearTimeout(this.reconnect); this.socket?.close(); this.clearAvatars(); }
}
