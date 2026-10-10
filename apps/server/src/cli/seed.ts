import "../silence";
import fs from "node:fs";
import path from "node:path";
import { createApp } from "../app";
import { FakeClock } from "../clock";
import { loadConfig } from "../config";
import { serverUp } from "./common";
import { parseArgs } from "./common";
import type { Activity, FragmentFinal } from "@synapse/shared";

/**
 * pnpm seed [--reset]
 *
 * DEVELOPMENT AID. Writes ~8 backdated sessions (desk, phone-on-a-walk, in a vehicle) through the REAL pipeline on a
 * controlled clock, so the knowledge graph, recall and memory echoes have history to work with.
 * (The live demo should use real, dogfooded sessions: run Pocket mode on your phone while you build.)
 * Refuses to run while the server is up (it holds the database); --reset deletes the existing memory first.
 */
const { flags } = parseArgs(process.argv.slice(2));
// always the offline cortex, whatever .env says for the server: seeding is deterministic, offline and free (dozens of fragments)
const cfg = loadConfig({ LLM_MODE: "mock" });
if (await serverUp(`http://127.0.0.1:${cfg.port}`)) {
  console.error(`✖ a Synapse server is running on :${cfg.port}. Stop it first (it owns the database), then run seed again.`);
  process.exit(1);
}
if (flags.reset) {
  for (const f of ["synapse.db", "synapse.db-wal", "synapse.db-shm"]) fs.rmSync(path.join(cfg.dataDir, f), { force: true });
  console.log("existing memory deleted (--reset)");
}

const H = 3600_000;
interface Sess {
  id: string;
  hoursAgo: number;
  device: "desk" | "pocket";
  activity: Activity;
  say: Array<{ t: string; gap?: number; whisper?: boolean }>;
}
const SESSIONS: Sess[] = [
  { id: "seed-oauth", hoursAgo: 52, device: "desk", activity: "desk", say: [
    { t: "Sarah suggested we use OAuth2 with PKCE for the mobile app login" },
    { t: "she also wants refresh token rotation turned on", gap: 1800 },
  ] },
  { id: "seed-npe", hoursAgo: 27, device: "desk", activity: "desk", say: [
    { t: "There's a null pointer exception in the cart service when applying a discount code" },
    { t: "I think the validator doesn't handle an empty string", gap: 2100 },
    { t: "should add a regression test for coupons", gap: 1700 },
  ] },
  { id: "seed-keys", hoursAgo: 26, device: "pocket", activity: "vehicle", say: [
    { t: "Remember to rotate the staging keys on Friday", whisper: true },
    { t: "and tell Dev the cart service staging URL will change after the rotation", gap: 5200 },
  ] },
  { id: "seed-retry-1", hoursAgo: 20, device: "desk", activity: "desk", say: [
    { t: "Maybe retry with exponential backoff and jitter for the cart service webhook sender" },
    { t: "wrap fetch in a helper", gap: 1500 },
  ] },
  { id: "seed-cache", hoursAgo: 9, device: "pocket", activity: "walking", say: [
    { t: "What if we cached the embeddings on disk" },
    { t: "keep the hot ones in memory, an LRU with a size cap", gap: 1900 },
    { t: "maybe five thousand entries is enough, same for the discount code lookups in the cart service", gap: 1400, whisper: true },
  ] },
  { id: "seed-auth-decision", hoursAgo: 5, device: "desk", activity: "desk", say: [
    { t: "Hmm, the auth module needs a decision" },
    { t: "JWT with a short expiry or OAuth2 with PKCE", gap: 2200 },
    { t: "I'm leaning towards JWT because it's simpler", gap: 1800 },
  ] },
  { id: "seed-retry-2", hoursAgo: 2, device: "pocket", activity: "walking", say: [
    { t: "The retry thing again, backoff with jitter on network errors" },
    { t: "I should write that wrapper properly", gap: 2000 },
  ] },
  { id: "seed-clash", hoursAgo: 1, device: "desk", activity: "desk", say: [
    { t: "Thursday's standup clashes with the dentist" },
  ] },
];

const real = Date.now();
const clock = new FakeClock(real - 53 * H);
const { ctx, stop } = await createApp(cfg, { clock, quiet: true });
let seq = 0;
for (const s of SESSIONS) {
  clock.set(real - s.hoursAgo * H);
  let vt = clock.now();
  let lastEnd = 0;
  const dev = { id: `seed-${s.device}`, kind: s.device, activity: s.activity };
  ctx.store.ensureSession(s.id, dev.id, dev.kind, s.activity);
  for (const u of s.say) {
    const gap = u.gap ?? 0;
    const dur = Math.max(800, u.t.split(/\s+/).length * 330);
    const start = vt + gap;
    const end = start + dur;
    vt = end;
    clock.set(end);
    const msg: FragmentFinal = {
      type: "fragment.final", fragmentId: `${s.id}-${seq++}`, sessionId: s.id, text: u.t,
      t: { speechStart: start, speechEnd: end, commitSent: end, wisprFinal: end + 200 },
      durationMs: dur, pauseBeforeMs: lastEnd ? start - lastEnd : 0, rmsMean: u.whisper ? 0.02 : 0.08, rmsMax: 0.2, whisper: Boolean(u.whisper), activity: s.activity, transport: "replay",
    };
    lastEnd = end;
    await ctx.engine.handleFragment(dev, msg);
    await ctx.engine.idle();
  }
  await ctx.engine.finalizeAll();
  ctx.store.endSession(s.id);
  console.log(`✔ ${s.id.padEnd(20)} ${String(s.hoursAgo).padStart(2)}h ago  ${s.device}/${s.activity}`);
}
clock.set(real);
const rep = await ctx.consolidator.run();
console.log(`\nconsolidated: ${JSON.stringify(rep)}`);
console.log(`memory: ${JSON.stringify(ctx.store.stats())}`);
await stop();
console.log("\nSeeded. Start the server (pnpm dev) to explore the graph and try recall.");
process.exit(0);
