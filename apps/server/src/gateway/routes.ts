import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppCtx } from "../app";
import { runReplay, type ReplayScript } from "../cli/replay-lib";
import { listEvents, view as calView } from "../integrations/calendar";
import { graphSnapshot } from "../memory/graph";
import { ENERGY, STAGES, stagesOf } from "../metrics/latency";
import { parseQuery } from "../recall/engine";
import { entitiesInText } from "../recall/search";
import { isAllowedOrigin, isLoopback } from "./trust";

/* REST surface (TRD §14). Everything except /api/health requires a trusted client: loopback, or a
 * paired device token. /api/dev/* additionally requires dev mode and loopback. */

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

export function registerRoutes(app: FastifyInstance, ctx: AppCtx): void {
  const { cfg, store, trust, engine, privacy, outbox, metrics, battery, audit, autonomy, clock } = ctx;

  app.addHook("onRequest", async (req, reply) => {
    const url = req.url.split("?")[0] as string;
    if (!url.startsWith("/api") || url === "/api/health") return;
    if (!isAllowedOrigin(header(req, "origin"))) return reply.code(403).send({ error: "origin not allowed" });
    const ip = trust.clientIp(req.raw);
    const verdict = trust.check(ip, header(req, "x-synapse-device") ?? "rest", header(req, "x-synapse-token"));
    if (!verdict.ok) return reply.code(401).send({ error: verdict.reason ?? "unauthorized" });
    if (url.startsWith("/api/dev") && (!cfg.dev || !isLoopback(ip))) return reply.code(403).send({ error: "dev routes are localhost-only" });
    if (url === "/api/pairing" && !isLoopback(ip)) return reply.code(403).send({ error: "the pairing code is only shown on the host" });
  });

  // ------------------------------------------------------------------ health --
  app.get("/api/health", async () => ({
    ok: true,
    uptimeS: Math.round(process.uptime()),
    modes: { wispr: cfg.wispr.mode, llm: privacy.localOnly ? "local-only" : cfg.llm.mode, embeddings: ctx.embedder.mode, kek: ctx.vault.kekSource },
    llmProvider: cfg.llm.provider,
    models: { fast: cfg.llm.fast, deep: cfg.llm.deep, embed: ctx.embedder.name },
    // free-tier bookkeeping (counters and pacing state only, never content); null unless the provider is groq
    groq: ctx.groq ? ctx.groq.stats() : null,
    paused: privacy.isPaused(),
    memory: store.stats(),
  }));

  app.get("/api/pairing", async () => ({ code: trust.pairingCode, requirePairing: cfg.privacy.requirePairing }));
  app.get("/api/state", async () => ctx.hub.snapshot());

  app.get("/api/settings", async () => ({
    autonomyLevel: autonomy.level,
    localOnly: privacy.localOnly,
    llmMode: cfg.llm.mode,
    wisprMode: cfg.wispr.mode,
    ttlHours: cfg.memory.ttlHours,
    pauseWindowSecs: cfg.memory.pauseWindowSecs,
    promoteThreshold: cfg.memory.promoteThreshold,
    recurring: { n: cfg.proactive.recurringN, windowMin: cfg.proactive.recurringWindowMin, minGapS: cfg.proactive.minGapMs / 1000 },
    adaptation: ctx.proactive.adaptation(),
    integrations: ctx.clientConfig().integrations,
    kekSource: ctx.vault.kekSource,
    pseudonymize: cfg.privacy.pseudonymize,
  }));
  app.post("/api/settings", async (req) => {
    const b = z.object({ autonomyLevel: z.number().int().min(0).max(3).optional(), localOnly: z.boolean().optional() }).parse(req.body);
    if (b.autonomyLevel !== undefined) autonomy.setLevel(b.autonomyLevel);
    if (b.localOnly !== undefined) privacy.setLocalOnly(b.localOnly);
    ctx.hub.broadcast({ type: "notice", level: "info", text: `Settings updated${b.localOnly !== undefined ? `: local-only ${b.localOnly ? "on" : "off"}` : ""}`, at: clock.now() });
    return { ok: true, autonomyLevel: autonomy.level, localOnly: privacy.localOnly };
  });

  // ---------------------------------------------------------------- thoughts --
  app.get("/api/thoughts", async (req) => {
    const q = z
      .object({ since: z.coerce.number().optional(), until: z.coerce.number().optional(), category: z.string().optional(), q: z.string().optional(), limit: z.coerce.number().max(500).default(100) })
      .parse(req.query);
    let items = [...store.thoughts.values()].filter((t) => store.isRecallable(t) || t.category === "recall_query");
    if (q.since) items = items.filter((t) => t.createdAt >= q.since!);
    if (q.until) items = items.filter((t) => t.createdAt <= q.until!);
    if (q.category) items = items.filter((t) => t.category === q.category);
    if (q.q) {
      const hits = new Set(store.lex.search(q.q, 100).map((h) => h.id));
      items = items.filter((t) => hits.has(t.id));
    }
    return items.sort((a, b) => b.createdAt - a.createdAt).slice(0, q.limit).map((t) => engine.view(t));
  });
  app.get<{ Params: { id: string } }>("/api/thoughts/:id", async (req, reply) => {
    const t = store.getThought(req.params.id);
    return t ? engine.view(t) : reply.code(404).send({ error: "not found" });
  });
  app.get("/api/graph", async (req) => {
    const q = z.object({ includeWorking: z.enum(["0", "1"]).default("1") }).parse(req.query);
    return graphSnapshot(store, { includeWorking: q.includeWorking === "1" });
  });
  app.get("/api/sessions", async () =>
    [...store.sessions.values()].map((s) => ({ id: s.id, code: s.code, deviceKind: s.deviceKind, startedAt: s.startedAt, endedAt: s.endedAt, activity: s.activity, label: s.label, thoughts: [...store.thoughts.values()].filter((t) => t.sessionId === s.id).length })),
  );

  // ------------------------------------------------------------------ recall --
  app.post("/api/recall", async (req) => {
    const b = z.object({ text: z.string().min(1).max(1000) }).parse(req.body);
    const persons = [...new Set([...entitiesInText(store, b.text).filter((e) => e.type === "person").map((e) => e.name), ...cfg.user.team.filter((m) => new RegExp(`\\b${m.name}\\b`, "i").test(b.text)).map((m) => m.name)])];
    const parsed = parseQuery(b.text, { now: clock.now(), timezone: cfg.timezone, hackathonStart: cfg.hackathonStart, persons });
    const res = await ctx.recall.search(parsed);
    return {
      constraints: res.constraints,
      relaxations: res.relaxations,
      sources: res.hits.map((h) => ({ thoughtId: h.thought.id, code: h.thought.code, title: h.thought.title, intent: h.thought.intent, when: h.thought.createdAt, activity: h.thought.activity, category: h.thought.category, score: Math.round(h.score * 100) / 100 })),
    };
  });

  // ------------------------------------------------------------------ outbox --
  app.get("/api/outbox", async () =>
    [...store.artifacts.values()]
      .filter((a) => a.kind !== "none" && a.kind !== "recall")
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((a) => ({ ...store.artifactView(a), thoughtId: a.thoughtId, thoughtCode: store.getThought(a.thoughtId)?.code, thoughtTitle: store.getThought(a.thoughtId)?.title, pushable: outbox.pushability(a) })),
  );
  app.post<{ Params: { id: string; action: string } }>("/api/artifacts/:id/:action", async (req, reply) => {
    const a = store.artifacts.get(req.params.id);
    if (!a) return reply.code(404).send({ error: "not found" });
    try {
      switch (req.params.action) {
        case "accept":
          outbox.accept(a);
          break;
        case "dismiss":
          outbox.dismiss(a);
          break;
        case "push":
          await outbox.push(a);
          break;
        case "undo":
          await outbox.undo(a);
          break;
        default:
          return reply.code(400).send({ error: "unknown action" });
      }
      return store.artifactView(a);
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });
  app.patch<{ Params: { id: string } }>("/api/artifacts/:id", async (req, reply) => {
    const a = store.artifacts.get(req.params.id);
    if (!a) return reply.code(404).send({ error: "not found" });
    try {
      outbox.edit(a, z.record(z.string(), z.unknown()).parse(req.body));
      return store.artifactView(a);
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>("/api/artifacts/:id/export", async (req, reply) => {
    const a = store.artifacts.get(req.params.id);
    if (!a) return reply.code(404).send({ error: "not found" });
    if (req.query.format === "ics") {
      const ics = outbox.ics(a);
      return ics ? reply.header("content-type", "text/calendar; charset=utf-8").header("content-disposition", `attachment; filename="${a.code}.ics"`).send(ics) : reply.code(409).send({ error: "no concrete time yet" });
    }
    const mailto = outbox.mailto(a);
    return mailto ? { mailto } : reply.code(409).send({ error: "not an email draft" });
  });

  // ----------------------------------------------------------------- privacy --
  app.get("/api/privacy/ledger", async () => ({
    items: store.ledger(),
    keys: ctx.vault.listKeys(),
    retention: { workingMemoryHours: cfg.memory.ttlHours, pauseWindowSecs: cfg.memory.pauseWindowSecs },
    paused: privacy.isPaused(),
    localOnly: privacy.localOnly,
    kekSource: ctx.vault.kekSource,
    stats: store.stats(),
    asides: ctx.asides.count,
  }));
  app.post("/api/privacy/purge", async (req) => {
    const b = z.object({ ids: z.array(z.string()).optional(), all: z.boolean().optional(), windowSecs: z.number().optional() }).parse(req.body);
    let count = 0;
    if (b.all) count = privacy.wipeAll();
    else if (b.windowSecs) count = (await privacy.forget("window", { windowSecs: b.windowSecs })).count;
    else if (b.ids?.length) count = privacy.deleteThoughts(b.ids);
    return { count };
  });
  app.post("/api/privacy/pause", async () => privacy.pause("api", "api"));
  app.post("/api/privacy/resume", async () => {
    privacy.resume("api");
    return { ok: true };
  });
  app.post("/api/privacy/local-only", async (req) => {
    const b = z.object({ on: z.boolean() }).parse(req.body);
    privacy.setLocalOnly(b.on);
    return { localOnly: privacy.localOnly };
  });
  app.get("/api/privacy/export", async (_req, reply) => reply.header("content-disposition", 'attachment; filename="synapse-export.json"').send(privacy.exportAll()));
  app.get("/api/privacy/audit", async () => ({ rows: audit.list(300), verify: audit.verify() }));
  app.get("/api/privacy/audit/verify", async () => audit.verify());
  app.post("/api/privacy/pairing/rotate", async () => {
    trust.rotate(ctx.db);
    return { ok: true };
  });

  // -------------------------------------------------------------- dictionary --
  app.get("/api/dictionary", async () =>
    [...store.dict.values()].sort((a, b) => b.salience - a.salience).map((d) => ({ term: d.term, kind: d.kind, source: d.source, salience: d.salience, lastSeen: d.lastSeen })),
  );

  // ----------------------------------------------------------------- metrics --
  app.get<{ Querystring: { format?: string } }>("/api/metrics/latency", async (req, reply) => {
    const rows = metrics.rowsSnapshot();
    if (req.query.format === "csv") {
      const head = ["fragment_id", "device_id", "transport", "source", "model", "cached_tokens", ...STAGES];
      const lines = rows.map((r) => {
        const st = stagesOf(r);
        return [r.fragmentId, r.deviceId, r.transport, r.source ?? "", r.model ?? "", r.cachedTokens ?? "", ...STAGES.map((s) => (st[s] !== undefined ? Math.round(st[s] as number) : ""))].join(",");
      });
      return reply.header("content-type", "text/csv").send([head.join(","), ...lines].join("\n"));
    }
    return { summary: metrics.summary(), rows: rows.slice(-120).map((r) => ({ ...r, stages: stagesOf(r) })) };
  });
  app.get("/api/metrics/battery", async () => ({ report: battery.report(), model: ENERGY }));

  // ---------------------------------------------------------------- calendar --
  app.get("/api/calendar", async () => listEvents(store).map(calView));
  app.post("/api/calendar", async (req) => {
    const b = z.object({ title: z.string().min(1).max(120), start: z.number(), end: z.number() }).parse(req.body);
    const rec = store.addCalendar(b.title, b.start, b.end, "manual");
    ctx.hub.broadcast({ type: "calendar.update", events: listEvents(store).map(calView) });
    return calView(rec);
  });

  // ---------------------------------------------------------------------- dev --
  app.post("/api/dev/inject", async (req) => {
    const b = z
      .object({
        text: z.string().min(1).max(2000),
        deviceId: z.string().default("dev-inject"),
        kind: z.enum(["desk", "pocket"]).default("desk"),
        sessionId: z.string().default("inject-session"),
        whisper: z.boolean().default(false),
        pauseBeforeMs: z.number().default(0),
        durationMs: z.number().optional(),
        activity: z.enum(["still", "walking", "vehicle", "desk", "unknown"]).default("desk"),
        wait: z.boolean().default(false),
      })
      .parse(req.body);
    const now = clock.now();
    const dur = b.durationMs ?? Math.max(700, b.text.split(/\s+/).length * 330);
    const dev = { id: b.deviceId, kind: b.kind, activity: b.activity };
    store.ensureSession(b.sessionId, dev.id, dev.kind, dev.activity);
    const id = `inj-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const p = engine.handleFragment(dev, {
      type: "fragment.final", fragmentId: id, sessionId: b.sessionId, text: b.text,
      t: { speechStart: now - dur - b.pauseBeforeMs * 0, speechEnd: now, commitSent: now, wisprFinal: now },
      durationMs: dur, pauseBeforeMs: b.pauseBeforeMs, rmsMean: b.whisper ? 0.02 : 0.08, rmsMax: b.whisper ? 0.05 : 0.2, whisper: b.whisper, activity: b.activity, transport: "mock",
    });
    if (b.wait) {
      await p;
      await engine.idle();
    }
    return { fragmentId: id };
  });
  app.post("/api/dev/consolidate", async () => ctx.consolidator.run());
  app.get("/api/consolidation", async () => ctx.consolidator.last ?? null);
  app.post("/api/dev/replay", async (req) => {
    const script = z
      .object({ name: z.string(), sessionId: z.string().optional(), steps: z.array(z.record(z.string(), z.unknown())), speed: z.number().optional(), settle: z.boolean().optional() })
      .parse(req.body);
    const out = await runReplay(ctx, script as unknown as ReplayScript, { speed: script.speed, settle: script.settle });
    return out;
  });
}
