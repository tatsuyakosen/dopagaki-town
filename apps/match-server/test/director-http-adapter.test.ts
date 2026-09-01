import { createGame, directorObservationOf } from "@dopagaki/game-core";
import { createFixturePatchCandidates, type VerifierContext } from "@dopagaki/verifier";
import { describe, expect, it, vi } from "vitest";
import { createDirectorHttpAdapter } from "../src/director-http-adapter.js";

function responseFixture() {
  const game = createGame({ seed: 20260827 });
  const observation = directorObservationOf(game);
  const context: VerifierContext = {
    world: game.world,
    metadata: game.worldMetadata,
    players: game.players,
    obstacles: game.obstacles,
    navigationEdges: game.navigationEdges,
    currentMapVersion: game.mapVersion,
    appliedPatchIds: game.appliedPatchIds,
    lastTargetPlayerId: game.lastTargetPlayerId,
  };
  return {
    observation,
    response: {
      requestId: observation.requestId,
      stageSpec: game.stageSpec,
      candidates: createFixturePatchCandidates(0, context),
    },
  };
}

describe("Director HTTP adapter", () => {
  it("returns only a Gemini ADK response and forwards the AbortSignal", async () => {
    const fixture = responseFixture();
    const controller = new AbortController();
    const fetchDirector = vi.fn<typeof fetch>((input, init) => {
      expect(input).toBe("http://director.test/v1/director:plan");
      expect(init?.signal).toBe(controller.signal);
      if (typeof init?.body !== "string") throw new Error("Director request body must be JSON text");
      expect(JSON.parse(init.body)).toMatchObject({ requestId: fixture.observation.requestId });
      return Promise.resolve(new Response(JSON.stringify({
        source: "GEMINI_ADK",
        attempts: 1,
        response: fixture.response,
        failures: [],
      }), { status: 200 }));
    });
    const adapter = createDirectorHttpAdapter("http://director.test", fetchDirector);

    await expect(adapter(fixture.observation, controller.signal)).resolves.toMatchObject({
      requestId: fixture.observation.requestId,
    });
    expect(fetchDirector).toHaveBeenCalledTimes(1);
  });

  it("turns a remote Fixture result into a local Coordinator fallback", async () => {
    const fixture = responseFixture();
    const fetchDirector = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({
      source: "FIXTURE",
      attempts: 2,
      response: fixture.response,
      failures: [
        { attempt: 1, code: "SCHEMA", messages: ["invalid"] },
        { attempt: 2, code: "VERIFIER", messages: ["F-06"] },
      ],
    }), { status: 200 })));
    const adapter = createDirectorHttpAdapter("http://director.test", fetchDirector);

    await expect(adapter(fixture.observation, new AbortController().signal)).rejects.toThrow(
      "deterministic Fixture fallback",
    );
  });
});
