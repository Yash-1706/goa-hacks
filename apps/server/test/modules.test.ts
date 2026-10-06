import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Db } from "../src/memory/db";
import { AuditChain } from "../src/privacy/audit";
import { FakeClock } from "../src/clock";
import { stagesOf, Metrics, modelledEnergy, naiveBaseline, BatteryLog, type LatencyRow } from "../src/metrics/latency";
import { Trust, isLoopback } from "../src/gateway/trust";
import { loadConfig } from "../src/config";
import { WisprService } from "../src/wispr/service";
import { ambiguity } from "../src/cortex/resolver";
import { computeSalience } from "../src/cortex/salience";
import { makeApp, type TestApp } from "./app-helper";
import { makeStore } from "./helpers";
import type { Candidate } from "../src/cortex/types";

let app: TestApp | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
  vi.unstubAllGlobals();
});

describe("audit chain (tamper-evident)", () => {
  it("verifies, and detects a rewritten or deleted row", () => {
    const db = new Db(":memory:");
    const clock = new FakeClock(1_000);
    const chain = new AuditChain(db, clock);
    for (let i = 0; i < 5; i++) {
      clock.advance(10);
      chain.append("captured", `T-${i}`, i);
    }
    expect(chain.verify()).toEqual({ ok: true, count: 5 });
    db.run("UPDATE audit SET count = 99 WHERE seq = 3");
    expect(chain.verify()).toMatchObject({ ok: false, brokenAt: 3 });
    db.run("UPDATE audit SET count = 2 WHERE seq = 3"); // restore
    expect(chain.verify().ok).toBe(true);
    db.run("DELETE FROM audit WHERE seq = 2");
    expect(chain.verify().ok).toBe(false);
  });

  it("carries the chain across a restart", () => {
    const db = new Db(":memory:");
    const clock = new FakeClock(5);
    new AuditChain(db, clock).append("a", null, null);
    const again = new AuditChain(db, clock);
    again.append("b", null, null);
    expect(again.verify()).toEqual({ ok: true, count: 2 });
  });
});

describe("latency stages", () => {
  const base: LatencyRow = { fragmentId: "f", deviceId: "d", transport: "wispr_ws", createdAt: 0 };
  it("derives each stage with the device clock offset", () => {
    const r: LatencyRow = { ...base, speechEnd: 10_000, commitSent: 10_010, wisprFinal: 10_310, serverRecv: 20_330, offset: 10_000, firstPaintEmit: 20_345, llmStart: 20_346, llmDone: 20_900, artifactEmit: 20_905, clientFirstPaint: 10_360, clientArtifactRender: 10_930 };
    const st = stagesOf(r);
    expect(st.wispr).toBe(300);
    expect(st.toServer).toBe(20); // serverRecv − (wisprFinal + offset)
    expect(st.triage).toBe(15);
    expect(st.cortex).toBe(554);
    expect(st.firstPaint).toBe(50); // client render − final (server timeline)
    expect(st.artifact).toBe(620);
    expect(st.speechToArtifact).toBe(930);
  });

  it("summarises p50/p95 and tracks the pause stage", () => {
    const m = new Metrics(new Db(":memory:"), new FakeClock(1));
    for (let i = 1; i <= 20; i++) m.server(`f${i}`, "d", { serverRecv: 100, firstPaintEmit: 100 + i * 10, transport: "replay" });
    m.recordPause(700);
    const s = m.summary();
    expect(s.stages.triage!.p50).toBe(100);
    expect(s.stages.triage!.p95).toBe(190);
    expect(s.stages.pause!.p50).toBe(700);
  });

  it("battery model: VAD-gated streaming beats always-on streaming", () => {
    const window = 600_000; // 10 min with ~90 s of speech
    const gated = { cpuMs: 18_000, radioMs: 100_000, bytesUp: 90 * 32_000 * (4 / 3) };
    const naive = naiveBaseline(window);
    expect(modelledEnergy(gated)).toBeLessThan(naive.energy * 0.3);
    const log = new BatteryLog(new Db(":memory:"));
    log.add({ deviceId: "p", ts: 1, mode: "eco", windowMs: window, ...gated });
    expect(log.report()[0]!.savedPct).toBeGreaterThanOrEqual(70);
  });
});

