import "./silence";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { ClientConfig, ServerMessage } from "@synapse/shared";
import { Bus } from "./bus";
import { systemClock, type Clock } from "./clock";
import type { Config } from "./config";
import type { Hub } from "./ctx";
import { CortexEngine } from "./cortex/engine";
import { MockCortex } from "./cortex/mock";
import type { CortexBackend, CortexInput, CortexOutput, PartialCallback } from "./cortex/types";
import { WsHub, type HubServices } from "./gateway/hub";
import { registerRoutes } from "./gateway/routes";
import { Trust, isAllowedOrigin } from "./gateway/trust";
import { ControlIntents } from "./gate/intent";
import { Triager } from "./gate/triage";
import { seedCalendar } from "./integrations/calendar";
import { Outbox } from "./integrations/outbox";
import { ClaudeCortex } from "./llm/anthropic";
import { DeepLlm } from "./llm/deep";
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
  live: ClaudeCortex | null;
  asides: { count: number };
  fastify: FastifyInstance;
  clientConfig: () => ClientConfig;
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
  const onCloudCall = (info: { model: string; redactions: number }): void => audit.append("sent_to_llm", info.model, info.redactions);

  const mock = new MockCortex(triager, embedder);
  const live = cfg.llm.mode === "live" ? new ClaudeCortex({ apiKey: cfg.llm.apiKey, model: cfg.llm.fast, fallback: mock, pseudonymNames, onCloudCall }) : null;
  const backend = opts.backend ?? new RoutingBackend(() => (privacy.localOnly || !live ? mock : live));
  const deep = new DeepLlm(cfg, { isLocalOnly: () => privacy.localOnly, pseudonymNames, onCloudCall });

  const wispr = new WisprService({ cfg, store, clock, anyListening: () => hub.anyListening() });
  const recall = new RecallEngine({ cfg, clock, store, embedder, deep, emit, bus, audit });

  const engine = new CortexEngine({
    cfg, clock, bus, store, embedder, triager, intents, backend, emit, hub: hubIface, metrics, autonomy, controls: privacy, asides,
    onRecallQuery: (t, dev) => void recall.answerForThought(t, dev).catch((e) => log.warn("recall", `failed: ${(e as Error).message}`)),
    vocabulary: () => store.topDictionary(40),
  });
  privacy.attachEngine(engine);
  const proactive = new ProactiveEngine({ cfg, clock, bus, store, embedder, hub: hubIface, emit, recall, deep, outbox, privacy, audit, asides });

  const consolidator = new Consolidator({ cfg, clock, store, embedder, deep, emit, audit, isPaused: () => privacy.isPaused() });

  const clientConfig = (): ClientConfig => ({
    wisprMode: cfg.wispr.mode,
    languages: cfg.wispr.languages,
    llmMode: privacy.localOnly ? "mock" : cfg.llm.mode,
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
    cfg, clock, bus, store, engine, privacy, metrics, battery, wispr, outbox, audit, trust, asides,
    recall: () => recall,
    proactive: () => proactive,
    clientConfig,
  } satisfies HubServices);

  // ---- http
  const fastify = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  await fastify.register(cors, { origin: (origin, cb) => cb(null, isAllowedOrigin(origin ?? undefined)) });
  await hub.register(fastify);

  const ctx: AppCtx = {
    cfg, clock, bus, db, vault, store, embedder, triager, intents, metrics, battery, audit, trust, privacy, outbox, autonomy, engine,
    recall, proactive, consolidator, wispr, deep, hub, mock, live, asides, fastify, clientConfig,
  };
  registerRoutes(fastify, ctx);

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
      if (live) {
        void backendWarm();
        timers.push(setInterval(() => void backendWarm(), 40 * 60_000));
      }
    }
    timers.forEach((t) => t.unref?.());
    banner(cfg, trust.pairingCode, embedder, vault.kekSource, wispr.mode, live ? cfg.llm.fast : "mock cortex (no LLM)", clientConfig().integrations);
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

function banner(cfg: Config, code: string, embedder: Embedder, kek: string, wisprMode: string, llm: string, integ: { github: boolean; jira: boolean }): void {
  const lan = lanAddresses()[0];
  const lines = [
    "",
    "  ┌─ Synapse ─────────────────────────────────────────────",
    `  │ server        http://localhost:${cfg.port}   (api + ws)`,
    `  │ web           http://localhost:${cfg.webPort}${lan ? `   ·  phone: https://${lan}:${cfg.webPort}  (HTTPS=1 pnpm dev:web)` : ""}`,
    `  │ pairing code  ${code}   (only needed for non-local devices)`,
    `  │ wispr         ${wisprMode}${wisprMode === "mock" ? "  (typed input only; set WISPR_MODE=client + WISPR_API_KEY)" : ""}`,
    `  │ cortex        ${llm}`,
    `  │ embeddings    ${embedder.mode === "model" ? embedder.name : "hash fallback (offline, lexical)"}`,
    `  │ encryption    AES-256-GCM · master key: ${kek}`,
    `  │ integrations  github ${integ.github ? "live" : "simulated"} · jira ${integ.jira ? "live" : "simulated"}`,
    "  └───────────────────────────────────────────────────────",
    "",
  ];
  console.log(lines.join("\n"));
}
