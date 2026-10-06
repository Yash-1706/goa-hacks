import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A faithful stand-in for Groq's OpenAI-compatible POST /openai/v1/chat/completions (streaming and not), GET /openai/v1/models.
 * Everything here was measured against the real endpoint on a free-tier key:
 *  - SSE chunks: a role chunk, `delta.reasoning` chunks (gpt-oss), `delta.content` chunk(s), a chunk with finish_reason and
 *    usage (also under `x_groq.usage`), a usage-only chunk with `choices: []`, then `data: [DONE]`.
 *  - gpt-oss delivers the answer as ONE content chunk after the reasoning; other models stream token by token.
 *  - errors are { error: { message, type, code } } with the right status; 413 and 429 carry `retry-after`.
 *  - x-ratelimit-* headers on every response; the tokens-per-minute bucket (8,000, refilled continuously) admits a call only
 *    while remaining >= prompt tokens + max_completion_tokens (else 429), and charges what was really used afterwards.
 * Used to test GroqCortex / GroqClient / DeepLlm without a key.
 */
export type FakeMode =
  | {
      kind: "ok";
      /** the answer: an object is serialised to JSON, a string is sent as is */
      json: unknown;
      /** gpt-oss style: this many reasoning chunks first, then the whole answer in one content chunk */
      oneChunk?: boolean;
      reasoningChunks?: number;
      chunkChars?: number;
      chunkDelayMs?: number;
      finishReason?: string;
      promptTokens?: number;
      completionTokens?: number;
      reasoningTokens?: number;
      cachedTokens?: number;
    }
  | { kind: "status"; status: number; code: string; message: string; retryAfter?: string }
  | { kind: "slow"; delayMs: number }
  | { kind: "garbage"; text: string }
  /** the connection ends after part of the answer, with no finish_reason and no [DONE] */
  | { kind: "truncated"; json: unknown }
  /** an SSE `event: error` frame mid-stream (what Groq sends when its own JSON check fails) */
  | { kind: "stream_error"; code: string };

export interface FakeRequest {
  body: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
  url: string;
  /** injected-clock time of arrival */
  at: number;
}

export interface FakeGroqOpts {
  initial?: FakeMode[];
  /** enforce the tokens-per-minute bucket like the real API (default false) */
  enforceLimits?: boolean;
  /** injected clock (ms) for the bucket and the reset headers; default Date.now */
  now?: () => number;
  tpm?: number;
}

export interface FakeGroq {
  /** the base URL to hand to the client: http://127.0.0.1:port/openai/v1 */
  url: string;
  requests: FakeRequest[];
  /** chat completions served (rejected ones included), models pings excluded */
  script: FakeMode[];
  reset(...script: FakeMode[]): void;
  /** tokens the fake's own bucket for `model` thinks are left */
  available(model?: string): number;
  /** drain the fake's bucket for `model`, as if another process on the same key had used it */
  drain(tokens: number, model?: string): void;
  close(): Promise<void>;
}

const REQ_ID = "req_fake0000000000000000000000";
const DEFAULT_MODEL = "openai/gpt-oss-20b";

