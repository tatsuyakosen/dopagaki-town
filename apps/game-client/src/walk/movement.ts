export function movementVector(keys: ReadonlySet<string>, yaw: number): { x: number; z: number; speed: number } {
  const forward = Number(keys.has("KeyW")) - Number(keys.has("KeyS"));
  const side = Number(keys.has("KeyD")) - Number(keys.has("KeyA"));
  const magnitude = Math.hypot(forward, side) || 1;
  return { x:(Math.sin(yaw)*forward+Math.cos(yaw)*side)/magnitude,
    z:(Math.cos(yaw)*forward-Math.sin(yaw)*side)/magnitude,
    speed:keys.has("ShiftLeft") || keys.has("ShiftRight") ? 7 : 3.2 };
}

export function frameSeconds(ms: number): number { return Number.isFinite(ms) ? Math.min(.1, Math.max(0, ms / 1000)) : 0; }

/** Keep real-time speed down to 10 FPS without taking large collision steps. */
export function movementSteps(seconds:number):number[] {
  if(seconds<=0)return [];
  const count=Math.ceil(seconds/(1/60));
  return Array<number>(count).fill(seconds/count);
}
