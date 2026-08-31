import { describe, expect, it } from "vitest";
import {
  M7_HEAP_GROWTH_LIMIT_BYTES,
  classifyM7SoakGate,
  isM7PerformanceGate,
  m7SoakPerformanceViolations,
} from "../../scripts/m7-soak-policy.js";

describe("M7 soak gate policy", () => {
  it("classifies full-duration LOW runs without treating ten matches as smoke", () => {
    expect(classifyM7SoakGate({ matches: 20, matchDurationMs: 600_000, preset: "LOW" })).toBe("M7_SUBMISSION");
    expect(classifyM7SoakGate({ matches: 10, matchDurationMs: 600_000, preset: "LOW" })).toBe("M7_SHORTENED");
    expect(classifyM7SoakGate({ matches: 3, matchDurationMs: 600_000, preset: "LOW" })).toBe("M7_PERFORMANCE");
    expect(classifyM7SoakGate({ matches: 10, matchDurationMs: 30_000, preset: "LOW" })).toBe("HARNESS_SMOKE");
  });

  it("enables performance assertions for every ten-minute LOW run", () => {
    expect(isM7PerformanceGate({ matches: 1, matchDurationMs: 600_000, preset: "low" })).toBe(true);
    expect(isM7PerformanceGate({ matches: 10, matchDurationMs: 30_000, preset: "LOW" })).toBe(false);
  });

  it("accepts the exact FPS boundaries and heap growth below the limit", () => {
    expect(m7SoakPerformanceViolations({
      averageFps: 20,
      tenthPercentileFps: 18,
      heapGrowth: M7_HEAP_GROWTH_LIMIT_BYTES - 1,
    })).toEqual([]);
  });

  it("rejects each performance violation and non-finite metric", () => {
    expect(m7SoakPerformanceViolations({
      averageFps: 19.99,
      tenthPercentileFps: 17.99,
      heapGrowth: M7_HEAP_GROWTH_LIMIT_BYTES,
    })).toEqual([
      "averageFps must be >= 20",
      "tenthPercentileFps must be >= 18",
      `heapGrowth must be < ${M7_HEAP_GROWTH_LIMIT_BYTES}`,
    ]);
    expect(m7SoakPerformanceViolations({
      averageFps: Number.NaN,
      tenthPercentileFps: Number.POSITIVE_INFINITY,
      heapGrowth: Number.NEGATIVE_INFINITY,
    })).toHaveLength(3);
  });
});
