import { test } from "node:test";
import assert from "node:assert/strict";
import { authorize, pathToken, tokensEqual } from "../src/auth.ts";

// Shaped like `openssl rand -base64 32`: includes "/", "+" and "=".
const TOKEN = "ab/cd+EF0123456789ghijklmnopqrstuvwxyzABCD=";
const req = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://w.example${path}`, { method: "POST", headers, body: '{"jsonrpc":"2.0"}' });

test("bearer header is accepted, case-insensitive scheme", async () => {
  for (const h of [`Bearer ${TOKEN}`, `bearer  ${TOKEN}`]) {
    const out = authorize(req("/mcp", { Authorization: h }), TOKEN);
    assert.ok(out);
    assert.equal(new URL(out.url).pathname, "/mcp");
    assert.equal(await out.text(), '{"jsonrpc":"2.0"}');
  }
});

test("wrong, missing, or partial tokens are rejected", () => {
  assert.equal(authorize(req("/mcp"), TOKEN), null);
  assert.equal(authorize(req("/mcp", { Authorization: "Bearer nope" }), TOKEN), null);
  assert.equal(authorize(req("/mcp", { Authorization: `Bearer ${TOKEN.slice(0, -1)}` }), TOKEN), null);
  assert.equal(authorize(req(`/mcp/${TOKEN}x`), TOKEN), null);
});

test("no secret configured rejects everything, including an empty token", () => {
  assert.equal(authorize(req("/mcp", { Authorization: "Bearer " }), undefined), null);
  assert.equal(authorize(req("/mcp", { Authorization: "Bearer " }), ""), null);
  assert.equal(authorize(req("/mcp/"), ""), null);
});

test("path token with base64 / + = is accepted raw or percent-encoded and rewritten to /mcp", async () => {
  for (const p of [`/mcp/${TOKEN}`, `/mcp/${encodeURIComponent(TOKEN)}`]) {
    const out = authorize(req(p), TOKEN);
    assert.ok(out, p);
    assert.equal(new URL(out.url).pathname, "/mcp");
    assert.equal(out.method, "POST");
    assert.equal(await out.text(), '{"jsonrpc":"2.0"}');
  }
});

test("pathToken and tokensEqual edge cases", () => {
  assert.equal(pathToken("/mcp"), null);
  assert.equal(pathToken("/mcpx/abc"), null);
  assert.equal(pathToken("/mcp/%E0%A4%A"), null);
  assert.ok(tokensEqual("abc", "abc"));
  assert.ok(!tokensEqual("abc", "abd"));
  assert.ok(!tokensEqual("abc", "abcd"));
});
