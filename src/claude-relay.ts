import { randomBytes } from "node:crypto";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { Transform } from "node:stream";
import { URL } from "node:url";

const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;
const DUMMY_AUTH_TOKEN = "pi-plan-execute-relay";
const ALLOWED_API_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);
const FORBIDDEN_FORWARD_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  "authorization", "x-api-key", "host", "content-length", "cookie", "set-cookie",
]);
const REQUEST_HEADER_ALLOWLIST = new Set([
  "accept", "content-type", "anthropic-version", "anthropic-beta", "user-agent",
]);

export interface ClaudeCredentialRelayOptions {
  modelRoute: string;
  env?: NodeJS.ProcessEnv;
  maxRequestBytes?: number;
  maxConcurrent?: number;
  upstreamTimeoutMs?: number;
}

export interface ClaudeCredentialRelay {
  readonly baseUrl: string;
  readonly dummyAuthToken: string;
  close(): Promise<void>;
}

interface ResolvedCredential {
  readonly headerName: "authorization" | "x-api-key";
  readonly headerValue: string;
  readonly secretValues: readonly string[];
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveCredential(env: NodeJS.ProcessEnv): ResolvedCredential {
  const authToken = env.ANTHROPIC_AUTH_TOKEN?.trim();
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (authToken) {
    return {
      headerName: "authorization",
      headerValue: `Bearer ${authToken}`,
      secretValues: [authToken, `Bearer ${authToken}`],
    };
  }
  if (apiKey) {
    return { headerName: "x-api-key", headerValue: apiKey, secretValues: [apiKey] };
  }
  throw new Error(
    "Claude isolated ACP requires a host-side ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY; " +
    "real credentials are never forwarded into the agent sandbox.",
  );
}

function resolveUpstream(env: NodeJS.ProcessEnv): URL {
  const raw = env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("ANTHROPIC_BASE_URL is not a valid URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("ANTHROPIC_BASE_URL must be a credential-free HTTP(S) URL without query or fragment.");
  }
  return url;
}

function parseCustomHeaders(env: NodeJS.ProcessEnv): { headers: Record<string, string>; secretValues: string[] } {
  const headers: Record<string, string> = {};
  const secretValues: string[] = [];
  const raw = env.ANTHROPIC_CUSTOM_HEADERS;
  if (!raw) return { headers, secretValues };
  for (const [index, line] of raw.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error(`ANTHROPIC_CUSTOM_HEADERS entry ${index + 1} is malformed.`);
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name) || /[\r\n]/u.test(value)) {
      throw new Error(`ANTHROPIC_CUSTOM_HEADERS entry ${index + 1} contains an invalid HTTP header.`);
    }
    if (FORBIDDEN_FORWARD_HEADERS.has(name)) {
      throw new Error(`ANTHROPIC_CUSTOM_HEADERS may not override protected header ${name}.`);
    }
    headers[name] = value;
    if (value.length >= 8) secretValues.push(value);
  }
  return { headers, secretValues };
}

function selectedClaudeModel(modelRoute: string): string {
  if (!modelRoute.startsWith("claude/")) throw new Error(`Invalid Claude model route: ${modelRoute}`);
  const model = modelRoute.slice("claude/".length).trim();
  if (!model || /[\u0000-\u001f\u007f]/u.test(model)) throw new Error(`Invalid Claude model route: ${modelRoute}`);
  return model;
}

function modelAllowed(selected: string, requested: string): boolean {
  if (requested === selected) return true;
  const base = selected.replace(/\[[^\]]+\]$/u, "");
  if (base === "sonnet") return requested.startsWith("claude-sonnet-");
  if (base === "opus") return requested.startsWith("claude-opus-");
  if (base === "haiku") return requested.startsWith("claude-haiku-");
  return false;
}

async function readBoundedBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += data.byteLength;
    if (total > maxBytes) throw Object.assign(new Error("request too large"), { statusCode: 413 });
    chunks.push(data);
  }
  return Buffer.concat(chunks, total);
}

