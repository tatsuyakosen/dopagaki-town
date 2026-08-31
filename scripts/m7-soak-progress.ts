import type { M7SoakGate } from "./m7-soak-policy.js";

export const M7_SOAK_PROGRESS_PREFIX = "M7_CONTINUOUS_SOAK_PROGRESS ";

export interface M7SoakProgressSample {
  fps: number;
  heapBytes: number;
  loadedChunks: number;
  activeChunks: number;
  reconciliationError: number;
}

export interface M7SoakProgress {
  phase: "MATCH_STARTED" | "HEARTBEAT" | "MATCH_COMPLETED";
  gate: M7SoakGate;
  match: number;
  matchesRequested: number;
  seed: number;
  runElapsedMs: number;
  matchElapsedMs: number;
  samplesCompleted: number;
  samplesExpected: number;
  latest?: M7SoakProgressSample;
}

export function formatM7SoakProgress(progress: M7SoakProgress): string {
  return `${M7_SOAK_PROGRESS_PREFIX}${JSON.stringify(progress)}`;
}
