export const M7_FULL_MATCH_DURATION_MS = 600_000;
export const M7_AVERAGE_FPS_MINIMUM = 20;
export const M7_TENTH_PERCENTILE_FPS_MINIMUM = 18;
export const M7_HEAP_GROWTH_LIMIT_BYTES = 64 * 1024 * 1024;

export type M7SoakGate = "M7_SUBMISSION" | "M7_SHORTENED" | "M7_PERFORMANCE" | "HARNESS_SMOKE";

export interface M7SoakRun {
  matches: number;
  matchDurationMs: number;
  preset: string;
}

export interface M7SoakPerformance {
  averageFps: number;
  tenthPercentileFps: number;
  heapGrowth: number;
}

export function classifyM7SoakGate(run: M7SoakRun): M7SoakGate {
  if (!isM7PerformanceGate(run)) return "HARNESS_SMOKE";
  if (run.matches === 20) return "M7_SUBMISSION";
  if (run.matches === 10) return "M7_SHORTENED";
  return "M7_PERFORMANCE";
}

export function isM7PerformanceGate(run: M7SoakRun): boolean {
  return run.matchDurationMs === M7_FULL_MATCH_DURATION_MS && run.preset.toUpperCase() === "LOW";
}

export function m7SoakPerformanceViolations(performance: M7SoakPerformance): string[] {
  const violations: string[] = [];
  if (!Number.isFinite(performance.averageFps) || performance.averageFps < M7_AVERAGE_FPS_MINIMUM) {
    violations.push(`averageFps must be >= ${M7_AVERAGE_FPS_MINIMUM}`);
  }
  if (
    !Number.isFinite(performance.tenthPercentileFps)
    || performance.tenthPercentileFps < M7_TENTH_PERCENTILE_FPS_MINIMUM
  ) {
    violations.push(`tenthPercentileFps must be >= ${M7_TENTH_PERCENTILE_FPS_MINIMUM}`);
  }
  if (!Number.isFinite(performance.heapGrowth) || performance.heapGrowth >= M7_HEAP_GROWTH_LIMIT_BYTES) {
    violations.push(`heapGrowth must be < ${M7_HEAP_GROWTH_LIMIT_BYTES}`);
  }
  return violations;
}