describe("device trust and pairing", () => {
  const cfg = loadConfig({ REQUIRE_PAIRING: "1" });
  const trust = new Trust(new Db(":memory:"), cfg);
  it("trusts loopback, requires the code elsewhere, then accepts the issued token", () => {
    expect(isLoopback("::1")).toBe(true);
    expect(trust.check("::1", "d1").ok).toBe(true);
    expect(trust.check("192.168.1.9", "phone").ok).toBe(false);
    expect(trust.check("192.168.1.9", "phone", undefined, "000000").ok).toBe(false);
    const paired = trust.check("192.168.1.9", "phone", undefined, trust.pairingCode);
    expect(paired.ok).toBe(true);
    expect(paired.token).toBeTruthy();
    expect(trust.check("192.168.1.9", "phone", paired.token).ok).toBe(true);
    expect(trust.check("192.168.1.9", "other-phone", paired.token).ok).toBe(false); // token is bound to the device id
  });
  it("trusts x-forwarded-for only from loopback (the dev proxy), never from a remote peer", () => {
    const viaProxy = trust.clientIp({ socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": "192.168.1.50" } } as never);
    expect(viaProxy).toBe("192.168.1.50");
    const spoof = trust.clientIp({ socket: { remoteAddress: "192.168.1.77" }, headers: { "x-forwarded-for": "127.0.0.1" } } as never);
    expect(spoof).toBe("192.168.1.77");
  });
});

describe("wispr service", () => {
  it("mock mode mints nothing; client mode mints a short-lived token with the org key and caches it", async () => {
    const store = (await makeStore()).store;
    const mockSvc = new WisprService({ cfg: loadConfig({ WISPR_MODE: "mock" }), store, clock: new FakeClock(0), anyListening: () => false });
    expect((await mockSvc.token("d1")).mode).toBe("mock");

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ access_token: `jwt-for-${body.client_id}`, expires_in: 900 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const cfg = loadConfig({ WISPR_MODE: "client", WISPR_API_KEY: "Bearer fl-test123", WISPR_LANGUAGES: "en,hi" });
    const clock = new FakeClock(1_000_000);
    const svc = new WisprService({ cfg, store, clock, anyListening: () => true });
    const t = await svc.token("desk-1");
    expect(t).toMatchObject({ mode: "client", token: "jwt-for-desk-1", wsUrl: expect.stringContaining("/client_ws"), restUrl: expect.stringContaining("/client_api") });
    expect(t.wsUrl!.startsWith("wss://")).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://platform-api.wisprflow.ai/api/v1/dash/generate_access_token");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer fl-test123"); // no double "Bearer"
    expect(JSON.parse(String(init!.body))).toMatchObject({ client_id: "desk-1", duration_secs: 900 });
    await svc.token("desk-1");
    expect(fetchMock).toHaveBeenCalledTimes(1); // cached
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 401 })));
    const bad = await new WisprService({ cfg, store, clock, anyListening: () => true }).token("x");
    expect(bad.error).toMatch(/401/);
    expect(bad.token).toBeUndefined();
  });

  it("personalization context: dictionary ≤150, conversation ≤6 and redacted", async () => {
    const { store, clock } = await makeStore();
    for (let i = 0; i < 200; i++) store.upsertDict(`term${i}`, "jargon", "t", 0.5);
    const e = await store.upsertEntity("Sarah", "person");
    store.pinEntity(e!);
    const th = store.createThought({ sessionId: "s", deviceId: "d1", deviceKind: "desk", activity: "desk", category: "idea", title: "t", intent: "i", emb: new Float32Array(384), source: "mock" });
    for (let i = 0; i < 9; i++) {
      store.addFragment({ id: `f${i}`, sessionId: "s", thoughtId: th.id, deviceId: "d1", text: i === 8 ? "mail me at rio@example.com" : `fragment number ${i}`, tStart: i, tEnd: i + 1, pauseBeforeMs: 0, durationMs: 1, rmsMean: 0.1, whisper: false, activity: "desk", transport: "mock", emb: new Float32Array(384) }, th);
    }
    const svc = new WisprService({ cfg: loadConfig({ WISPR_MODE: "mock" }), store, clock, anyListening: () => false });
    const ctx = svc.context("d1", "s");
    expect(ctx.dictionary.length).toBeLessThanOrEqual(150);
    expect(ctx.conversation).toHaveLength(6);
    expect(JSON.stringify(ctx)).not.toContain("rio@example.com");
    expect(clock.now()).toBeGreaterThan(0);
  });
});

