import { log } from "../log";

/* ============================================================================
 * Groq client: an OpenAI-compatible /chat/completions caller built for the FREE tier.
 *
 * The free tier is tight (measured on the key this was built with): 8,000 tokens per minute across prompt + completion and
 * 1,000 requests per day, both metered PER MODEL, and a request whose prompt alone exceeds the minute budget is rejected outright
 * (HTTP 413). So this client does three things the Anthropic path never needed:
 *   1. PACES itself with a token bucket per model (default 7,000 tokens/min, refilled continuously like the server's). A call reserves
 *      its estimated prompt plus the whole max_completion_tokens allowance (Groq refuses a request with a 429 when fewer tokens
 *      than that remain), waits briefly for the budget (bounded), and otherwise fails fast with kind "paced" so the caller can
 *      degrade to the local cortex instead of earning a 429. The reservation is settled against the real usage afterwards, and
 *      the server's own `x-ratelimit-remaining-tokens` header corrects the bucket when the key is shared.
 *   2. COUNTS requests (a local per-UTC-day safety cap, plus the server's remaining-requests header) so a long eval cannot
 *      burn the daily quota.
 *   3. NEVER retries on its own: a 429 starts a cool-down that honours `retry-after`; an auth failure disables the client for
 *      60 s; a dead connection or a timeout skips the cloud for 4 s. Callers decide about repair retries.
 * Privacy: nothing here logs prompts or completions, and error messages carry only the HTTP status and Groq's error code
 * (never the response text, which can echo the model's output, and never the API key).
 * ========================================================================== */

export type GroqErrorKind =
  | "auth"
  | "rate_limit"
  | "too_large"
  | "bad_request"
  | "schema_rejected"
  | "bad_output"
  | "timeout"
  | "network"
  | "server"
  | "paced"
  | "daily_cap"
  | "truncated"
  | "aborted";

export class GroqError extends Error {
  constructor(
    readonly kind: GroqErrorKind,
    message: string,
    readonly status?: number,
    /** the server's `retry-after`, when it sent one */
    readonly retryAfterMs?: number,
    /** the numbers of a tokens-per-minute refusal ("Limit 8000, Used 6014, Requested 3109"): counters only, never content */
    readonly limits?: { limit: number; used: number; requested: number },
  ) {
    super(message);
    this.name = "GroqError";
  }
}

export interface GroqMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type GroqResponseFormat = { type: "json_object" } | { type: "json_schema"; name: string; schema: Record<string, unknown>; strict: boolean };

export interface GroqRequest {
  model: string;
  messages: GroqMessage[];
  maxCompletionTokens: number;
  temperature?: number;
  /** gpt-oss: low | medium | high. Omitted for models that do not reason. */
  reasoningEffort?: "low" | "medium" | "high";
  responseFormat?: GroqResponseFormat;
}

export interface GroqCallOpts {
  /** stream the completion (SSE); implied by `onDelta` */
  stream?: boolean;
  /** called for every content delta with the text so far */
  onDelta?: (delta: string, soFar: string) => void;
  /** aborts the whole call (connect + generation); default 15 s */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** the budget is reserved and the request is about to leave this machine (the audit hook: refused calls are not "sent"); gets how long the call queued for the budget */
  onSend?: (queuedMs: number) => void;
  /** longest this call may queue for the token budget (default: the client's maxWaitMs) */
  maxWaitMs?: number;
}

export interface GroqUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
}

export interface GroqResult {
  text: string;
  finishReason: string | null;
  usage: GroqUsage;
  /** whole call, ms */
  ms: number;
  /** time spent waiting for the token budget before the request was sent, ms (not part of `ms`) */
  queuedMs: number;
  /** request sent to response headers, ms */
  firstByteMs: number;
  /** request sent to the first content delta, ms (streaming only) */
  firstContentMs?: number;
}

export interface GroqTrace {
  model: string;
  ok: boolean;
  status: number;
  kind?: GroqErrorKind;
  ms: number;
  firstByteMs?: number;
  firstContentMs?: number;
  estimatedPromptTokens: number;
  usage?: GroqUsage;
  finishReason?: string | null;
  streamed: boolean;
  /** x-ratelimit-remaining-tokens after the call, the pacing bucket as this client believes it, and a refusal's own numbers */
  remainingTokens?: number | null;
  bucketTokens?: number;
  retryAfterMs?: number;
  limits?: { limit: number; used: number; requested: number };
}