function requestHeaders(source: IncomingHttpHeaders, hostHeaders: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = { ...hostHeaders };
  for (const [rawName, rawValue] of Object.entries(source)) {
    const name = rawName.toLowerCase();
    if (FORBIDDEN_FORWARD_HEADERS.has(name)) continue;
    if (!REQUEST_HEADER_ALLOWLIST.has(name) && !name.startsWith("x-stainless-")) continue;
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
    if (typeof value === "string") result[name] = value;
  }
  result["content-type"] ??= "application/json";
  result.accept ??= "application/json";
  return result;
}

function safeResponseHeaders(
  source: IncomingHttpHeaders,
  secretHeaderNames: ReadonlySet<string>,
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [rawName, rawValue] of Object.entries(source)) {
    const name = rawName.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(name) ||
      name === "content-length" ||
      name === "content-encoding" ||
      name === "authorization" ||
      name === "x-api-key" ||
      name === "set-cookie" ||
      secretHeaderNames.has(name) ||
      rawValue === undefined
    ) continue;
    result[name] = rawValue;
  }
  return result;
}

class SecretScrubber extends Transform {
  private pending = Buffer.alloc(0);
  private readonly patterns: Buffer[];
  private readonly maxPatternBytes: number;

  constructor(secrets: readonly string[]) {
    super();
    this.patterns = [...new Set(secrets.filter(Boolean))]
      .map((value) => Buffer.from(value, "utf8"))
      .sort((a, b) => b.byteLength - a.byteLength);
    this.maxPatternBytes = Math.max(1, ...this.patterns.map((pattern) => pattern.byteLength));
  }

  private drain(flush: boolean): void {
    const input = this.pending;
    const safeEnd = flush ? input.byteLength : Math.max(0, input.byteLength - (this.maxPatternBytes - 1));
    const output: Buffer[] = [];
    let cursor = 0;
    while (cursor < safeEnd) {
      const match = this.patterns.find((pattern) =>
        cursor + pattern.byteLength <= input.byteLength &&
        input.subarray(cursor, cursor + pattern.byteLength).equals(pattern),
      );
      if (match) {
        output.push(Buffer.from("[REDACTED]", "utf8"));
        cursor += match.byteLength;
      } else {
        output.push(input.subarray(cursor, cursor + 1));
        cursor += 1;
      }
    }
    this.pending = input.subarray(cursor);
    if (output.length) this.push(Buffer.concat(output));
  }

  override _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const data = Buffer.from(chunk);
    this.pending = this.pending.byteLength ? Buffer.concat([this.pending, data]) : data;
    this.drain(false);
    callback();
  }

  override _flush(callback: (error?: Error | null) => void): void {
    this.drain(true);
    if (this.pending.byteLength) this.push(this.pending);
    this.pending = Buffer.alloc(0);
    callback();
  }
}

function responseError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = Buffer.from(JSON.stringify({ error: message }) + "\n", "utf8");
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(body.byteLength),
    "cache-control": "no-store",
  });
  res.end(body);
}

