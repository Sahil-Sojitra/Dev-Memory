import { createHash, timingSafeEqual } from "node:crypto";
import { ConfigurationError } from "../domain/errors.ts";

export interface BearerDigests {
  readonly bearerTokenSha256: string;
  readonly nextBearerTokenSha256: string | undefined;
}

export function createBearerVerifier(config: BearerDigests): (headers: Headers) => boolean {
  function decode(value: string, field: string): Buffer {
    if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new ConfigurationError([field]);
    return Buffer.from(value, "hex");
  }
  const current = decode(config.bearerTokenSha256, "MCP_BEARER_TOKEN_SHA256");
  // Always compare two fixed-size slots, even outside a rotation window.
  const next = config.nextBearerTokenSha256 === undefined ? Buffer.from(current)
    : decode(config.nextBearerTokenSha256, "MCP_BEARER_TOKEN_NEXT_SHA256");
  return (headers) => {
    const header = headers.get("authorization") ?? "";
    // Fetch merges duplicate header values with commas, which this grammar rejects.
    // Token entropy cannot be inferred from a digest: clients must generate it securely.
    const match = header.length <= 1024 ? /^Bearer ([A-Za-z0-9._~+\/-]+={0,2})$/i.exec(header) : null;
    const token = match?.[1];
    const validSyntax = token !== undefined && token.length >= 32 && token.length <= 512;
    const presented = createHash("sha256").update(validSyntax ? token : "").digest();
    const matchesCurrent = timingSafeEqual(presented, current);
    const matchesNext = timingSafeEqual(presented, next);
    // No short circuit between digest comparisons; no plaintext token is retained.
    return validSyntax && (Number(matchesCurrent) | Number(matchesNext)) !== 0;
  };
}

export function unauthorizedResponse(): Response {
  return Response.json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } }, {
    status: 401,
    headers: { "WWW-Authenticate": 'Bearer realm="devmemory"', "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
