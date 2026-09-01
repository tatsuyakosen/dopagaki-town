import type { DirectorObservation } from "@dopagaki/contracts";
import {
  applyDirectorPlan,
  directorInterventionDue,
  directorObservationOf,
  directorVerifierContextOf,
  type GameState,
} from "@dopagaki/game-core";
import { resolveDirectorPlan } from "@dopagaki/verifier";

export type DirectorAdapter = (
  observation: DirectorObservation,
  signal: AbortSignal,
) => Promise<unknown>;

export interface DirectorCoordinatorConfig {
  currentGame: () => GameState;
  adapter: DirectorAdapter;
  timeoutMs?: number;
}

export interface DirectorCoordinatorStatus {
  inFlightRequestId: string | null;
  requestCount: number;
  appliedCount: number;
  fixtureFallbackCount: number;
  staleResponseCount: number;
}

interface ActiveRequest {
  epoch: number;
  observation: DirectorObservation;
  game: GameState;
  abortController: AbortController;
}

export class DirectorCoordinator {
  private readonly currentGame: () => GameState;
  private readonly adapter: DirectorAdapter;
  private readonly timeoutMs: number;
  private activeRequest: ActiveRequest | null = null;
  private epoch = 0;
  private requestCount = 0;
  private appliedCount = 0;
  private fixtureFallbackCount = 0;
  private staleResponseCount = 0;

  constructor(config: DirectorCoordinatorConfig) {
    this.currentGame = config.currentGame;
    this.adapter = config.adapter;
    this.timeoutMs = Math.max(1, config.timeoutMs ?? 1_000);
  }

  poll(): void {
    if (this.activeRequest !== null) return;
    const game = this.currentGame();
    if (!directorInterventionDue(game)) return;
    const request: ActiveRequest = {
      epoch: this.epoch,
      observation: directorObservationOf(game),
      game,
      abortController: new AbortController(),
    };
    this.activeRequest = request;
    this.requestCount += 1;
    void this.resolve(request);
  }

  reset(): void {
    this.epoch += 1;
    this.activeRequest?.abortController.abort();
    this.activeRequest = null;
  }

  status(): DirectorCoordinatorStatus {
    return {
      inFlightRequestId: this.activeRequest?.observation.requestId ?? null,
      requestCount: this.requestCount,
      appliedCount: this.appliedCount,
      fixtureFallbackCount: this.fixtureFallbackCount,
      staleResponseCount: this.staleResponseCount,
    };
  }

  private isCurrent(request: ActiveRequest): boolean {
    const game = this.currentGame();
    return request.epoch === this.epoch
      && request.game === game
      && request.observation.matchId === game.matchId
      && request.observation.seed === game.seed
      && request.observation.sequence === game.interventionSequence
      && request.observation.mapVersion === game.mapVersion;
  }

  private async resolve(request: ActiveRequest): Promise<void> {
    try {
      const plan = await resolveDirectorPlan({
        requestId: request.observation.requestId,
        seed: request.observation.seed,
        sequence: request.observation.sequence,
        context: directorVerifierContextOf(request.game),
        timeoutMs: this.timeoutMs,
        loadExternal: () => this.adapter(
          structuredClone(request.observation),
          request.abortController.signal,
        ),
      });
      if (!this.isCurrent(request)) {
        this.staleResponseCount += 1;
        return;
      }
      if (plan.source === "FIXTURE") this.fixtureFallbackCount += 1;
      const result = applyDirectorPlan(this.currentGame(), plan);
      if (result.accepted) this.appliedCount += 1;
      else if (result.code === "STALE") this.staleResponseCount += 1;
    } finally {
      request.abortController.abort();
      if (this.activeRequest === request) this.activeRequest = null;
    }
  }
}