export async function startFakeGroq(o: FakeGroqOpts = {}): Promise<FakeGroq> {
  const now = o.now ?? Date.now;
  const tpm = o.tpm ?? 8000;
  let n = 0;
  // Groq meters tokens per model ("... for model `openai/gpt-oss-20b` ..."): one bucket each, refilled continuously
  const buckets = new Map<string, { tokens: number; last: number }>();
  const bucket = (model: string): { tokens: number; last: number } => {
    let b = buckets.get(model);
    if (!b) {
      b = { tokens: tpm, last: now() };
      buckets.set(model, b);
    }
    const t = now();
    if (t > b.last) b.tokens = Math.min(tpm, b.tokens + ((t - b.last) * tpm) / 60_000);
    b.last = t;
    return b;
  };
  const state: FakeGroq = {
    url: "",
    requests: [],
    script: o.initial ?? [],
    reset(...script) {
      state.script = script;
      state.requests.length = 0;
      n = 0;
      buckets.clear();
    },
    available: (model = DEFAULT_MODEL) => bucket(model).tokens,
    drain(k, model = DEFAULT_MODEL) {
      bucket(model).tokens -= k;
    },
    close: async () => {},
  };

  const rateHeaders = (model: string): Record<string, string> => {
    const { tokens } = bucket(model);
    const deficit = tpm - tokens;
    return {
      "x-ratelimit-limit-requests": "1000",
      "x-ratelimit-limit-tokens": String(tpm),
      "x-ratelimit-remaining-requests": String(Math.max(0, 1000 - state.requests.length)),
      "x-ratelimit-remaining-tokens": String(Math.max(0, Math.floor(tokens))),
      "x-ratelimit-reset-requests": "1m26.4s",
      "x-ratelimit-reset-tokens": `${(Math.max(0, deficit) / (tpm / 60)).toFixed(3)}s`,
    };
  };

  const err = (res: http.ServerResponse, model: string, status: number, code: string, type: string, message: string, extra: Record<string, string> = {}): void => {
    res.writeHead(status, { "content-type": "application/json", ...rateHeaders(model), ...extra });
    res.end(JSON.stringify({ error: { message, type, code } }));
  };

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = req.url ?? "";
    if (req.method === "GET" && url.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "openai/gpt-oss-20b", object: "model" }] }));
      return;
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      /* ignore */
    }
    state.requests.push({ body, headers: req.headers, url, at: now() });
    const mode: FakeMode = state.script[Math.min(n++, state.script.length - 1)] ?? { kind: "garbage", text: "" };
    const stream = body.stream === true;
    const model = String(body.model ?? "fake");

    // ---- the real API's admission rules (tokens per minute)
    const messages = (body.messages ?? []) as Array<{ content?: string }>;
    const rf = body.response_format as { type?: string; json_schema?: { schema?: unknown } } | undefined;
    const schemaChars = rf?.type === "json_schema" && model.startsWith("openai/") ? JSON.stringify(rf.json_schema?.schema ?? {}).length : 0;
    const promptTokens = mode.kind === "ok" && mode.promptTokens !== undefined ? mode.promptTokens : Math.ceil((messages.reduce((a, m) => a + (m.content?.length ?? 0), 0) + schemaChars) / 3.8) + 30;
    const maxOut = Number(body.max_completion_tokens ?? body.max_tokens ?? 4096);
    const b = bucket(model);
    if (o.enforceLimits) {
      if (promptTokens > tpm) {
        err(res, model, 413, "rate_limit_exceeded", "tokens", `Request too large for model \`${model}\` in organization \`org_fake\` service tier \`on_demand\` on tokens per minute (TPM): Limit ${tpm}, Requested ${promptTokens}, please reduce your message size and try again.`, { "retry-after": "17" });
        return;
      }
      const need = Math.min(promptTokens + maxOut, tpm);
      if (b.tokens < need) {
        const wait = Math.ceil(((need - b.tokens) * 60) / tpm);
        err(res, model, 429, "rate_limit_exceeded", "tokens", `Rate limit reached for model \`${model}\` in organization \`org_fake\` service tier \`on_demand\` on tokens per minute (TPM): Limit ${tpm}, Used ${Math.round(tpm - b.tokens)}, Requested ${need}. Please try again in ${wait}s.`, { "retry-after": String(wait) });
        return;
      }
      b.tokens -= need; // reserved; settled below
    }
    const settle = (actual: number): void => {
      if (!o.enforceLimits) return;
      const need = Math.min(promptTokens + maxOut, tpm);
      b.tokens += need - actual;
    };

    if (mode.kind === "status") {
      settle(0);
      err(res, model, mode.status, mode.code, mode.status === 429 ? "tokens" : "invalid_request_error", mode.message, mode.retryAfter ? { "retry-after": mode.retryAfter } : {});
      return;
    }
    if (mode.kind === "slow") await new Promise((r) => setTimeout(r, mode.delayMs));

    const text =
      mode.kind === "ok" || mode.kind === "truncated"
        ? typeof mode.json === "string"
          ? mode.json
          : JSON.stringify(mode.json)
        : mode.kind === "garbage"
          ? mode.text
          : mode.kind === "stream_error"
            ? '{"thread_re'
            : "{}";
    const reasoningTokens = mode.kind === "ok" ? (mode.reasoningTokens ?? 0) : 0;
    const completionTokens = mode.kind === "ok" && mode.completionTokens !== undefined ? mode.completionTokens : Math.ceil(text.length / 3.5) + reasoningTokens;
    const usage = {
      queue_time: 0.05,
      prompt_tokens: promptTokens,
      prompt_time: 0.01,
      completion_tokens: completionTokens,
      completion_time: 0.1,
      total_tokens: promptTokens + completionTokens,
      ...(reasoningTokens || model.startsWith("openai/") ? { completion_tokens_details: { reasoning_tokens: reasoningTokens } } : {}),
      ...(mode.kind === "ok" && mode.cachedTokens ? { prompt_tokens_details: { cached_tokens: mode.cachedTokens } } : {}),
    };
    const finish = (mode.kind === "ok" && mode.finishReason) || "stop";
    const id = "chatcmpl-fake";
    const created = Math.floor(now() / 1000);

    if (!stream) {
      settle(promptTokens + completionTokens);
      res.writeHead(200, { "content-type": "application/json", ...rateHeaders(model) });
      res.end(
        JSON.stringify({
          id, object: "chat.completion", created, model,
          choices: [{ index: 0, message: { role: "assistant", content: text, ...(reasoningTokens ? { reasoning: "Need to answer." } : {}) }, logprobs: null, finish_reason: finish }],
          usage, x_groq: { id: REQ_ID }, service_tier: "on_demand",
        }),
      );
      return;
    }

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...rateHeaders(model) });
    const send = (data: unknown, event?: string): void => void res.write(`${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
    const chunk = (delta: Record<string, unknown>, finishReason: string | null = null, extra: Record<string, unknown> = {}): unknown => ({
      id, object: "chat.completion.chunk", created, model, system_fingerprint: "fp_fake", choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }], ...extra,
    });
    send(chunk({ role: "assistant", content: "" }, null, { x_groq: { id: REQ_ID } }));
    const oneChunk = mode.kind === "ok" && (mode.oneChunk ?? false);
    const reasoningChunks = mode.kind === "ok" ? (mode.reasoningChunks ?? (oneChunk ? 3 : 0)) : 0;
    for (let i = 0; i < reasoningChunks; i++) send(chunk({ reasoning: i === 0 ? "Need" : " to answer", channel: "analysis" }));

    if (mode.kind === "stream_error") {
      send(chunk({ content: text }));
      send({ error: { message: "Failed to generate JSON. Please adjust your prompt.", type: "invalid_request_error", code: mode.code, failed_generation: "{\"thread_re", status_code: 400 } }, "error");
      settle(promptTokens);
      res.end();
      return;
    }

    const size = mode.kind === "ok" ? (mode.chunkChars ?? 24) : 24;
    const delay = mode.kind === "ok" ? (mode.chunkDelayMs ?? 12) : 5;
    const body2 = mode.kind === "truncated" ? text.slice(0, Math.max(1, Math.floor(text.length / 2))) : text;
    if (oneChunk) send(chunk({ content: body2 }));
    else {
      for (let i = 0; i < body2.length; i += size) {
        send(chunk({ content: body2.slice(i, i + size) }));
        if (delay) await new Promise((r) => setTimeout(r, delay));
      }
    }
    if (mode.kind === "truncated") {
      settle(promptTokens + Math.ceil(body2.length / 3.5));
      res.end(); // a clean end of stream with no finish_reason and no [DONE]
      return;
    }
    settle(promptTokens + completionTokens);
    send(chunk({}, finish, { x_groq: { id: REQ_ID, usage }, usage }));
    send({ id, object: "chat.completion.chunk", created, model, system_fingerprint: "fp_fake", choices: [], usage, service_tier: "on_demand" });
    send("[DONE]");
    res.end();
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/openai/v1`;
  state.close = () =>
    new Promise((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    });
  return state;
}
