import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { matchPauseIntent } from "@synapse/shared";
import { Vault, KeyDestroyedError } from "../src/memory/crypto";
import { Db } from "../src/memory/db";
import { HashEmbedder } from "../src/memory/embeddings";
import { LexIndex, VecIndex } from "../src/memory/vindex";
import { redact, rehydrate, pseudonymize } from "../src/gate/redact";
import { parseForget } from "../src/gate/intent";
import { makeStore } from "./helpers";

describe("vault (AES-256-GCM)", () => {
  it("round-trips and binds ciphertext to its AAD", () => {
    const db = new Db(":memory:");
    const v = Vault.withKek(db, randomBytes(32));
    const blob = v.seal("ltm", "thoughts|T1|title", "hello world");
    expect(v.open("ltm", "thoughts|T1|title", blob).toString()).toBe("hello world");
    // moving a blob to another row/column must fail authentication
    expect(() => v.open("ltm", "thoughts|T2|title", blob)).toThrow();
    expect(() => v.open("ltm", "thoughts|T1|intent", blob)).toThrow();
  });

  it("produces different ciphertext for identical plaintext (random IV)", () => {
    const db = new Db(":memory:");
    const v = Vault.withKek(db, randomBytes(32));
    const a = v.seal("ltm", "x|1|c", "same");
    const b = v.seal("ltm", "x|1|c", "same");
    expect(Buffer.compare(a, b)).not.toBe(0);
    expect(a.toString("utf8")).not.toContain("same");
  });

  it("crypto-shreds: a destroyed day key can never decrypt again", () => {
    const db = new Db(":memory:");
    const kek = randomBytes(32);
    const v = Vault.withKek(db, kek);
    const now = Date.parse("2026-10-01T10:00:00Z");
    const keyId = v.workingKeyId(now);
    const blob = v.seal(keyId, "t|1|c", "secret thought");
    expect(v.destroyKey(keyId, now + 1)).toBe(true);
    expect(() => v.open(keyId, "t|1|c", blob)).toThrow(KeyDestroyedError);
    // even a fresh vault on the same DB + KEK cannot recover it
    const v2 = Vault.withKek(db, kek);
    expect(() => v2.open(keyId, "t|1|c", blob)).toThrow(KeyDestroyedError);
    expect(v2.isDestroyed(keyId)).toBe(true);
  });

  it("refuses a wrong master key", () => {
    const db = new Db(":memory:");
    Vault.withKek(db, randomBytes(32));
    expect(() => Vault.withKek(db, randomBytes(32))).toThrow(/does not match/);
  });
});

describe("indexes", () => {
  it("vector search ranks by cosine and supports remove", async () => {
    const e = new HashEmbedder();
    const idx = new VecIndex(e.dim);
    const docs = ["null pointer in the cart service", "email the team about the delay", "use oauth2 for login"];
    const vs = await e.embed(docs);
    docs.forEach((_, i) => idx.upsert(`d${i}`, vs[i] as Float32Array));
    const [q] = await e.embed(["cart service null pointer bug"]);
    const hits = idx.search(q as Float32Array, 2);
    expect(hits[0]?.id).toBe("d0");
    idx.remove("d0");
    expect(idx.search(q as Float32Array, 3).map((h) => h.id)).not.toContain("d0");
    expect(idx.size).toBe(2);
  });

  it("lexical index finds and forgets documents", () => {
    const lex = new LexIndex();
    lex.upsert("a", "Cart bug", "null pointer in discount code");
    lex.upsert("b", "Email", "tell the team about the release delay");
    expect(lex.search("discount")[0]?.id).toBe("a");
    lex.remove("a");
    expect(lex.search("discount")).toHaveLength(0);
  });
});

describe("pause intent matcher", () => {
  const yes = [
    "pause memory",
    "Pause memory.",
    "pause the memory please",
    "okay pause memory",
    "paws memory", // mis-transcription
    "pause memori",
    "stop listening",
    "off the record",
    "go off the record",
    "memory band karo",
    "pause recording",
  ];
  const no = [
    "we should pause recording the metrics until the deploy finishes",
    "the memory leak is in the websocket handler",
    "I need to stop the deploy",
    "let's pause the migration for a day and think about it",
    "record the demo tomorrow",
    "that was off the charts and I told Sarah about it yesterday afternoon",
  ];
  for (const t of yes) it(`matches "${t}"`, () => expect(matchPauseIntent(t).match).toBe(true));
  for (const t of no) it(`ignores "${t}"`, () => expect(matchPauseIntent(t).match).toBe(false));
});

