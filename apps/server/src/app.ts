import "./silence";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import type { ClientConfig, ServerMessage } from "@synapse/shared";
import { Bus } from "./bus";
import { CaptureService } from "./capture/service";
import { systemClock, type Clock } from "./clock";
import type { Config } from "./config";
import type { Hub } from "./ctx";
import { CortexEngine } from "./cortex/engine";
import { MockCortex } from "./cortex/mock";
import type { CortexBackend, CortexInput, CortexOutput, PartialCallback } from "./cortex/types";
import { Auth } from "./gateway/auth";
import { WsHub, type HubServices } from "./gateway/hub";
import { MAX_CAPTURE_BYTES, registerRoutes } from "./gateway/routes";
import { registerWeb, webDistReady } from "./gateway/static";
import { Trust, isAllowedOrigin } from "./gateway/trust";
import { ControlIntents } from "./gate/intent";
import { Triager } from "./gate/triage";
import { seedCalendar } from "./integrations/calendar";
import { Outbox } from "./integrations/outbox";
import { ClaudeCortex } from "./llm/anthropic";
import { DeepLlm } from "./llm/deep";
import { FailoverBackend } from "./llm/failover";
import { GroqCortex } from "./llm/groq";
import { GroqClient } from "./llm/groq-client";
import { log } from "./log";
import { Vault } from "./memory/crypto";
import { Db } from "./memory/db";
import { createEmbedder, type Embedder } from "./memory/embeddings";
import { MemoryStore } from "./memory/store";
import { BatteryLog, Metrics } from "./metrics/latency";
import { AuditChain } from "./privacy/audit";
import { PrivacyService } from "./privacy/service";
import { Consolidator } from "./consolidate/engine";
import { AutonomyPolicy } from "./proactive/autonomy";
import { ProactiveEngine } from "./proactive/engine";
import { RecallEngine } from "./recall/engine";
import { LocalStt, LocalSttAuth, type SttBackend } from "./wispr/local-stt";
import { registerLocalStt } from "./wispr/local-ws";
import { SarvamStt } from "./wispr/sarvam";
import { WisprService } from "./wispr/service";

export interface AppOptions {
  /** ":memory:" for tests */
  dbFile?: string;
  clock?: Clock;
  embedder?: Embedder;
  /** replace the cortex backend (tests / benchmarks) */
  backend?: CortexBackend;
  /** do not start timers (tests) */
  quiet?: boolean;
  /** supply the master key directly (tests); skips passphrase / OS keyring / keyfile */
  kek?: Buffer;
  /**
   * Share one Groq client between apps. The token budget and the day's request count belong to the API key, not to an app, so a
   * benchmark or eval that builds many apps in one process must hand them the same client or each new app would start with a full
   * bucket and walk into the server's 429.
   */
  groq?: GroqClient;
  /** replace the on-device speech model (tests) */
  sttBackend?: SttBackend;
}

/** Everything wired together. Services are created in dependency order; the hub is late-bound. */
export interface AppCtx {
  cfg: Config;
  clock: Clock;
  bus: Bus;
  db: Db;
  vault: Vault;
  store: MemoryStore;
  embedder: Embedder;
  triager: Triager;
  intents: ControlIntents;
  metrics: Metrics;
  battery: BatteryLog;
  audit: AuditChain;
  trust: Trust;
  /** passcode sessions, the capture token, and the public URL (tunnel) */
  auth: Auth;
  privacy: PrivacyService;
  outbox: Outbox;
  autonomy: AutonomyPolicy;
  engine: CortexEngine;
  recall: RecallEngine;
  proactive: ProactiveEngine;
  consolidator: Consolidator;
  wispr: WisprService;
  deep: DeepLlm;
  hub: WsHub;
  mock: MockCortex;
  /** the live cortex of the configured provider (null in mock mode) */
  live: ClaudeCortex | GroqCortex | null;
  /** the shared Groq client (pacing, counters) when LLM_PROVIDER resolves to groq */
  groq: GroqClient | null;
  /** the on-device speech engine (null when no setup can use one: WISPR_MODE=mock or proxy) */
  localStt: LocalStt | null;
  /** the engine that would take the NEXT utterance on the on-server speech endpoints: Sarvam's cloud API, or Whisper (always Whisper in local-only mode) */
  speechStt: () => LocalStt | null;
  asides: { count: number };
  /** POST /api/capture: text or audio from any client, through the same engine */
  capture: CaptureService;
  /** this server also serves the built web app (one origin, one port) */
  webServed: boolean;
  fastify: FastifyInstance;
  clientConfig: () => ClientConfig;
  /** resolves when every recall answer started by a spoken question has finished (benchmarks and evals wait before they stop the app) */
  idleRecall: () => Promise<void>;
}

