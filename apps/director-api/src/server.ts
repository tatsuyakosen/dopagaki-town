import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  DirectorObservationSchema,
  type DirectorApiResult,
  type DirectorObservation,
} from "@dopagaki/contracts";
import {
  createAdkGeminiGenerator,
  planDirector,
  type DirectorPlannerOptions,
} from "./planner.js";

const MAX_REQUEST_BYTES = 1_000_000;

export interface DirectorServiceConfig {
  provider: "FIXTURE" | "GEMINI_ADK";
  model: string;
  planner?: DirectorPlannerOptions;
}

export interface DirectorServiceResponse {
  status: number;
  body: unknown;
}

function plannerOptions(config: DirectorServiceConfig): DirectorPlannerOptions {
  if (config.planner !== undefined) return config.planner;
  if (config.provider === "GEMINI_ADK") {
    return {
      provider: "GEMINI_ADK",
      generate: createAdkGeminiGenerator(config.model),
    };
  }
  return { provider: "FIXTURE" };
}

export async function processDirectorRequest(
  body: unknown,
  config: DirectorServiceConfig,
  signal: AbortSignal,
): Promise<DirectorServiceResponse> {
  const observation = DirectorObservationSchema.safeParse(body);
  if (!observation.success) {
    return {
      status: 400,
      body: {
        code: "INVALID_OBSERVATION",
        issues: observation.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    };
  }
  const startedAt = performance.now();
  const result = await planDirector(observation.data, plannerOptions(config), signal);
  logResult(observation.data, result, performance.now() - startedAt, config.model);
  return { status: 200, body: result };
}

function logResult(
  observation: DirectorObservation,
  result: DirectorApiResult,
  latencyMs: number,
  model: string,
): void {
  process.stdout.write(`${JSON.stringify({
    severity: "INFO",
    event: "DIRECTOR_PLAN",
    requestId: observation.requestId,
    matchId: observation.matchId,
    seed: observation.seed,
    sequence: observation.sequence,
    mapVersion: observation.mapVersion,
    source: result.source,
    model: result.source === "GEMINI_ADK" ? model : null,
    attempts: result.attempts,
    failureCodes: result.failures.map((entry) => entry.code),
    latencyMs: Math.round(latencyMs),
  })}\n`);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    received += buffer.length;
    if (received > MAX_REQUEST_BYTES) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: DirectorServiceConfig,
): Promise<void> {
  if (request.method === "GET" && (request.url === "/health" || request.url === "/healthz")) {
    sendJson(response, 200, { ok: true, provider: config.provider, model: config.model });
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/director:plan") {
    sendJson(response, 404, { code: "NOT_FOUND" });
    return;
  }

  const abortController = new AbortController();
  request.once("aborted", () => abortController.abort());
  response.once("close", () => {
    if (!response.writableEnded) abortController.abort();
  });
  try {
    const body = await readJson(request);
    const result = await processDirectorRequest(body, config, abortController.signal);
    if (!response.writableEnded) sendJson(response, result.status, result.body);
  } catch (error) {
    if (response.writableEnded) return;
    const message = error instanceof Error ? error.message : String(error);
    const status = message === "REQUEST_TOO_LARGE" ? 413 : error instanceof SyntaxError ? 400 : 500;
    sendJson(response, status, { code: status === 500 ? "DIRECTOR_ERROR" : "INVALID_REQUEST", message });
  }
}

export function createDirectorServer(config: DirectorServiceConfig): Server {
  return createServer((request, response) => {
    void handleRequest(request, response, config);
  });
}