describe("reference ambiguity + salience", () => {
  const cand = (ref: string, score: number): Candidate => ({ id: ref, ref, kind: "thought", label: ref, snippet: ref, score });
  it("flags 'assuming you mean' only when the top candidates are within the margin", () => {
    expect(ambiguity([cand("T-1", 0.61), cand("T-2", 0.6)], "T-1").assumed).toBe(true);
    expect(ambiguity([cand("T-1", 0.8), cand("T-2", 0.5)], "T-1").assumed).toBe(false);
    expect(ambiguity([cand("T-1", 0.8)], null).assumed).toBe(false);
  });

  it("explains promotion: an explicit 'note to self' action is kept, a one-off observation is not", async () => {
    const { store, embedder } = await makeStore();
    const mk = (category: "action" | "journal", cues: Array<"explicit_remember">) => {
      const t = store.createThought({ sessionId: "s", deviceId: "d", deviceKind: "desk", activity: "desk", category, title: category, intent: category, emb: new Float32Array(384), source: "mock" });
      t.salienceCues = cues;
      t.provisional = false;
      return t;
    };
    const kept = computeSalience(store, embedder, mk("action", ["explicit_remember"]));
    expect(kept.score).toBeGreaterThanOrEqual(0.6);
    expect(kept.reasons.join(" ")).toMatch(/note to self|remember/);
    const dropped = computeSalience(store, embedder, mk("journal", []));
    expect(dropped.score).toBeLessThan(0.6);
  });
});

describe("outbox + autonomy ladder (end to end)", () => {
  it("L2 stages a bug issue; push is simulated without credentials, promotes the thought, audits, and can be undone", async () => {
    app = await makeApp({ AUTONOMY_LEVEL: "2" });
    await app.say("There's a null pointer exception in the cart service when applying a discount code");
    await app.settle();
    const t = [...app.ctx.store.thoughts.values()][0]!;
    const a = app.ctx.store.artifacts.get(t.artifactId!)!;
    expect(a.kind).toBe("github_issue");
    expect(a.status).toBe("staged");
    expect(t.promoted).toBe(false);

    const res = await app.ctx.outbox.push(a);
    expect(res.simulated).toBe(true);
    expect(res.externalRef).toMatch(/^GH-\d+$/);
    expect(a.status).toBe("executed");
    expect(t.promoted).toBe(true); // pushing something proves it mattered
    expect(app.ctx.audit.list().map((r) => r.event)).toContain("artifact_executed");

    await app.ctx.outbox.undo(a);
    expect(a.status).toBe("undone");
  });

  it("L3 auto-executes ONLY private/self-only actions at high confidence; never emails", async () => {
    app = await makeApp({ AUTONOMY_LEVEL: "3" });
    app.ctx.autonomy.setLevel(3);
    const mk = (kind: "email_draft" | "github_issue", confidence: number, tentative = false) => {
      const t = app!.ctx.store.createThought({ sessionId: "s", deviceId: "d", deviceKind: "desk", activity: "desk", category: kind === "github_issue" ? "bug" : "communication", title: "x", intent: "x", emb: new Float32Array(384), source: "mock" });
      t.confidence = confidence;
      t.tentative = tentative;
      const art = kind === "email_draft"
        ? { kind, to: ["team"], subject: "s", body: "b", tone: "neutral" as const }
        : { kind, title: "t", body_markdown: "b", labels: [], hypotheses: [] };
      return { t, a: app!.ctx.store.createArtifact(t, art, 3) };
    };
    const bug = mk("github_issue", 0.9);
    await app.ctx.autonomy.onArtifact(bug.t, bug.a);
    expect(bug.a.status).toBe("executed");

    const unsure = mk("github_issue", 0.6, true);
    await app.ctx.autonomy.onArtifact(unsure.t, unsure.a);
    expect(unsure.a.status).toBe("staged"); // below the bar: a human decides

    const mail = mk("email_draft", 0.99);
    await app.ctx.autonomy.onArtifact(mail.t, mail.a);
    expect(mail.a.status).toBe("draft"); // never sent, never staged for sending
    expect(app.ctx.outbox.pushability(mail.a).ok).toBe(false);
  });

  it("decision table by level", async () => {
    app = await makeApp();
    const { autonomy } = app.ctx;
    const t = { confidence: 0.9, tentative: false };
    const ext = { kind: "ticket" as const, status: "draft" as const };
    autonomy.setLevel(0);
    expect(autonomy.decide(ext, t, true)).toBe("draft");
    autonomy.setLevel(2);
    expect(autonomy.decide(ext, t, true)).toBe("stage");
    expect(autonomy.decide({ kind: "email_draft", status: "draft" }, t, true)).toBe("draft");
    autonomy.setLevel(3);
    expect(autonomy.decide(ext, t, true)).toBe("execute");
    expect(autonomy.decide(ext, t, false)).toBe("stage");
    expect(autonomy.decide({ kind: "ticket", status: "executed" }, t, true)).toBe("none");
  });

  it("exports an .ics only when the event has a concrete time, and a mailto for emails", async () => {
    app = await makeApp();
    const t = app.ctx.store.createThought({ sessionId: "s", deviceId: "d", deviceKind: "desk", activity: "desk", category: "scheduling", title: "x", intent: "x", emb: new Float32Array(384), source: "mock" });
    const withTime = app.ctx.store.createArtifact(t, { kind: "calendar_event", title: "Vendor sync", start_iso: "2026-10-09T15:00:00+05:30", end_iso: null, time_expression: "Friday 3pm", attendees: [], is_reschedule: false }, 2);
    const ics = app.ctx.outbox.ics(withTime)!;
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("SUMMARY:Vendor sync");
    expect(ics).toContain("DTSTART:20261009T093000Z"); // 15:00 IST
    expect(ics).toContain("DTEND:20261009T100000Z"); // default 30 minutes
    const noTime = app.ctx.store.createArtifact(t, { kind: "calendar_event", title: "Clash", start_iso: null, end_iso: null, time_expression: "Thursday", attendees: [], is_reschedule: true }, 2);
    expect(app.ctx.outbox.ics(noTime)).toBeNull();
    expect(app.ctx.outbox.pushability(noTime)).toMatchObject({ ok: false });
    const mail = app.ctx.store.createArtifact(t, { kind: "email_draft", to: ["sarah@example.com"], subject: "Delay", body: "Hi Sarah", tone: "neutral" }, 1);
    expect(app.ctx.outbox.mailto(mail)).toMatch(/^mailto:sarah@example\.com\?subject=Delay&body=Hi%20Sarah/);
  });
});