class RoutingBackend implements CortexBackend {
  readonly name = "router";
  constructor(private pick: () => CortexBackend) {}
  analyze(input: CortexInput, onPartial?: PartialCallback): Promise<CortexOutput> {
    return this.pick().analyze(input, onPartial);
  }
  async warm(): Promise<void> {
    await this.pick().warm?.();
  }
}

export async function createApp(cfg: Config, opts: AppOptions = {}): Promise<{ ctx: AppCtx; start: () => Promise<void>; stop: () => Promise<void> }> {
  const clock = opts.clock ?? systemClock;
  const bus = new Bus();

  // ---- storage + crypto
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const dbFile = opts.dbFile ?? path.join(cfg.dataDir, "synapse.db");
  const db = new Db(dbFile);
  const vault = opts.kek ? Vault.withKek(db, opts.kek, clock.now()) : await Vault.open(db, { dataDir: cfg.dataDir, passphrase: cfg.memory.passphrase, now: () => clock.now() });
  const embedder = opts.embedder ?? (await createEmbedder({ mode: cfg.embeddings.mode, model: cfg.embeddings.model, dataDir: cfg.embeddings.cacheDir }));
  const store = new MemoryStore(db, vault, embedder, clock, cfg.memory.ttlHours);
  await store.init();
  store.recoverUnfinished();
  const audit = new AuditChain(db, clock);
  store.audit = (event, ref, count) => audit.append(event, ref, count);
  store.onExpired = (id) => {
    hub.broadcast({ type: "thought.remove", id, reason: "expired" });
    hub.broadcast({ type: "graph.delta", nodes: [], edges: [], removedNodes: [id], removedEdges: [] });
  };

  // ---- gate
  const triager = new Triager(embedder);
  const intents = new ControlIntents(embedder);
  await Promise.all([triager.init(), intents.init()]);

  // ---- seeds: teammates are pinned entities + dictionary terms; a realistic calendar
  for (const m of cfg.user.team) {
    const e = await store.upsertEntity(m.name, "person");
    if (e && e.longTerm !== 2) store.pinEntity(e);
    store.upsertDict(m.name, "person", "team", 0.9);
  }
  store.upsertDict(cfg.user.firstName, "person", "seed", 0.9);
  seedCalendar(store, cfg, clock.now());

  // ---- services (hub is created first and late-bound so services can depend on it)
  const trust = new Trust(db, cfg);
  const auth = new Auth(db, { passcode: cfg.remote.passcode, publicUrl: cfg.remote.publicUrl }, clock);
  const services = {} as HubServices;
  const hub = new WsHub(services);
  const hubIface: Hub = hub;
  const emit = (m: ServerMessage): void => hub.broadcast(m);
  const asides = { count: 0 };
  const metrics = new Metrics(db, clock);
  metrics.onSummary = (summary) => hub.broadcast({ type: "metrics.update", summary });
  const battery = new BatteryLog(db);

  const privacy = new PrivacyService({ cfg, clock, bus, store, embedder, audit, hub: hubIface, emit });
  const outbox = new Outbox({ cfg, store, clock, audit, emit, bus });
  const autonomy = new AutonomyPolicy({ cfg, store, outbox, audit });
  const pseudonymNames = (): string[] =>
    cfg.privacy.pseudonymize ? [cfg.user.firstName, ...cfg.user.team.map((m) => m.name), ...[...store.entities.values()].filter((e) => e.type === "person").map((e) => e.name)] : [];
  // the audit trail names the model only (never content); other providers are prefixed so the ledger shows who got the call
  const onCloudCall = (info: { model: string; redactions: number }): void => audit.append("sent_to_llm", cfg.llm.provider === "groq" ? `groq:${info.model}` : info.model, info.redactions);

  const mock = new MockCortex(triager, embedder);
  const groq =
    cfg.llm.provider === "groq"
      ? (opts.groq ?? new GroqClient({ apiKey: cfg.llm.groq.apiKey, baseUrl: cfg.llm.groq.baseUrl, tpm: cfg.llm.groq.tpm, maxWaitMs: cfg.llm.groq.maxWaitMs, maxRequestsPerDay: cfg.llm.groq.maxRequestsPerDay }))
      : null;
  const live: ClaudeCortex | GroqCortex | null =
    cfg.llm.provider === "anthropic"
      ? new ClaudeCortex({ apiKey: cfg.llm.apiKey, model: cfg.llm.fast, fallback: mock, pseudonymNames, onCloudCall })
      : groq
        ? new GroqCortex({ client: groq, model: cfg.llm.fast, fallback: mock, outputMode: cfg.llm.groq.outputMode, pseudonymNames, onCloudCall })
        : null;
  // two Groq models with separate budgets: when the fast one is out for the day (or the minute) the other answers instead of the offline cortex
  const spare =
    groq && live instanceof GroqCortex && cfg.llm.deep !== cfg.llm.fast
      ? new GroqCortex({ client: groq, model: cfg.llm.deep, fallback: mock, outputMode: cfg.llm.groq.outputMode, pseudonymNames, onCloudCall })
      : null;
  const liveBackend: CortexBackend | null = live instanceof GroqCortex && spare ? new FailoverBackend(live, spare) : live;
  const backend = opts.backend ?? new RoutingBackend(() => (privacy.localOnly || !liveBackend ? mock : liveBackend));
  const deep = new DeepLlm(cfg, { isLocalOnly: () => privacy.localOnly, pseudonymNames, onCloudCall, groq: groq ?? undefined });

  // on-device speech: nothing is loaded until it is used (or STT_PRELOAD), and its endpoints refuse audio unless it is in use
  const localStt =
    cfg.wispr.mode === "local" || cfg.wispr.mode === "client"
      ? new LocalStt({ model: cfg.stt.model, dtype: cfg.stt.dtype, cacheDir: cfg.stt.cacheDir, languages: cfg.wispr.languages, ...(opts.sttBackend ? { loader: async () => opts.sttBackend as SttBackend } : {}) })
      : null;
  // Sarvam's cloud speech API behind the same endpoints (WISPR_MODE=sarvam). Every call is recorded in the ledger: provider, model and the
  // seconds of audio, never content. The self-healing dictionary goes along as recognition hints, like Wispr's dictionary_context.
  const sarvamStt =
    localStt && cfg.stt.provider === "sarvam"
      ? new LocalStt({
          model: `sarvam:${cfg.stt.sarvam.model}`,
          dtype: "api",
          cacheDir: cfg.stt.cacheDir,
          languages: cfg.wispr.languages,
          loader: async () =>
            new SarvamStt({
              apiKey: cfg.stt.sarvam.apiKey,
              baseUrl: cfg.stt.sarvam.baseUrl,
              model: cfg.stt.sarvam.model,
              languageCode: cfg.stt.sarvam.languageCode,
              keyterms: () => [cfg.user.firstName, ...cfg.user.team.map((m) => m.name), ...store.topDictionary(40)],
              onSend: (i) => audit.append("sent_to_stt", `sarvam:${i.model}`, i.audioMs),
            }),
        })
      : null;
  // Speech for POST /api/capture (a phone upload, a shared voice note): Sarvam when a key exists, otherwise Whisper on this machine.
  // Local-only mode always uses Whisper. These engines exist whatever WISPR_MODE says: the live microphone path is separate.
  let captureSarvam: LocalStt | null = sarvamStt;
  let captureWhisper: LocalStt | null = localStt;
  const captureStt = (): { stt: LocalStt; provider: "sarvam" | "whisper" } => {
    if (!privacy.localOnly && cfg.stt.sarvam.apiKey) {
      captureSarvam ??= new LocalStt({
        model: `sarvam:${cfg.stt.sarvam.model}`,
        dtype: "api",
        cacheDir: cfg.stt.cacheDir,
        languages: cfg.wispr.languages,
        loader: async () =>
          new SarvamStt({
            apiKey: cfg.stt.sarvam.apiKey,
            baseUrl: cfg.stt.sarvam.baseUrl,
            model: cfg.stt.sarvam.model,
            languageCode: cfg.stt.sarvam.languageCode,
            keyterms: () => [cfg.user.firstName, ...cfg.user.team.map((m) => m.name), ...store.topDictionary(40)],
            onSend: (i) => audit.append("sent_to_stt", `sarvam:${i.model}`, i.audioMs),
          }),
      });
      return { stt: captureSarvam, provider: "sarvam" };
    }
    captureWhisper ??= new LocalStt({ model: cfg.stt.model, dtype: cfg.stt.dtype, cacheDir: cfg.stt.cacheDir, languages: cfg.wispr.languages, ...(opts.sttBackend ? { loader: async () => opts.sttBackend as SttBackend } : {}) });
    return { stt: captureWhisper, provider: "whisper" };
  };
  const sttAuth = new LocalSttAuth();
  const wispr = new WisprService({
    cfg, store, clock, anyListening: () => hub.anyListening(),
    ...(localStt ? { local: { stt: localStt, auth: sttAuth, isLocalOnly: () => privacy.localOnly } } : {}),
  });
  const recall = new RecallEngine({ cfg, clock, store, embedder, deep, emit, bus, audit });

  // recall answers run on their own after the thought that asked for them; remember them so a run can wait for the last one
  const pendingRecall = new Set<Promise<unknown>>();
  const trackRecall = (p: Promise<unknown>): void => {
    pendingRecall.add(p);
    void p.finally(() => pendingRecall.delete(p));
  };

  const engine = new CortexEngine({
    cfg, clock, bus, store, embedder, triager, intents, backend, emit, hub: hubIface, metrics, autonomy, controls: privacy, asides,
    onRecallQuery: (t, dev) => trackRecall(recall.answerForThought(t, dev).catch((e) => log.warn("recall", `failed: ${(e as Error).message}`))),
    vocabulary: () => store.topDictionary(40),
  });
  privacy.attachEngine(engine);
  const proactive = new ProactiveEngine({ cfg, clock, bus, store, embedder, hub: hubIface, emit, recall, deep, outbox, privacy, audit, asides });

  const capture = new CaptureService({ db, clock, store, engine, isPaused: () => privacy.isPaused(), stt: captureStt, emit, ttlHours: cfg.memory.ttlHours });

  const consolidator = new Consolidator({ cfg, clock, store, embedder, deep, emit, audit, isPaused: () => privacy.isPaused() });

  const clientConfig = (): ClientConfig => ({
    wisprMode: wispr.mode,
    ...(wispr.mode === "local" ? { sttProvider: wispr.sttProvider() } : {}),
    languages: cfg.wispr.languages,
    llmMode: privacy.localOnly ? "mock" : cfg.llm.mode,
    ...(!privacy.localOnly && cfg.llm.provider !== "mock" ? { llmProvider: cfg.llm.provider, llmModel: cfg.llm.fast } : {}),
    localOnly: privacy.localOnly,
    autonomyLevel: autonomy.level,
    pauseWindowSecs: cfg.memory.pauseWindowSecs,
    ttlHours: cfg.memory.ttlHours,
    userFirstName: cfg.user.firstName,
    timezone: cfg.timezone,
    hackathonStart: cfg.hackathonStart,
    embeddings: embedder.mode,
    threadCloseMs: cfg.memory.threadCloseMs,
    dev: cfg.dev,
    integrations: { github: outbox.githubReady(), jira: outbox.jiraReady() },
  });

  Object.assign(services, {
    cfg, clock, bus, store, engine, privacy, metrics, battery, wispr, outbox, audit, trust, auth, asides,
    recall: () => recall,
    proactive: () => proactive,
    clientConfig,
  } satisfies HubServices);

  // ---- http
  const fastify = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  await fastify.register(cors, { origin: (origin, cb) => cb(null, isAllowedOrigin(origin ?? undefined, auth.publicOrigin)), credentials: true });
  await fastify.register(multipart, { limits: { fileSize: MAX_CAPTURE_BYTES, files: 1, fields: 8, fieldSize: 64 * 1024 } });
  await hub.register(fastify);
  const speechStt = (): LocalStt | null => (sarvamStt && wispr.sttProvider() === "sarvam" ? sarvamStt : localStt);
  if (localStt) registerLocalStt(fastify, { stt: () => speechStt() as LocalStt, auth: sttAuth, allowed: () => wispr.localAllowed(), now: () => clock.now(), publicOrigin: () => auth.publicOrigin });

  const ctx: AppCtx = {
    cfg, clock, bus, db, vault, store, embedder, triager, intents, metrics, battery, audit, trust, auth, privacy, outbox, autonomy, engine,
    recall, proactive, consolidator, wispr, deep, hub, mock, live, groq, localStt, speechStt, asides, capture, webServed: false, fastify, clientConfig,
    idleRecall: async () => void (await Promise.allSettled([...pendingRecall])),
  };
  registerRoutes(fastify, ctx);
  // one origin for pages, API and WebSocket (pnpm start): needed behind a tunnel for the cookie, the service worker and the socket
  const serveWeb = cfg.remote.serveWeb === "on" || (cfg.remote.serveWeb === "auto" && webDistReady(cfg.remote.webDist));
  if (serveWeb) await registerWeb(fastify, cfg.remote.webDist);
  ctx.webServed = serveWeb;

  const timers: Array<ReturnType<typeof setInterval>> = [];

  async function start(): Promise<void> {
    await fastify.listen({ port: cfg.port, host: "0.0.0.0" });
    if (!opts.quiet) {
      proactive.start();
      consolidator.start();
      timers.push(
        setInterval(() => store.sweep(), 60_000),
        setInterval(() => metrics.flush(), 5_000),
      );
      wispr.startWarmLoop();
      if (cfg.stt.preload) void localStt?.warm();
      if (live) {
        void backendWarm();
        timers.push(setInterval(() => void backendWarm(), 40 * 60_000));
      }
    }
    timers.forEach((t) => t.unref?.());
    banner(cfg, ctx.webServed, trust.pairingCode, embedder, vault.kekSource, wispr.mode === "local" ? (wispr.sttProvider() === "sarvam" ? `Sarvam cloud speech (${cfg.stt.sarvam.model}, ${cfg.stt.sarvam.languageCode})` : `local (on-device ${cfg.stt.model})`) : wispr.mode, live ? (cfg.llm.provider === "groq" ? `groq ${cfg.llm.fast}` : cfg.llm.fast) : "mock cortex (no LLM)", clientConfig().integrations);
  }

  async function backendWarm(): Promise<void> {
    await live?.warm?.();
  }

  async function stop(): Promise<void> {
    for (const t of timers) clearInterval(t);
    proactive.stop();
    consolidator.stop();
    wispr.stop();
    await engine.shutdown();
    // an answer being written must not find the database closed under it (bounded: a hung call must not hold a shutdown)
    if (pendingRecall.size) {
      let giveUp: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled([...pendingRecall]), new Promise((r) => (giveUp = setTimeout(r, 3000)))]);
      clearTimeout(giveUp);
    }
    metrics.flush();
    hub.closeAll();
    await fastify.close();
    db.close();
  }

  return { ctx, start, stop };
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  return out;
}

