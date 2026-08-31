import { describe, expect, it } from "vitest";
import {
  M7_SOAK_PROGRESS_PREFIX,
  formatM7SoakProgress,
  type M7SoakProgress,
} from "../../scripts/m7-soak-progress.js";

describe("M7 soak progress output", () => {
  it("formats a single-line machine-readable heartbeat", () => {
    const progress: M7SoakProgress = {
      phase: "HEARTBEAT",
      gate: "M7_SHORTENED",
      match: 4,
      matchesRequested: 10,
      seed: 20260834,
      runElapsedMs: 1_920_000,
      matchElapsedMs: 120_000,
      samplesCompleted: 12,
      samplesExpected: 60,
      latest: {
        fps: 31.5,
        heapBytes: 55_000_000,
        loadedChunks: 25,
        activeChunks: 9,
        reconciliationError: 0.04,
      },
    };

    const line = formatM7SoakProgress(progress);

    expect(line.startsWith(M7_SOAK_PROGRESS_PREFIX)).toBe(true);
    expect(line).not.toContain("\n");
    expect(JSON.parse(line.slice(M7_SOAK_PROGRESS_PREFIX.length))).toEqual(progress);
  });
});
