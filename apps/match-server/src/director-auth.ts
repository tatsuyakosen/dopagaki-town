import type { DirectorFetch } from "./director-http-adapter.js";

export interface DirectorIdTokenClient {
  getRequestHeaders: () => Promise<{ get: (name: string) => string | null }>;
}

export type DirectorIdTokenClientFactory = (
  audience: string,
) => Promise<DirectorIdTokenClient>;

async function createGoogleIdTokenClient(audience: string): Promise<DirectorIdTokenClient> {
  const { GoogleAuth } = await import("google-auth-library");
  return new GoogleAuth().getIdTokenClient(audience);
}

export function createGoogleIdTokenFetch(
  audience: string,
  fetchDirector: DirectorFetch = fetch,
  createClient: DirectorIdTokenClientFactory = createGoogleIdTokenClient,
): DirectorFetch {
  const normalizedAudience = audience.trim();
  if (normalizedAudience.length === 0) throw new Error("DIRECTOR_AUDIENCE must not be empty");
  let clientPromise: Promise<DirectorIdTokenClient> | undefined;

  return async (input, init) => {
    init?.signal?.throwIfAborted();
    clientPromise ??= createClient(normalizedAudience);
    const client = await clientPromise;
    init?.signal?.throwIfAborted();
    const authHeaders = await client.getRequestHeaders();
    init?.signal?.throwIfAborted();
    const authorization = authHeaders.get("authorization");
    if (authorization === null || authorization.length === 0) {
      throw new Error("Google ID token client returned no authorization header");
    }
    const headers = new Headers(init?.headers);
    headers.set("authorization", authorization);
    return fetchDirector(input, { ...init, headers });
  };
}
