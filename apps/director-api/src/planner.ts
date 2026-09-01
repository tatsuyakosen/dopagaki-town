import {
  DirectorApiResultSchema,
  DirectorResponseSchema,
  type DirectorApiResult,
  type DirectorAttemptFailure,
  type DirectorObservation,
  type DirectorPlayerObservation,
  type DirectorResponse,
  type PlayerSnapshot,
} from "@dopagaki/contracts";
import {
  createFixturePatchCandidates,
  selectPatchCandidate,
  type VerifierContext,
} from "@dopagaki/verifier";

export const MAX_DIRECTOR_ATTEMPTS = 2;

export interface DirectorGenerationRequest {
  observation: DirectorObservation;
  attempt: number;
  previousFailures: DirectorAttemptFailure[];
}

export type DirectorProposalGenerator = (
  request: DirectorGenerationRequest,
  signal: AbortSignal,
) => Promise<unknown>;

export interface DirectorPlannerOptions {
  provider: "FIXTURE" | "GEMINI_ADK";
  generate?: DirectorProposalGenerator;
}

function playerFromObservation(player: DirectorPlayerObservation): PlayerSnapshot {
  return {
    id: player.id,
    displayName: player.id,
    kind: player.kind,
    strategy: player.strategy,
    role: player.role,
    position: { ...player.position },
    velocity: { ...player.velocity },
    oniDurationMs: player.oniDurationMs,
    protectedUntilMs: player.protectedUntilMs,
    connected: true,
    transit: {
      phase: player.transitPhase,
      balanceYen: 0,
      reservedFareYen: 0,
      currentStationId: null,
      reservation: null,
      arrivalAtMs: null,
    },
  };
}

export function verifierContextFromObservation(observation: DirectorObservation): VerifierContext {
  return {
    world: structuredClone(observation.world),
    metadata: {
      chunks: [],
      stations: observation.stations.map((station) => ({
        ...structuredClone(station),
        name: station.id,
      })),
      mutationAnchors: structuredClone(observation.mutationAnchors),
    },
    players: observation.players.map(playerFromObservation),
    obstacles: structuredClone(observation.obstacles),
    navigationEdges: structuredClone(observation.navigationEdges),
    currentMapVersion: observation.mapVersion,
    appliedPatchIds: new Set(observation.appliedPatchIds),
    lastTargetPlayerId: observation.lastTargetPlayerId,
  };
}

export function fixtureDirectorResponse(observation: DirectorObservation): DirectorResponse {
  return DirectorResponseSchema.parse({
    requestId: observation.requestId,
    stageSpec: structuredClone(observation.stageSpec),
    candidates: createFixturePatchCandidates(
      observation.sequence,
      verifierContextFromObservation(observation),
    ),
  });
}

function failure(
  attempt: number,
  code: DirectorAttemptFailure["code"],
  messages: string[],
): DirectorAttemptFailure {
  return { attempt, code, messages: messages.slice(0, 12) };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 0 ? message : "Director generator failed";
}

function validateIdentity(
  observation: DirectorObservation,
  response: DirectorResponse,
): string[] {
  const messages: string[] = [];
  if (response.requestId !== observation.requestId) messages.push("requestId does not match the observation");
  if (response.stageSpec.seed !== observation.seed) messages.push("StageSpec seed does not match the observation");
  if (response.candidates.some((candidate) => candidate.baseMapVersion !== observation.mapVersion)) {
    messages.push("MapPatch baseMapVersion does not match the observation");
  }
  return messages;
}