function banner(cfg: Config, webServed: boolean, code: string, embedder: Embedder, kek: string, wisprMode: string, llm: string, integ: { github: boolean; jira: boolean }): void {
  const lan = lanAddresses()[0];
  const lines = [
    "",
    "  ┌─ Synapse ─────────────────────────────────────────────",
    `  │ server        http://localhost:${cfg.port}   (api + ws)`,
    webServed
      ? `  │ web           http://localhost:${cfg.port}   (built app, same port)`
      : `  │ web           http://localhost:${cfg.webPort}${lan ? `   ·  phone: https://${lan}:${cfg.webPort}  (HTTPS=1 pnpm dev:web)` : ""}`,
    `  │ pairing code  ${code}   (only needed for non-local devices)`,
    `  │ wispr         ${wisprMode}${wisprMode === "mock" ? "  (typed input only; WISPR_MODE=client + WISPR_API_KEY for Wispr, or WISPR_MODE=local for on-device speech)" : ""}`,
    `  │ cortex        ${llm}`,
    `  │ embeddings    ${embedder.mode === "model" ? embedder.name : "hash fallback (offline, lexical)"}`,
    `  │ encryption    AES-256-GCM · master key: ${kek}`,
    `  │ integrations  github ${integ.github ? "live" : "simulated"} · jira ${integ.jira ? "live" : "simulated"}`,
    "  └───────────────────────────────────────────────────────",
    "",
  ];
  console.log(lines.join("\n"));
}