export interface GroqStats {
  requestsToday: number;
  /** UTC day the counter belongs to (YYYY-MM-DD) */
  day: string;
  maxRequestsPerDay: number;
  remainingTokensLastSeen: number | null;
  remainingRequestsLastSeen: number | null;
  limitTokens: number | null;
  tpmBudget: number;
  /** tokens available in the pacing bucket of the model used last (every model has its own minute budget on Groq) */
  bucketTokens: number;
  /** the same, and the last remaining-tokens reading, for every model this client has called */
  models: Record<string, { bucketTokens: number; remainingTokensLastSeen: number | null }>;
  /** calls refused by the local pacer or the daily cap */
  paced: number;
  /** HTTP 429s received */
  rateLimited: number;
  lastStatus: number | null;
  /** epoch ms until which the client refuses calls (auth failure or 429 cool-down), 0 when active */
  disabledUntil: number;
}

export interface GroqClientOpts {
  apiKey: string;
  baseUrl?: string;
  /** tokens-per-minute budget to pace to (default 7,000) */
  tpm?: number;
  /** longest a call may wait for the budget before it fails with "paced" (default 2,000 ms) */
  maxWaitMs?: number;
  /** local cap per UTC day (default 900, 0 = no cap) */
  maxRequestsPerDay?: number;
  /** injected clock and sleep (tests); sleep may advance a fake clock */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onTrace?: (t: GroqTrace) => void;
}

export const DEFAULT_GROQ_BASE = "https://api.groq.com/openai/v1";
const CHARS_PER_TOKEN = 3.3; // measured: 3.4 to 3.9 for this prompt family; the low end keeps the estimate on the safe side
const AUTH_DISABLE_MS = 60_000;
/** after a dead socket or a timeout, skip the cloud for a moment so each new fragment is not held for a whole timeout on a flaky network */
const NETWORK_COOL_MS = 4_000;

/** Rough token count for pacing (the settled usage replaces it). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** gpt-oss on Groq renders a json_schema into the prompt (about 3.8 chars per token); other models decode against it silently. */
const schemaCostsPromptTokens = (model: string): boolean => model.startsWith("openai/");

export function estimatePromptTokens(req: GroqRequest): number {
  let n = 24; // template overhead
  for (const m of req.messages) n += estimateTokens(m.content) + 6;
  if (req.responseFormat?.type === "json_schema" && schemaCostsPromptTokens(req.model)) n += Math.ceil(JSON.stringify(req.responseFormat.schema).length / 3.6);
  return n;
}

/* ------------------------------------------------------------------ pacing --- */

/**
 * A token bucket that refills continuously at `perMinute / 60` tokens per second, like Groq's own (the response headers
 * report the time to refill a deficit, which is the signature of a bucket rather than a sliding window).
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    readonly capacity: number,
    readonly perMinute: number,
    private now: () => number,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    if (t > this.last) this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) * this.perMinute) / 60_000);
    this.last = t;
  }

  available(): number {
    this.refill();
    return this.tokens;
  }

  /** ms until `n` tokens could be taken (0 = now). Infinity when n exceeds the bucket. */
  waitFor(n: number): number {
    this.refill();
    if (n > this.capacity) return Infinity;
    if (this.tokens >= n) return 0;
    return Math.ceil(((n - this.tokens) * 60_000) / this.perMinute);
  }

  /** Take tokens (may overdraw: settling real usage can cost more than was reserved). */
  take(n: number): void {
    this.refill();
    this.tokens -= n;
  }

  /** Return tokens (an unused reservation). */
  give(n: number): void {
    this.refill();
    this.tokens = Math.min(this.capacity, this.tokens + n);
  }

  /** Never believe we have more than the server says (a shared key, another process, a 429's retry-after). */
  clampTo(n: number): void {
    this.refill();
    if (n < this.tokens) this.tokens = n;
  }
}

/** "1m26.4s", "855ms", "2.227s", "17" → ms. */
export function parseDuration(v: string | null | undefined): number | undefined {
  if (!v) return undefined;
  const m = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/.exec(v.trim());
  if (m && (m[1] || m[2] || m[3] || m[4])) return Math.round(Number(m[1] ?? 0) * 3_600_000 + Number(m[2] ?? 0) * 60_000 + Number(m[3] ?? 0) * 1000 + Number(m[4] ?? 0));
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 1000) : undefined; // a bare number is seconds (the retry-after header)
}

/* ---------------------------------------------------------------------- SSE --- */

interface SseEvent {
  event: string;
  data: string;
}