export async function planDirector(
  observation: DirectorObservation,
  options: DirectorPlannerOptions,
  signal: AbortSignal,
): Promise<DirectorApiResult> {
  if (options.provider === "FIXTURE" || options.generate === undefined) {
    return DirectorApiResultSchema.parse({
      source: "FIXTURE",
      attempts: 0,
      response: fixtureDirectorResponse(observation),
      failures: [],
    });
  }

  const failures: DirectorAttemptFailure[] = [];
  const context = verifierContextFromObservation(observation);
  for (let attempt = 1; attempt <= MAX_DIRECTOR_ATTEMPTS; attempt += 1) {
    signal.throwIfAborted();
    let raw: unknown;
    try {
      raw = await options.generate({
        observation: structuredClone(observation),
        attempt,
        previousFailures: structuredClone(failures),
      }, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      failures.push(failure(attempt, "GENERATOR", [errorMessage(error)]));
      continue;
    }

    const parsed = DirectorResponseSchema.safeParse(raw);
    if (!parsed.success) {
      failures.push(failure(
        attempt,
        "SCHEMA",
        parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      ));
      continue;
    }

    const identityFailures = validateIdentity(observation, parsed.data);
    if (identityFailures.length > 0) {
      failures.push(failure(attempt, "IDENTITY", identityFailures));
      continue;
    }

    const decision = selectPatchCandidate(parsed.data.candidates, context);
    if (decision.selected === null) {
      failures.push(failure(
        attempt,
        "VERIFIER",
        decision.evaluations.flatMap((evaluation) =>
          evaluation.violations.map((violation) => `${evaluation.patch.patchId}/${violation.id}: ${violation.message}`)),
      ));
      continue;
    }

    return DirectorApiResultSchema.parse({
      source: "GEMINI_ADK",
      attempts: attempt,
      response: parsed.data,
      failures,
    });
  }

  signal.throwIfAborted();
  return DirectorApiResultSchema.parse({
    source: "FIXTURE",
    attempts: MAX_DIRECTOR_ATTEMPTS,
    response: fixtureDirectorResponse(observation),
    failures,
  });
}

const DIRECTOR_INSTRUCTION = `You are the CITY CORE Director for a deterministic multiplayer tag game.
Return exactly one response matching the supplied output schema. Propose one to three MapPatch candidates.
Use only raise_barrier, open_alley, or spawn_rooftop_bridge operations. Preserve requestId, Seed, and MapVersion.
Candidates are proposals only: the deterministic server verifier remains authoritative. Never target stations,
trap a player, repeatedly disadvantage one player, or exceed the local map update budget.`;

function generationPrompt(request: DirectorGenerationRequest): string {
  return JSON.stringify({
    task: "Generate a safe StageSpec and MapPatch candidates for this intervention.",
    attempt: request.attempt,
    previousFailures: request.previousFailures,
    observation: request.observation,
  });
}

export function createAdkGeminiGenerator(model: string): DirectorProposalGenerator {
  return async (request, signal) => {
    assertAdkRuntime(process.versions.node);
    signal.throwIfAborted();
    const { InMemoryRunner, LlmAgent } = await import("@google/adk");
    signal.throwIfAborted();
    const agent = new LlmAgent({
      name: "dopagaki_city_core_director",
      model,
      description: "Proposes schema-valid, verifier-gated CITY CORE interventions.",
      instruction: DIRECTOR_INSTRUCTION,
      outputSchema: DirectorResponseSchema,
      generateContentConfig: {
        temperature: 0.2,
        maxOutputTokens: 8_192,
      },
    });
    const runner = new InMemoryRunner({ agent, appName: "dopagaki-director" });
    const session = await runner.sessionService.createSession({
      appName: runner.appName,
      userId: request.observation.matchId,
    });
    signal.throwIfAborted();
    let finalText = "";
    for await (const event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {
        role: "user",
        parts: [{ text: generationPrompt(request) }],
      },
      abortSignal: signal,
    })) {
      const text = event.content?.parts
        ?.filter((part) => part.thought !== true && typeof part.text === "string")
        .map((part) => part.text)
        .join("");
      if (text !== undefined && text.trim().length > 0) finalText = text;
    }
    if (finalText.length === 0) throw new Error("ADK Director returned no final text");
    return JSON.parse(finalText) as unknown;
  };
}

export function assertAdkRuntime(version: string): void {
  const [major = 0, minor = 0] = version.split(".").map((value) => Number.parseInt(value, 10));
  if (major < 24 || (major === 24 && minor < 13)) {
    throw new Error("Gemini ADK mode requires Node.js 24.13 or newer");
  }
}