export async function startClaudeCredentialRelay(
  options: ClaudeCredentialRelayOptions,
): Promise<ClaudeCredentialRelay> {
  const env = options.env ?? process.env;
  const credential = resolveCredential(env);
  const upstream = resolveUpstream(env);
  const selectedModel = selectedClaudeModel(options.modelRoute);
  const custom = parseCustomHeaders(env);
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1024) throw new Error("Invalid Claude relay request-size limit.");
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 32) throw new Error("Invalid Claude relay concurrency limit.");
  if (!Number.isSafeInteger(upstreamTimeoutMs) || upstreamTimeoutMs < 1_000) throw new Error("Invalid Claude relay timeout.");

  const capability = randomBytes(32).toString("base64url");
  const prefix = `/${capability}`;
  const injectedHeaders: Record<string, string> = {
    ...custom.headers,
    [credential.headerName]: credential.headerValue,
  };
  const secretHeaderNames = new Set<string>([credential.headerName, ...Object.keys(custom.headers)]);
  const secrets = [...credential.secretValues, ...custom.secretValues].filter((value) => value.length >= 4);
  let active = 0;
  let closing = false;
  const sockets = new Set<import("node:net").Socket>();

  const server = createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    let admitted = false;
    try {
      if (closing) return responseError(res, 503, "relay closing");
      const remote = req.socket.remoteAddress;
      if (remote !== "127.0.0.1" && remote !== "::ffff:127.0.0.1" && remote !== "::1") {
        return responseError(res, 403, "loopback only");
      }
      if (active >= maxConcurrent) return responseError(res, 429, "relay concurrency limit");
      if (req.method !== "POST") return responseError(res, 405, "method not allowed");
      const incoming = new URL(req.url ?? "/", "http://relay.invalid");
      if (incoming.search || incoming.hash || !incoming.pathname.startsWith(`${prefix}/`)) {
        return responseError(res, 404, "not found");
      }
      const apiPath = incoming.pathname.slice(prefix.length);
      if (!ALLOWED_API_PATHS.has(apiPath)) return responseError(res, 404, "endpoint not allowed");
      if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") {
        return responseError(res, 415, "request compression is not allowed");
      }

      active += 1;
      admitted = true;
      let body: Buffer;
      try {
        body = await readBoundedBody(req, maxRequestBytes);
      } catch (error) {
        const status = plainObject(error) && typeof error.statusCode === "number" ? error.statusCode : 400;
        return responseError(res, status, "invalid request body");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        return responseError(res, 400, "request body must be JSON");
      }
      const requestedModel = plainObject(parsed) && typeof parsed.model === "string" ? parsed.model : undefined;
      if (!requestedModel || !modelAllowed(selectedModel, requestedModel)) {
        return responseError(res, 403, "requested model does not match the approved Claude route");
      }

      const target = new URL(upstream.toString());
      const upstreamBase = target.pathname.endsWith("/") ? target.pathname.slice(0, -1) : target.pathname;
      target.pathname = `${upstreamBase}${apiPath}`;
      target.search = "";
      target.hash = "";
      const headers = requestHeaders(req.headers, injectedHeaders);
      headers["content-length"] = String(body.byteLength);
      headers.host = target.host;

      await new Promise<void>((resolve) => {
        const requester = target.protocol === "https:" ? httpsRequest : httpRequest;
        const upstreamRequest = requester(target, {
          method: "POST",
          headers,
        }, (upstreamResponse) => {
          const encoding = upstreamResponse.headers["content-encoding"];
          if (encoding && encoding !== "identity") {
            upstreamResponse.resume();
            responseError(res, 502, "compressed upstream responses are not accepted");
            resolve();
            return;
          }
          const headersOut = safeResponseHeaders(upstreamResponse.headers, secretHeaderNames);
          res.writeHead(upstreamResponse.statusCode ?? 502, headersOut);
          const scrubber = new SecretScrubber(secrets);
          upstreamResponse.pipe(scrubber).pipe(res);
          const finish = () => resolve();
          upstreamResponse.once("end", finish);
          upstreamResponse.once("error", () => {
            if (!res.headersSent) responseError(res, 502, "upstream response failed");
            else res.destroy();
            finish();
          });
        });
        upstreamRequest.setTimeout(upstreamTimeoutMs, () => upstreamRequest.destroy(new Error("upstream timeout")));
        upstreamRequest.once("error", () => {
          responseError(res, 502, "upstream request failed");
          resolve();
        });
        req.once("aborted", () => upstreamRequest.destroy());
        res.once("close", () => {
          if (!res.writableEnded) upstreamRequest.destroy();
        });
        upstreamRequest.end(body);
      });
    } catch {
      responseError(res, 500, "relay failure");
    } finally {
      if (admitted) active -= 1;
    }
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Claude credential relay failed to bind a loopback TCP port.");
  }

  let closed = false;
  return {
    baseUrl: `http://127.0.0.1:${address.port}${prefix}`,
    dummyAuthToken: DUMMY_AUTH_TOKEN,
    async close() {
      if (closed) return;
      closed = true;
      closing = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