describe("forget intent parser", () => {
  it("parses scopes", () => {
    expect(parseForget("forget that")).toEqual({ kind: "forget", scope: "last" });
    expect(parseForget("forget the last five minutes")).toEqual({ kind: "forget", scope: "window", windowSecs: 300 });
    expect(parseForget("delete the last 2 minutes")).toEqual({ kind: "forget", scope: "window", windowSecs: 120 });
    expect(parseForget("forget what I said about Sarah")).toMatchObject({ kind: "forget", scope: "query", query: "sarah" });
    expect(parseForget("I forgot that the build was red")).toBeNull();
  });
});

describe("redaction", () => {
  it("masks emails, cards (Luhn), keys and spoken secrets, and rehydrates", () => {
    const input =
      "mail me at rio@example.com card 4242 4242 4242 4242 key sk-ant-abcdefghijklmnop1234 and the password is hunter two";
    const r = redact(input);
    expect(r.text).not.toContain("rio@example.com");
    expect(r.text).not.toContain("4242 4242");
    expect(r.text).not.toContain("sk-ant-abcdefghijklmnop1234");
    expect(r.text).not.toContain("hunter");
    expect(r.map.length).toBeGreaterThanOrEqual(4);
    const back = rehydrate({ note: r.text }, r.map);
    expect(back.note).toContain("rio@example.com");
  });

  it("does not mangle ordinary numbers", () => {
    const r = redact("scale the auth service to 10 replicas and roll back to v2.1.4 at 3 pm");
    expect(r.text).toBe("scale the auth service to 10 replicas and roll back to v2.1.4 at 3 pm");
    expect(r.map).toHaveLength(0);
  });

  it("pseudonymizes known names", () => {
    const r = pseudonymize("Sarah told Dev to ship it", ["Sarah", "Dev"]);
    expect(r.text).not.toMatch(/Sarah|Dev/);
    expect(rehydrate(r.text, r.map)).toBe("Sarah told Dev to ship it");
  });
});

