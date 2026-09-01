import {
  directorObservationOf,
  createGame,
} from "@dopagaki/game-core";
import { selectPatchCandidate } from "@dopagaki/verifier";
import { describe, expect, it, vi } from "vitest";
import {
  assertAdkRuntime,
  fixtureDirectorResponse,
  planDirector,
  verifierContextFromObservation,
  type DirectorProposalGenerator,
} from "../src/planner.js";
import { createDirectorServer, processDirectorRequest } from "../src/server.js";

function observation() {
  return directorObservationOf(createGame({ seed: 20260827 }));
}

describe("Director API planner", () => {
  it("keeps the Node 24.13 ADK requirement isolated from credential-free Fixture mode", () => {
    expect(() => assertAdkRuntime("22.21.1")).toThrow("Node.js 24.13 or newer");
    expect(() => assertAdkRuntime("24.13.0")).not.toThrow();
  });

  it("returns the deterministic Fixture without invoking Gemini in the default mode", async () => {
    const generate = vi.fn(() => Promise.reject(new Error("must not run")));
    const current = observation();
    const result = await planDirector(current, { provider: "FIXTURE", generate }, new AbortController().signal);

    expect(generate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ source: "FIXTURE", attempts: 0, failures: [] });
    expect(result.response.requestId).toBe(current.requestId);
    expect(selectPatchCandidate(
      result.response.candidates,
      verifierContextFromObservation(current),
    ).selected?.patchId).toBe("patch-1-valid");
  });

  it("replans once after a schema failure and returns the second verifier-safe proposal", async () => {
    const current = observation();
    const valid = fixtureDirectorResponse(current);
    const generate = vi.fn<DirectorProposalGenerator>()
      .mockResolvedValueOnce({ malformed: true })
      .mockResolvedValueOnce(valid);
    const result = await planDirector(
      current,
      { provider: "GEMINI_ADK", generate },
      new AbortController().signal,
    );

    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]?.[0].previousFailures).toMatchObject([{ attempt: 1, code: "SCHEMA" }]);
    expect(result).toMatchObject({ source: "GEMINI_ADK", attempts: 2 });
    expect(result.failures).toMatchObject([{ attempt: 1, code: "SCHEMA" }]);
  });

  it("falls back after two verifier-rejected proposals", async () => {
    const current = observation();
    const fixture = fixtureDirectorResponse(current);
    const unsafe = {
      ...fixture,
      candidates: [fixture.candidates[0]],
    };
    const generate = vi.fn(() => Promise.resolve(unsafe));
    const result = await planDirector(
      current,
      { provider: "GEMINI_ADK", generate },
      new AbortController().signal,
    );

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      source: "FIXTURE",
      attempts: 2,
      failures: [{ attempt: 1, code: "VERIFIER" }, { attempt: 2, code: "VERIFIER" }],
    });
    expect(result.failures[0]?.messages.some((message) => message.includes("F-06"))).toBe(true);
    expect(result.response.candidates[2]?.patchId).toBe("patch-1-valid");
  });

  it("rejects a mismatched request identity before verifier evaluation", async () => {
    const current = observation();
    const wrongIdentity = { ...fixtureDirectorResponse(current), requestId: "stale:0:1" };
    const generate = vi.fn(() => Promise.resolve(wrongIdentity));
    const result = await planDirector(
      current,
      { provider: "GEMINI_ADK", generate },
      new AbortController().signal,
    );

    expect(result.source).toBe("FIXTURE");
    expect(result.failures.map((entry) => entry.code)).toEqual(["IDENTITY", "IDENTITY"]);
  });

  it("propagates cancellation instead of spending the second attempt or generating a Fixture", async () => {
    const controller = new AbortController();
    const generate = vi.fn<DirectorProposalGenerator>(() => {
      controller.abort(new Error("request cancelled"));
      return Promise.reject(new Error("request cancelled"));
    });

    await expect(planDirector(
      observation(),
      { provider: "GEMINI_ADK", generate },
      controller.signal,
    )).rejects.toThrow("request cancelled");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("validates the HTTP boundary before planning", async () => {
    const invalid = await processDirectorRequest(
      { requestId: "broken" },
      { provider: "FIXTURE", model: "fixture" },
      new AbortController().signal,
    );
    expect(invalid).toMatchObject({ status: 400, body: { code: "INVALID_OBSERVATION" } });

    const valid = await processDirectorRequest(
      observation(),
      { provider: "FIXTURE", model: "fixture" },
      new AbortController().signal,
    );
    expect(valid).toMatchObject({ status: 200, body: { source: "FIXTURE", attempts: 0 } });
  });

  it("serves the credential-free health and planning endpoints over HTTP", async () => {
    const server = createDirectorServer({ provider: "FIXTURE", model: "fixture" });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Director test server did not bind TCP");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      await expect(fetch(`${baseUrl}/healthz`).then((response) => response.json())).resolves.toMatchObject({
        ok: true,
        provider: "FIXTURE",
      });
      const response = await fetch(`${baseUrl}/v1/director:plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(observation()),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ source: "FIXTURE", attempts: 0 });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    }
  });
});
