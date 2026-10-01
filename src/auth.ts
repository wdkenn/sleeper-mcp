/** Shared-secret gate for /mcp. No imports: tests run these with `node --test`. */

export const MCP_PATH = "/mcp";

export function bearerToken(request: Request): string {
  return (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
}

/**
 * Token from /mcp/<token>, for clients that cannot send headers. Everything after /mcp/ is the
 * token: base64 tokens can contain "/", so it is not a single path segment.
 */
export function pathToken(pathname: string): string | null {
  if (!pathname.startsWith(`${MCP_PATH}/`)) return null;
  try {
    return decodeURIComponent(pathname.slice(MCP_PATH.length + 1));
  } catch {
    return null;
  }
}

/** Constant-time for equal lengths, so the comparison does not leak how many leading chars match. */
export function tokensEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * Returns the request to hand to the MCP handler, or null when unauthorized.
 * A valid /mcp/<token> request is rewritten to /mcp, the only route the handler serves.
 */
export function authorize(request: Request, expected: string | undefined): Request | null {
  if (!expected) return null;
  const url = new URL(request.url);
  const fromPath = pathToken(url.pathname);
  if (fromPath !== null && tokensEqual(fromPath, expected)) {
    url.pathname = MCP_PATH;
    return new Request(url, request);
  }
  return tokensEqual(bearerToken(request), expected) ? request : null;
}