describe("memory store", () => {
  async function seeded() {
    const t = await makeStore();
    const { store } = t;
    const [emb] = await t.embedder.embed(["null pointer cart discount"]);
    const s = store.ensureSession("S1", "dev1", "desk", "desk");
    const th = store.createThought({
      sessionId: s.id, deviceId: "dev1", deviceKind: "desk", activity: "desk",
      category: "bug", title: "NPE in cart discount", intent: "A null pointer in the discount code path.",
      emb: emb as Float32Array, source: "mock",
    });
    store.addFragment(
      { id: "F1", sessionId: s.id, thoughtId: th.id, deviceId: "dev1", text: "that bug with the null pointer in the cart service", tStart: 1, tEnd: 2, pauseBeforeMs: 0, durationMs: 1000, rmsMean: 0.1, whisper: false, activity: "desk", transport: "mock", emb: emb as Float32Array },
      th,
    );
    const ent = await store.upsertEntity("cart service", "component");
    store.linkEntities(th, [ent!]);
    store.saveThought(th);
    const art = store.createArtifact(th, { kind: "github_issue", title: "NPE", body_markdown: "x", labels: [], hypotheses: [] }, 1);
    store.createOpenLoop(th, "what did Sarah say?");
    return { ...t, th, ent: ent!, art };
  }

  it("persists everything encrypted, with no plaintext in the DB file", async () => {
    const { db, th } = await seeded();
    const rows = db.all<{ text_enc: Uint8Array }>("SELECT text_enc FROM fragments");
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0]!.text_enc).toString("utf8")).not.toContain("null pointer");
    const t = db.get<{ title_enc: Uint8Array }>("SELECT title_enc FROM thoughts WHERE id = ?", th.id);
    expect(Buffer.from(t!.title_enc).toString("utf8")).not.toContain("NPE");
  });

  it("survives a restart (reload from the encrypted DB)", async () => {
    const t = await seeded();
    const { MemoryStore } = await import("../src/memory/store");
    const again = new MemoryStore(t.db, t.vault, t.embedder, t.clock, 72);
    await again.init();
    expect(again.thoughts.size).toBe(1);
    const th = [...again.thoughts.values()][0]!;
    expect(th.title).toBe("NPE in cart discount");
    expect(again.fragmentsOf(th)[0]?.text).toContain("null pointer");
    expect(again.entities.size).toBe(1);
    expect(again.artifacts.size).toBe(1);
  });

  it("cascade delete leaves no row or index entry behind (PRV-11)", async () => {
    const { store, db, th, ent } = await seeded();
    const report = store.deleteThought(th.id)!;
    expect(report.fragments).toBe(1);
    expect(report.artifacts).toBe(1);
    expect(report.openLoops).toBe(1);
    expect(report.entities).toBe(1);
    expect(store.thoughts.size + store.frags.size + store.artifacts.size + store.openLoops.size + store.entities.size).toBe(0);
    for (const table of ["thoughts", "fragments", "artifacts", "open_loops", "thought_entities", "entities"]) {
      expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n).toBe(0);
    }
    expect(store.thoughtVec.size).toBe(0);
    expect(store.fragVec.size).toBe(0);
    expect(store.entityVec.size).toBe(0);
    expect(store.lex.size).toBe(0);
    expect(store.entities.has(ent.id)).toBe(false);
  });

  it("expires working memory after the TTL and crypto-shreds the day key", async () => {
    const { store, clock, vault, th } = await seeded();
    const keyId = th.keyId;
    expect(keyId.startsWith("day:")).toBe(true);
    clock.advance(71 * 3600_000);
    expect(store.sweep().thoughts).toBe(0);
    clock.advance(2 * 3600_000); // 73 h
    const r = store.sweep();
    expect(r.thoughts).toBe(1);
    expect(store.thoughts.size).toBe(0);
    clock.advance(26 * 3600_000); // day-key grace
    const r2 = store.sweep();
    expect(r2.keysDestroyed).toContain(keyId);
    expect(vault.isDestroyed(keyId)).toBe(true);
  });

  it("promotion moves a thought to the long-term key and survives TTL", async () => {
    const { store, clock, th, db } = await seeded();
    store.promote(th, ["repeated 2×", "actionable"]);
    expect(th.keyId).toBe("ltm");
    expect(th.expiresAt).toBeNull();
    clock.advance(200 * 3600_000);
    expect(store.sweep().thoughts).toBe(0);
    expect(store.thoughts.size).toBe(1);
    expect(db.get<{ key_id: string }>("SELECT key_id FROM fragments WHERE id = 'F1'")!.key_id).toBe("ltm");
  });

  it("purgeSince removes thoughts touched inside the window", async () => {
    const { store, clock, th } = await seeded();
    clock.advance(60_000);
    const removed = store.purgeSince(clock.now() - 120_000);
    expect(removed).toEqual([th.id]);
    expect(store.thoughts.size).toBe(0);
  });

  it("resolves entities by alias, first name and separator-less form", async () => {
    const { store } = await makeStore();
    const a = await store.upsertEntity("Sarah Johnson", "person");
    const b = await store.upsertEntity("Sarah", "person");
    expect(b?.id).toBe(a?.id);
    const c = await store.upsertEntity("cart service", "component");
    const d = await store.upsertEntity("cart-service", "component");
    expect(d?.id).toBe(c?.id);
  });

  it("a correction replaces the 'learned from' origin of a term that already exists, and a later plain mention does not undo it", async () => {
    const { store } = await makeStore();
    store.upsertDict("cart-service", "component", "learned from T-1", 0.5);
    store.upsertDict("cart-service", "component", 'corrected "cart surface" → "cart-service" in T-2', 0.8);
    expect(store.dict.get("cart-service")!.source).toMatch(/^corrected "cart surface"/);
    store.upsertDict("cart-service", "component", "learned from T-3", 0.6);
    expect(store.dict.get("cart-service")!.source).toMatch(/^corrected/);
    expect(store.dict.get("cart-service")!.salience).toBe(0.8); // never lowered
    // seeds keep their origin when the same term is merely learned later
    store.upsertDict("Sarah", "person", "team", 0.9);
    store.upsertDict("Sarah", "person", "learned from T-4", 0.5);
    expect(store.dict.get("sarah")!.source).toBe("team");
  });
});

describe("wire protocol: suggestion.action carries the slot the person picked", () => {
  it("keeps a valid pick, rejects an invalid one", async () => {
    const { ClientMessageSchema } = await import("@synapse/shared");
    const ok = ClientMessageSchema.parse({ type: "suggestion.action", id: "s1", action: "accept", pick: 2 });
    expect(ok).toMatchObject({ type: "suggestion.action", action: "accept", pick: 2 });
    expect(ClientMessageSchema.parse({ type: "suggestion.action", id: "s1", action: "dismiss" })).not.toHaveProperty("pick");
    for (const pick of [-1, 10, 1.5, "2"]) {
      expect(ClientMessageSchema.safeParse({ type: "suggestion.action", id: "s1", action: "accept", pick }).success, String(pick)).toBe(false);
    }
  });
});
