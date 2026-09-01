import { DirectorApiResultSchema } from "@dopagaki/contracts";
import type { DirectorAdapter } from "./director-coordinator.js";

export type DirectorFetch = typeof fetch;

export function createDirectorHttpAdapter(
  baseUrl: string,
  fetchDirector: DirectorFetch = fetch,
): DirectorAdapter {
  const endpoint = new URL("/v1/director:plan", baseUrl).toString();
  return async (observation, signal) => {
    const response = await fetchDirector(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(observation),
      signal,
    });
    if (!response.ok) throw new Error(`Director API returned HTTP ${response.status}`);
    const result = DirectorApiResultSchema.parse(await response.json());
    if (result.source === "FIXTURE") {
      throw new Error("Director API requested deterministic Fixture fallback");
    }
    return result.response;
  };
}
