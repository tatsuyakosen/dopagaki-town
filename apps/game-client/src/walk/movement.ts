export function movementVector(keys: ReadonlySet<string>, yaw: number): { x: number; z: number; speed: number } {
  const forward = Number(keys.has("KeyW")) - Number(keys.has("KeyS"));
  const side = Number(keys.has("KeyD")) - Number(keys.has("KeyA"));
  const magnitude = Math.hypot(forward, side) || 1;
  return { x:(Math.sin(yaw)*forward+Math.cos(yaw)*side)/magnitude,
    z:(Math.cos(yaw)*forward-Math.sin(yaw)*side)/magnitude,
    speed:keys.has("ShiftLeft") || keys.has("ShiftRight") ? 7 : 3.2 };
}

export function frameSeconds(ms: number): number { return Math.min(.04, Math.max(0, ms / 1000)); }
