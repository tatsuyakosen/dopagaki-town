import { describe, expect, it, vi } from "vitest";
import {
  createGoogleIdTokenFetch,
  type DirectorIdTokenClientFactory,
} from "../src/director-auth.js";

describe("Director Cloud Run authentication", () => {
  it("lazily adds a Google ID token and reuses the audience-bound client", async () => {
    const getRequestHeaders = vi.fn(() => Promise.resolve(new Headers({
      authorization: "Bearer signed-id-token",
    })));
    const createClient = vi.fn<DirectorIdTokenClientFactory>(() => Promise.resolve({ getRequestHeaders }));
    const fetchDirector = vi.fn<typeof fetch>((_input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer signed-id-token");
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    const authenticatedFetch = createGoogleIdTokenFetch(
      "https://director.example.run.app",
      fetchDirector,
      createClient,
    );

    await authenticatedFetch("https://director.example.run.app/v1/director:plan");
    await authenticatedFetch("https://director.example.run.app/healthz");

    expect(createClient).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledWith("https://director.example.run.app");
    expect(getRequestHeaders).toHaveBeenCalledTimes(2);
    expect(fetchDirector).toHaveBeenCalledTimes(2);
  });

  it("does not invoke credentials or HTTP after cancellation", async () => {
    const createClient = vi.fn<DirectorIdTokenClientFactory>();
    const fetchDirector = vi.fn<typeof fetch>();
    const authenticatedFetch = createGoogleIdTokenFetch(
      "https://director.example.run.app",
      fetchDirector,
      createClient,
    );
    const controller = new AbortController();
    controller.abort(new Error("request cancelled"));

    await expect(authenticatedFetch("https://director.example.run.app", {
      signal: controller.signal,
    })).rejects.toThrow("request cancelled");
    expect(createClient).not.toHaveBeenCalled();
    expect(fetchDirector).not.toHaveBeenCalled();
  });

  it("rejects a credential client that does not return an authorization header", async () => {
    const authenticatedFetch = createGoogleIdTokenFetch(
      "https://director.example.run.app",
      vi.fn<typeof fetch>(),
      () => Promise.resolve({
        getRequestHeaders: () => Promise.resolve(new Headers()),
      }),
    );

    await expect(authenticatedFetch("https://director.example.run.app")).rejects.toThrow(
      "no authorization header",
    );
  });
});
