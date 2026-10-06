import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeApp, type TestApp } from "./app-helper";

/**
 * `pnpm dev` restarts the server on every file change, and a laptop can die mid-sentence. A thought that was still
 * open when the process stopped must not stay "analyzing" forever.
 */

const dirs: string[] = [];
let live: TestApp | undefined;
afterEach(async () => {
  await live?.stop().catch(() => undefined);
  live = undefined;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("restart", () => {
  it("a thought that was still open (or still showing its first-paint card) at shutdown is finalized on the next start", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-restart-"));
    dirs.push(dir);
    const dbFile = path.join(dir, "synapse.db");
    const kek = randomBytes(32);

    const first = await makeApp({ DATA_DIR: dir }, undefined, dbFile, kek);
    await first.say("There's a null pointer exception in the cart service when applying a discount code"); // thread stays open
    await first.say("Maybe retry with exponential backoff and jitter", { gapMs: 9000 }); // a second thread
    const open = [...first.ctx.store.thoughts.values()];
    expect(open.length).toBeGreaterThanOrEqual(1);
    expect(open.some((t) => t.status === "open")).toBe(true);
    // one of them is still showing its local first-paint card
    const provisional = open.find((t) => t.status === "open")!;
    provisional.provisional = true;
    first.ctx.store.saveThought(provisional);
    await first.stop(); // like a kill or a tsx-watch restart: nothing was finalized

    const second = await makeApp({ DATA_DIR: dir }, undefined, dbFile, kek);
    live = second;
    const reloaded = [...second.ctx.store.thoughts.values()];
    expect(reloaded.length).toBe(open.length); // nothing lost
    for (const t of reloaded) {
      expect(t.status, t.code).toBe("final");
      expect(t.provisional, t.code).toBe(false);
    }
    // and it is recallable again (a stuck-open thought is not)
    expect(reloaded.every((t) => second.ctx.store.isRecallable(t))).toBe(true);
  });
});
