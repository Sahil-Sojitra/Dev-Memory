import { createHash, timingSafeEqual } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createBearerVerifier, unauthorizedResponse } from "../src/transports/bearer.ts";
import { loadConfig } from "../src/config/environment.ts";
import { ConfigurationError } from "../src/domain/errors.ts";
import { FAKE_BEARER_SHA256, FAKE_BEARER_TOKEN, FAKE_NEXT_SHA256, FAKE_NEXT_TOKEN, FAKE_NOTION_TOKEN, validHttpEnvironment } from "./fixtures/environment.ts";

vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return { ...original, timingSafeEqual: vi.fn(original.timingSafeEqual) };
});

function verifier(next: string | undefined = undefined) {
  return createBearerVerifier({ bearerTokenSha256: FAKE_BEARER_SHA256, nextBearerTokenSha256: next });
}

describe("digest-only bearer verification", () => {
  it("accepts current and next tokens with case-insensitive scheme", () => {
    const verify = verifier(FAKE_NEXT_SHA256);
    expect(verify(new Headers({ authorization: "Bearer " + FAKE_BEARER_TOKEN }))).toBe(true);
    expect(verify(new Headers({ authorization: "bEaReR " + FAKE_NEXT_TOKEN }))).toBe(true);
    expect(verifier()(new Headers({ authorization: "Bearer " + FAKE_NEXT_TOKEN }))).toBe(false);
  });
  it("completes rotation by retiring the previous token", () => {
    const nextOnly = createBearerVerifier({ bearerTokenSha256: FAKE_NEXT_SHA256, nextBearerTokenSha256: undefined });
    expect(nextOnly(new Headers({ authorization: "Bearer " + FAKE_NEXT_TOKEN }))).toBe(true);
    expect(nextOnly(new Headers({ authorization: "Bearer " + FAKE_BEARER_TOKEN }))).toBe(false);
  });
  it.each([
    undefined, "", "Bearer", "Bearer ", "Basic " + FAKE_BEARER_TOKEN,
    "Bearer  " + FAKE_BEARER_TOKEN, "Bearer\t" + FAKE_BEARER_TOKEN,
    "Bearer \"" + FAKE_BEARER_TOKEN + "\"", "Bearer short",
    "Bearer " + "x".repeat(513), "Bearer " + "x".repeat(2048),
    "Bearer " + FAKE_BEARER_TOKEN + ", Bearer " + FAKE_NEXT_TOKEN,
    "Bearer " + "wrong-test-token-with-at-least-32-characters",
  ])("rejects malformed or incorrect header %s using two fixed-size comparisons", (authorization) => {
    const verify = verifier(FAKE_NEXT_SHA256);
    vi.mocked(timingSafeEqual).mockClear();
    expect(verify(new Headers(authorization === undefined ? {} : { authorization }))).toBe(false);
    expect(timingSafeEqual).toHaveBeenCalledTimes(2);
    for (const [left, right] of vi.mocked(timingSafeEqual).mock.calls) {
      expect(left.byteLength).toBe(32);
      expect(right.byteLength).toBe(32);
    }
  });
  it("always compares both slots on successful authentication too", () => {
    const verify = verifier();
    vi.mocked(timingSafeEqual).mockClear();
    expect(verify(new Headers({ authorization: "Bearer " + FAKE_BEARER_TOKEN }))).toBe(true);
    expect(timingSafeEqual).toHaveBeenCalledTimes(2);
  });
  it("rejects duplicate Authorization headers after Fetch combines them", () => {
    const headers = new Headers();
    headers.append("authorization", "Bearer " + FAKE_BEARER_TOKEN);
    headers.append("authorization", "Bearer " + FAKE_BEARER_TOKEN);
    expect(verifier()(headers)).toBe(false);
  });
  it.each(["", "a".repeat(63), "a".repeat(65), "z".repeat(64), "00", " a".repeat(32)])("rejects invalid digest %s before accepting any request", (value) => {
    expect(() => createBearerVerifier({ bearerTokenSha256: value, nextBearerTokenSha256: undefined })).toThrow(ConfigurationError);
    expect(() => createBearerVerifier({ bearerTokenSha256: FAKE_BEARER_SHA256, nextBearerTokenSha256: value })).toThrow(ConfigurationError);
    expect(() => loadConfig({ ...validHttpEnvironment, MCP_BEARER_TOKEN_SHA256: value })).toThrow(ConfigurationError);
    expect(() => loadConfig({ ...validHttpEnvironment, MCP_BEARER_TOKEN_NEXT_SHA256: value })).toThrow(ConfigurationError);
  });
  it("validates next digest, normalizes hex, and retains no plaintext bearer field", () => {
    const config = loadConfig({ ...validHttpEnvironment, MCP_BEARER_TOKEN_SHA256: FAKE_BEARER_SHA256.toUpperCase(), MCP_BEARER_TOKEN_NEXT_SHA256: FAKE_NEXT_SHA256 });
    expect(config.transport).toBe("http");
    if (config.transport !== "http") throw new Error("Expected HTTP");
    expect(config.http.bearerTokenSha256).toBe(FAKE_BEARER_SHA256);
    expect(config.http.nextBearerTokenSha256).toBe(FAKE_NEXT_SHA256);
    expect(config.http).not.toHaveProperty("bearerToken");
    expect(JSON.stringify(config)).not.toContain(FAKE_BEARER_TOKEN);
    expect(() => loadConfig({ ...validHttpEnvironment, MCP_BEARER_TOKEN: FAKE_BEARER_TOKEN })).toThrow(ConfigurationError);
  });
  it("rejects the Notion credential's digest in either slot", () => {
    const digest = createHash("sha256").update(FAKE_NOTION_TOKEN).digest("hex");
    expect(() => loadConfig({ ...validHttpEnvironment, MCP_BEARER_TOKEN_SHA256: digest })).toThrow(ConfigurationError);
    expect(() => loadConfig({ ...validHttpEnvironment, MCP_BEARER_TOKEN_NEXT_SHA256: digest })).toThrow(ConfigurationError);
  });
  it("uses an invariant safe challenge and response body", async () => {
    const response = unauthorizedResponse();
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="devmemory"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } });
  });
});