describe("consolidation (sleep cycle)", () => {
  it("merges duplicate entities, links related thoughts across sessions, labels sessions", async () => {
    app = await makeApp({}, "2026-10-04T10:00:00+05:30");
    await app.say("There's a null pointer exception in the cart service when applying a discount code", { session: "A" });
    await app.settle();
    app.clock.advance(20 * 3600_000);
    await app.say("The cart service discount code validator needs a regression test", { session: "B" });
    await app.settle();
    app.ctx.store.endSession("A");
    app.ctx.store.endSession("B");

    // forge a duplicate entity (as if two spellings had slipped through) and make sure the sleep cycle merges it
    const base = [...app.ctx.store.entities.values()].find((e) => e.type === "component")!;
    const dup = { ...base, id: "dup-entity", code: "E-999", name: "cart service", aliases: [], longTerm: 0 as const };
    app.ctx.store.entities.set(dup.id, dup);
    app.ctx.store.entityVec.upsert(dup.id, dup.emb);
    app.ctx.store.saveEntity(dup);

    const before = [...app.ctx.store.entities.values()].filter((e) => e.type === "component").length;
    const rep = await app.ctx.consolidator.run();
    const after = [...app.ctx.store.entities.values()].filter((e) => e.type === "component").length;
    expect(rep.merged).toBeGreaterThanOrEqual(1);
    expect(after).toBeLessThan(before);
    expect(rep.linked).toBeGreaterThanOrEqual(1);
    expect([...app.ctx.store.edges.values()].some((e) => e.type === "same_topic")).toBe(true);
    expect(rep.sessionsLabelled).toBeGreaterThanOrEqual(1);
    expect(createHash("sha256").update("x").digest("hex")).toBeTruthy();
  });
});
