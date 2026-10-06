import "../silence";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config";
import { ephemeralApp, parseArgs, serverUp } from "./common";
import { runReplay, type ReplayScript } from "./replay-lib";

/**
 * pnpm replay scripts/replay/s1_bug.json [--speed 4] [--url http://127.0.0.1:8787] [--local]
 *
 * Default: if a Synapse server is running, the script is played INTO it (open the UI and watch the
 * cards form). Otherwise (or with --local) it runs in a throw-away in-process app and prints the result.
 */
const { positional, flags } = parseArgs(process.argv.slice(2));
const file = positional[0];
if (!file) {
  console.error("usage: pnpm replay <script.json> [--speed N] [--url URL] [--local]");
  process.exit(2);
}
const script = JSON.parse(fs.readFileSync(path.resolve(process.env.INIT_CWD ?? REPO_ROOT, file), "utf8")) as ReplayScript;
const speed = Number(flags.speed ?? 1);
const url = String(flags.url ?? "http://127.0.0.1:8787");

async function playIntoServer(): Promise<void> {
  console.log(`▶ ${script.name}\n  playing into the running server at ${url} (speed ×${speed}); watch the UI`);
  const res = await fetch(`${url}/api/dev/replay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: script.name, sessionId: script.sessionId, steps: script.steps, speed }),
  });
  console.log(res.ok ? `✔ done: ${JSON.stringify(await res.json())}` : `✖ ${res.status} ${await res.text()}`);
  // no process.exit() here: exiting while undici sockets are closing trips a libuv assertion on Windows
  process.exitCode = res.ok ? 0 : 1;
}

async function runLocal(): Promise<void> {
  console.log(`▶ ${script.name}\n  (no server at ${url}: running in-process, mock cortex)\n  ${script.description ?? ""}\n`);
  // No timer-based thread closing in a compressed replay: at high --speed the close timer raced the arrivals and split
  // thoughts that a human-paced run keeps together. Threads end by stitching decisions, `endThread` steps and finalizeAll().
  const { ctx, stop } = await ephemeralApp({ THREAD_CLOSE_MS: "600000", SUGGESTION_MIN_GAP_S: "0" });
  ctx.proactive.start();
  await runReplay(ctx, script, { speed, settle: true });
  await ctx.engine.finalizeAll();
  await new Promise((r) => setTimeout(r, 900));

  for (const t of [...ctx.store.thoughts.values()].sort((a, b) => a.createdAt - b.createdAt)) {
    const v = ctx.engine.view(t);
    console.log(`${t.code}  [${v.category}] ${v.title}  (conf ${v.confidence.toFixed(2)}${v.tentative ? ", tentative" : ""})`);
    console.log(`      ${v.fragments.length} fragment(s) · ${v.intent}`);
    if (v.repairs.length) console.log(`      repairs: ${v.repairs.map((r) => `~~${r.rejected}~~ → ${r.chosen}`).join("; ")}`);
    if (v.references.length) console.log(`      refs: ${v.references.map((r) => `"${r.mention}" → ${r.resolvedCode ?? "?"}`).join("; ")}`);
    if (v.openQuestions.length) console.log(`      open: ${v.openQuestions.join(" | ")}`);
    if (v.artifact) console.log(`      artifact: ${v.artifact.kind} (${v.artifact.status})`);
  }
  console.log(`\nasides filtered: ${ctx.asides.count}`);
  for (const s of ctx.proactive.snapshot().suggestions) console.log(`suggestion [${s.kind}] ${s.title}\n      ${s.body}\n      why: ${s.why}`);
  console.log(`paused: ${ctx.privacy.isPaused()}`);
  await stop();
  process.exit(0);
}

if (!flags.local && (await serverUp(url))) await playIntoServer();
else await runLocal();
