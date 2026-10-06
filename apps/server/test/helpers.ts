import { randomBytes } from "node:crypto";
import { FakeClock } from "../src/clock";
import { Vault } from "../src/memory/crypto";
import { Db } from "../src/memory/db";
import { createEmbedder, HashEmbedder, type Embedder } from "../src/memory/embeddings";
import { MemoryStore } from "../src/memory/store";

let sharedModel: Promise<Embedder> | undefined;

/** Real MiniLM model (cached on disk after first download) for tests that need semantics. */
export function modelEmbedder(): Promise<Embedder> {
  sharedModel ??= createEmbedder({ mode: "model", model: "Xenova/all-MiniLM-L6-v2", dataDir: process.env.TEST_DATA_DIR ?? "D:/goa-hack/data" });
  return sharedModel;
}

export interface TestStore {
  db: Db;
  vault: Vault;
  store: MemoryStore;
  clock: FakeClock;
  embedder: Embedder;
}

export async function makeStore(opts: { embedder?: Embedder; start?: number; ttlHours?: number } = {}): Promise<TestStore> {
  const clock = new FakeClock(opts.start ?? Date.parse("2026-10-06T10:00:00Z"));
  const db = new Db(":memory:");
  const vault = Vault.withKek(db, randomBytes(32), clock.now());
  const embedder = opts.embedder ?? new HashEmbedder();
  const store = new MemoryStore(db, vault, embedder, clock, opts.ttlHours ?? 72);
  await store.init();
  return { db, vault, store, clock, embedder };
}
