import { createServer, type IncomingMessage } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { startClaudeCredentialRelay } from "../src/claude-relay.js";

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

test("Claude credential relay injects host auth, pins model/path, and never reflects secrets", async () => {
  const seen: Array<{ url: string | undefined; authorization: string | undefined; route: string | undefined; body: string }> = [];
  const upstream = createServer(async (req, res) => {
    seen.push({
      url: req.url,
      authorization: req.headers.authorization,
      route: typeof req.headers["x-tenant-route"] === "string" ? req.headers["x-tenant-route"] : undefined,
      body: await body(req),
    });
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "authorization": "Bearer TOP_SECRET_RELAY_TOKEN",
      "x-tenant-route": "tenant-secret-value",
      "x-upstream-echo": "TOP_SECRET_RELAY_TOKEN",
      "location": "https://example.invalid/?secret=TOP_SECRET_RELAY_TOKEN",
      "request-id": "request-TOP_SECRET_RELAY_TOKEN",
    });
    res.write('data: {"type":"message_start","secret":"TOP_SECRET_');
    res.end('RELAY_TOKEN","route":"tenant-secret-value"}\n\n');
  });
  const upstreamUrl = await listen(upstream);
  const relay = await startClaudeCredentialRelay({
    modelRoute: "claude/sonnet",
    env: {
      ANTHROPIC_AUTH_TOKEN: "TOP_SECRET_RELAY_TOKEN",
      ANTHROPIC_BASE_URL: upstreamUrl,
      ANTHROPIC_CUSTOM_HEADERS: "X-Tenant-Route: tenant-secret-value",
    },
  });
  try {
    const response = await fetch(`${relay.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sandbox-attacker-value",
        "x-tenant-route": "sandbox-attacker-route",
      },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 8, messages: [{ role: "user", content: "OK" }] }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.doesNotMatch(text, /TOP_SECRET_RELAY_TOKEN|tenant-secret-value/);
    assert.match(text, /\[REDACTED\]/);
    assert.equal(response.headers.has("authorization"), false);
    assert.equal(response.headers.has("x-tenant-route"), false);
    assert.equal(response.headers.has("x-upstream-echo"), false);
    assert.equal(response.headers.has("location"), false);
    assert.equal(response.headers.has("request-id"), false);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.url, "/v1/messages");
    assert.equal(seen[0]?.authorization, "Bearer TOP_SECRET_RELAY_TOKEN");
    assert.equal(seen[0]?.route, "tenant-secret-value");
    assert.match(seen[0]?.body ?? "", /"model":"claude-sonnet-5"/);
    assert.doesNotMatch(seen[0]?.authorization ?? "", /sandbox-attacker/);
  } finally {
    await relay.close();
    await relay.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("Claude credential relay rejects unapproved endpoints and models before upstream", async () => {
  let hits = 0;
  const upstream = createServer((_req, res) => {
    hits += 1;
    res.writeHead(500);
    res.end();
  });
  const upstreamUrl = await listen(upstream);
  const relay = await startClaudeCredentialRelay({
    modelRoute: "claude/claude-sonnet-5",
    env: { ANTHROPIC_API_KEY: "host-api-key-secret", ANTHROPIC_BASE_URL: upstreamUrl },
  });
  try {
    const wrongPath = await fetch(`${relay.baseUrl}/v1/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5" }),
    });
    assert.equal(wrongPath.status, 404);

    const wrongModel = await fetch(`${relay.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-5" }),
    });
    assert.equal(wrongModel.status, 403);

    const query = await fetch(`${relay.baseUrl}/v1/messages?target=https://example.invalid`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5" }),
    });
    assert.equal(query.status, 404);
    assert.equal(hits, 0);
  } finally {
    await relay.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("Claude credential relay fails closed on missing auth and unsafe upstream/header configuration", async () => {
  await assert.rejects(
    startClaudeCredentialRelay({ modelRoute: "claude/sonnet", env: {} }),
    /requires a host-side ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY/,
  );
  await assert.rejects(
    startClaudeCredentialRelay({
      modelRoute: "claude/sonnet",
      env: { ANTHROPIC_AUTH_TOKEN: "secret", ANTHROPIC_BASE_URL: "https://user:pass@example.com" },
    }),
    /credential-free HTTP\(S\)/,
  );
  await assert.rejects(
    startClaudeCredentialRelay({
      modelRoute: "claude/sonnet",
      env: { ANTHROPIC_AUTH_TOKEN: "fake-review-token", ANTHROPIC_BASE_URL: "http://192.0.2.10" },
    }),
    /non-loopback plaintext HTTP upstream/,
  );
  await assert.rejects(
    startClaudeCredentialRelay({
      modelRoute: "claude/sonnet",
      env: {
        ANTHROPIC_AUTH_TOKEN: "secret",
        ANTHROPIC_CUSTOM_HEADERS: "Authorization: should-not-override",
      },
    }),
    /may not override protected header authorization/,
  );
});