async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const parse = (block: string): SseEvent | null => {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const i = line.indexOf(":");
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    return data.length ? { event, data: data.join("\n") } : null;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const ev = parse(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
        if (ev) yield ev;
      }
    }
    buf += dec.decode();
    const tail = parse(buf.replace(/\r\n/g, "\n"));
    if (tail) yield tail;
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/* ------------------------------------------------------------------- client --- */

interface ErrBody {
  error?: { message?: string; type?: string; code?: string; status_code?: number };
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export class GroqClient {
  private readonly baseUrl: string;
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly remainingBy = new Map<string, number>();
  private lastModel = "";
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxWaitMs: number;
  private readonly maxPerDay: number;
  private readonly tpm: number;

  private day: string;
  private requestsToday = 0;
  private remainingTokens: number | null = null;
  private remainingRequests: number | null = null;
  private limitTokens: number | null = null;
  private paced = 0;
  private rateLimited = 0;
  private lastStatus: number | null = null;
  private authUntil = 0;
  private coolUntil = 0;
  private coolReason: "rate_limit" | "network" = "rate_limit";
  /** per bucket: serialises budget decisions so callers of one model are served in order and never double-spend, while a deep call waiting for ITS budget cannot hold up the hot path's */
  private gates = new WeakMap<TokenBucket, Promise<unknown>>();
  private warned = new Set<string>();

  constructor(private opts: GroqClientOpts) {
    this.baseUrl = (opts.baseUrl || DEFAULT_GROQ_BASE).replace(/\/$/, "");
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.tpm = Math.max(500, opts.tpm ?? 7000);
    this.maxWaitMs = Math.max(0, opts.maxWaitMs ?? 2000);
    this.maxPerDay = Math.max(0, opts.maxRequestsPerDay ?? 900);
    this.day = dayOf(this.now());
  }

  get hasKey(): boolean {
    return Boolean(this.opts.apiKey);
  }

  /** epoch ms until which calls are refused outright (auth failure window, 429 cool-down), or 0 */
  get disabledUntil(): number {
    return Math.max(this.authUntil, this.coolUntil) > this.now() ? Math.max(this.authUntil, this.coolUntil) : 0;
  }

  /** why the client is refusing calls right now, if it is */
  get disabledReason(): "auth" | "rate_limit" | "network" | null {
    const t = this.now();
    if (this.authUntil > t) return "auth";
    if (this.coolUntil > t) return this.coolReason;
    return null;
  }

  stats(): GroqStats {
    this.rollDay();
    return {
      requestsToday: this.requestsToday,
      day: this.day,
      maxRequestsPerDay: this.maxPerDay,
      remainingTokensLastSeen: this.remainingTokens,
      remainingRequestsLastSeen: this.remainingRequests,
      limitTokens: this.limitTokens,
      tpmBudget: this.tpm,
      bucketTokens: this.lastModel ? Math.round(this.bucketOf(this.lastModel).available()) : this.tpm,
      models: Object.fromEntries([...this.buckets].map(([m, b]) => [m, { bucketTokens: Math.round(b.available()), remainingTokensLastSeen: this.remainingBy.get(m) ?? null }])),
      paced: this.paced,
      rateLimited: this.rateLimited,
      lastStatus: this.lastStatus,
      disabledUntil: this.disabledUntil,
    };
  }

  /** GET /models: opens the connection and checks the key. Costs no tokens, is not counted as a request, never throws. */
  async ping(timeoutMs = 3000): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, { headers: { authorization: `Bearer ${this.opts.apiKey}` }, signal: AbortSignal.timeout(timeoutMs) });
      await res.arrayBuffer().catch(() => undefined);
      if (res.status === 401 || res.status === 403) this.afterError(new GroqError("auth", `Groq HTTP ${res.status}`, res.status));
      return res.ok;
    } catch {
      return false;
    }
  }

  private rollDay(): void {
    const d = dayOf(this.now());
    if (d !== this.day) {
      this.day = d;
      this.requestsToday = 0;
    }
  }

  private warnOnce(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    log.warn("groq", msg);
  }

  /** Groq meters tokens per model (the 429/413 messages say "for model ..."), so every model gets its own bucket. */
  private bucketOf(model: string): TokenBucket {
    let b = this.buckets.get(model);
    if (!b) {
      b = new TokenBucket(this.tpm, this.tpm, this.now);
      this.buckets.set(model, b);
    }
    return b;
  }

  /** Reserve `need` tokens of `bucket`, waiting at most `maxWaitMs` from `startedAt` for the budget. FIFO. */
  private reserve(bucket: TokenBucket, need: number, startedAt: number, maxWaitMs: number): Promise<void> {
    const turn = (this.gates.get(bucket) ?? Promise.resolve()).then(async () => {
      if (need > bucket.capacity) throw new GroqError("too_large", `estimated ${need} tokens exceed the ${bucket.capacity}/min budget`);
      for (let spins = 0; spins < 4; spins++) {
        const wait = bucket.waitFor(need);
        if (wait <= 0) {
          bucket.take(need);
          return;
        }
        if (this.now() + wait - startedAt > maxWaitMs) {
          this.paced++;
          throw new GroqError("paced", `token budget exhausted (${Math.round(bucket.available())} of ${this.tpm}/min available)`);
        }
        await this.sleep(wait);
      }
      this.paced++;
      throw new GroqError("paced", "token budget contended");
    });
    this.gates.set(bucket, turn.catch(() => undefined));
    return turn;
  }

  private settle(bucket: TokenBucket, reserved: number, actual: number | null): void {
    // actual === null: the call never consumed tokens (rejected before generation); give everything back
    if (actual === null) bucket.give(reserved);
    else if (actual < reserved) bucket.give(reserved - actual);
    else if (actual > reserved) bucket.take(actual - reserved);
  }

  /**
   * Read the rate-limit headers. They are the server's own bookkeeping, so the bucket is corrected by them, but only AFTER
   * this call has been settled (its own cost is already in the header), and `addBack` is what a streaming response has not
   * been refunded yet: its headers arrive before generation ends, with the whole completion allowance still held.
   */
  private learnHeaders(model: string, bucket: TokenBucket, h: Headers, addBack = 0): void {
    const rt = h.get("x-ratelimit-remaining-tokens");
    const rr = h.get("x-ratelimit-remaining-requests");
    const lt = h.get("x-ratelimit-limit-tokens");
    if (lt && Number.isFinite(Number(lt))) this.limitTokens = Number(lt);
    if (rr && Number.isFinite(Number(rr))) this.remainingRequests = Number(rr);
    if (rt && Number.isFinite(Number(rt))) {
      this.remainingTokens = Number(rt);
      this.remainingBy.set(model, Number(rt));
      // correct the local bucket by the server's view of the deficit (shared key, other processes)
      const limit = this.limitTokens ?? 8000;
      bucket.clampTo(bucket.capacity - Math.max(0, limit - Number(rt) - addBack));
    }
  }

  private classify(status: number, body: ErrBody | null, retryAfterMs: number | undefined): GroqError {
    const code = body?.error?.code ?? body?.error?.type ?? "";
    const msg = body?.error?.message ?? "";
    const what = `Groq HTTP ${status}${code ? ` ${code}` : ""}`;
    if (status === 401 || status === 403) return new GroqError("auth", what, status);
    if (status === 413) return new GroqError("too_large", what, status, retryAfterMs);
    if (status === 429) {
      // only a tokens-per-minute refusal says anything about THIS bucket: a per-day or per-request limit counts on other scales
      const m = /tokens per minute \(TPM\): Limit (\d+), Used (\d+), Requested (\d+)/.exec(msg);
      const which = /\((TPM|TPD|RPM|RPD)\)/.exec(msg)?.[1];
      return new GroqError("rate_limit", which ? `${what} (${which})` : what, status, retryAfterMs, m ? { limit: Number(m[1]), used: Number(m[2]), requested: Number(m[3]) } : undefined);
    }
    if (status === 400 || status === 422) {
      if (code === "json_validate_failed") return new GroqError("bad_output", what, status);
      if (/schema|response_format|json_schema|strict|enum|anyOf|additionalProperties/i.test(msg)) return new GroqError("schema_rejected", what, status);
      return new GroqError("bad_request", what, status);
    }
    if (status >= 500) return new GroqError("server", what, status);
    return new GroqError("server", what, status);
  }

  private afterError(e: GroqError): void {
    if (e.kind === "auth") {
      this.authUntil = this.now() + AUTH_DISABLE_MS;
      this.warnOnce("auth", "Groq auth failed: check GROQ_API_KEY. The live path is off for 60 s; falling back to the local cortex.");
    } else if (e.kind === "rate_limit") {
      this.rateLimited++;
      const wait = Math.min(Math.max(e.retryAfterMs ?? 5000, 1000), 120_000);
      this.coolUntil = this.now() + wait;
      this.coolReason = "rate_limit";
      this.warnOnce("rate", `${e.message}: live calls pause ${Math.round(wait / 1000)} s (retry-after honoured, no retries)`);
    } else if (e.kind === "network" || e.kind === "timeout") {
      const until = this.now() + NETWORK_COOL_MS;
      if (until > this.coolUntil) {
        this.coolUntil = until;
        this.coolReason = "network";
      }
    } else if (e.kind === "too_large") {
      this.warnOnce("large", "Groq rejected a request as too large for the tokens-per-minute limit: the prompt must stay under it.");
    }
  }

  /** One chat completion. Throws GroqError; never retries. */
  async chat(req: GroqRequest, o: GroqCallOpts = {}): Promise<GroqResult> {
    this.rollDay();
    const stream = o.stream ?? Boolean(o.onDelta);
    const startedAt = this.now();
    const estPrompt = estimatePromptTokens(req);
    const trace = (t: Omit<GroqTrace, "model" | "estimatedPromptTokens" | "streamed">): void =>
      this.opts.onTrace?.({ model: req.model, estimatedPromptTokens: estPrompt, streamed: stream, ...t });
    // a refusal made here (cool-down, budget, cap) has no side effects; an error that CAME from the server starts the windows
    const fail = (e: GroqError, extra: Partial<GroqTrace> = {}, fromServer = true): never => {
      if (fromServer) this.afterError(e);
      trace({ ok: false, status: e.status ?? 0, kind: e.kind, ms: this.now() - startedAt, remainingTokens: this.remainingTokens, bucketTokens: Math.round(this.bucketOf(req.model).available()), retryAfterMs: e.retryAfterMs, limits: e.limits, ...extra });
      throw e;
    };

    if (this.maxPerDay > 0 && this.requestsToday >= this.maxPerDay) {
      this.paced++;
      return fail(new GroqError("daily_cap", `local cap of ${this.maxPerDay} requests per day reached`), {}, false);
    }
    const off = this.disabledReason;
    if (off === "auth") return fail(new GroqError("auth", "disabled after an authentication failure"), {}, false);
    if (off === "rate_limit") return fail(new GroqError("rate_limit", "cooling down after HTTP 429", undefined, this.coolUntil - this.now()), {}, false);
    if (off === "network") return fail(new GroqError("network", "skipping the cloud for a moment after a failed connection", undefined, this.coolUntil - this.now()), {}, false);

    // reserve the prompt plus the whole completion allowance: that is what Groq checks at admission (measured: a request is
    // refused with 429 when remaining tokens < prompt + max_completion_tokens), then it charges what was really used
    const need = estPrompt + req.maxCompletionTokens;
    const bucket = this.bucketOf(req.model);
    this.lastModel = req.model;
    try {
      await this.reserve(bucket, need, startedAt, o.maxWaitMs ?? this.maxWaitMs);
    } catch (e) {
      return fail(e as GroqError, {}, false);
    }
    const queuedMs = this.now() - startedAt;

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error("timeout")), o.timeoutMs ?? 15_000);
    const onAbort = (): void => ctl.abort(new Error("aborted"));
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const sentPerf = performance.now();
    this.requestsToday++;

    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      max_completion_tokens: req.maxCompletionTokens,
      stream,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.reasoningEffort) body.reasoning_effort = req.reasoningEffort;
    if (stream) body.stream_options = { include_usage: true };
    if (req.responseFormat) {
      body.response_format =
        req.responseFormat.type === "json_object"
          ? { type: "json_object" }
          : { type: "json_schema", json_schema: { name: req.responseFormat.name, schema: req.responseFormat.schema, strict: req.responseFormat.strict } };
    }

    const cleanup = (): void => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
    };
    const abortKind = (err: unknown): GroqError => {
      const reason = (ctl.signal.reason as Error | undefined)?.message;
      if (reason === "aborted" || o.signal?.aborted) return new GroqError("aborted", "call aborted by the caller");
      if (ctl.signal.aborted || (err as Error)?.name === "AbortError" || (err as Error)?.name === "TimeoutError") return new GroqError("timeout", "Groq call timed out");
      return new GroqError("network", `Groq connection failed (${(err as { cause?: { code?: string } })?.cause?.code ?? (err as Error)?.name ?? "error"})`);
    };

    let res: Response;
    try {
      o.onSend?.(queuedMs);
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (err) {
      cleanup();
      const e = abortKind(err);
      // a refused connection spent nothing; a timeout may have (the server could still be generating)
      this.settle(bucket, need, e.kind === "network" ? null : need);
      return fail(e, { ms: performance.now() - sentPerf });
    }
    const firstByteMs = performance.now() - sentPerf;
    this.lastStatus = res.status;

    if (!res.ok) {
      cleanup();
      let parsed: ErrBody | null = null;
      try {
        parsed = (await res.json()) as ErrBody;
      } catch {
        /* not json */
      }
      const ra = parseDuration(res.headers.get("retry-after"));
      const e = this.classify(res.status, parsed, ra);
      this.settle(bucket, need, null);
      this.learnHeaders(req.model, bucket, res.headers);
      // the server says when it will have room for exactly this request: believe we are `need` short, minus what refills until then
      if (e.kind === "rate_limit") {
        bucket.clampTo(need - (Math.min(Math.max(ra ?? 5000, 1000), 120_000) / 60_000) * this.tpm);
        if (e.limits) bucket.clampTo(bucket.capacity - e.limits.used); // what the server says is already spent in this minute
      }
      return fail(e, { ms: performance.now() - sentPerf, firstByteMs });
    }

    let text = "";
    let finish: string | null = null;
    let usage: GroqUsage | undefined;
    let firstContentMs: number | undefined;
    const readUsage = (u: Record<string, unknown> | undefined): GroqUsage | undefined => {
      if (!u) return undefined;
      const details = (u.completion_tokens_details ?? {}) as Record<string, number>;
      const pdetails = (u.prompt_tokens_details ?? {}) as Record<string, number>;
      return {
        promptTokens: Number(u.prompt_tokens ?? 0),
        completionTokens: Number(u.completion_tokens ?? 0),
        reasoningTokens: Number(details.reasoning_tokens ?? 0),
        cachedTokens: Number(pdetails.cached_tokens ?? 0),
      };
    };

    try {
      if (!stream) {
        const j = (await res.json()) as { choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>; usage?: Record<string, unknown> };
        text = j.choices?.[0]?.message?.content ?? "";
        finish = j.choices?.[0]?.finish_reason ?? null;
        usage = readUsage(j.usage);
      } else {
        if (!res.body) throw new GroqError("network", "Groq returned no stream body");
        let done = false;
        for await (const ev of sseEvents(res.body)) {
          if (ev.data === "[DONE]") {
            done = true;
            break;
          }
          let j: { choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>; usage?: Record<string, unknown>; x_groq?: { usage?: Record<string, unknown> } } & ErrBody;
          try {
            j = JSON.parse(ev.data);
          } catch {
            continue;
          }
          if (ev.event === "error" || (j.error && !j.choices)) throw this.classify(j.error?.status_code ?? 400, j, undefined);
          const ch = j.choices?.[0];
          const piece = ch?.delta?.content;
          if (piece) {
            firstContentMs ??= performance.now() - sentPerf;
            text += piece;
            o.onDelta?.(piece, text);
          }
          if (ch?.finish_reason) finish = ch.finish_reason;
          const u = readUsage(j.usage ?? j.x_groq?.usage);
          if (u) usage = u;
        }
        if (!done && finish === null) throw new GroqError("truncated", "Groq stream ended before it finished");
      }
    } catch (err) {
      cleanup();
      // the request was accepted: the server spends the prompt (and whatever it generated) even if we stop reading
      this.settle(bucket, need, usage ? usage.promptTokens + usage.completionTokens : need);
      this.learnHeaders(req.model, bucket, res.headers, stream ? req.maxCompletionTokens : 0);
      if (err instanceof GroqError) return fail(err, { ms: performance.now() - sentPerf, firstByteMs, firstContentMs });
      return fail(abortKind(err), { ms: performance.now() - sentPerf, firstByteMs, firstContentMs });
    }
    cleanup();

    const real = usage ?? { promptTokens: estPrompt, completionTokens: Math.ceil(text.length / 3.5), reasoningTokens: 0, cachedTokens: 0 };
    this.settle(bucket, need, real.promptTokens + real.completionTokens);
    this.learnHeaders(req.model, bucket, res.headers, stream ? Math.max(0, req.maxCompletionTokens - real.completionTokens) : 0);
    const ms = performance.now() - sentPerf;
    trace({ ok: true, status: res.status, ms, firstByteMs, firstContentMs, usage: real, finishReason: finish, remainingTokens: this.remainingTokens, bucketTokens: Math.round(bucket.available()) });
    return { text, finishReason: finish, usage: real, queuedMs, ms, firstByteMs, firstContentMs };
  }
}
