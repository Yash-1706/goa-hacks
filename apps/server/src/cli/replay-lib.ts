import type { Activity, FragmentFinal } from "@synapse/shared";
import type { AppCtx } from "../app";
import type { DeviceRef } from "../ctx";

/* ============================================================================
 * Scripted rambles (TRD §17): a JSON script drives the REAL pipeline the same way a microphone
 * would, with a virtual client timeline so pauses are realistic even when sped up.
 * ========================================================================== */

export interface ReplayStep {
  /** an utterance as Wispr would return it */
  say?: string;
  /** silence before the utterance (ms): this is what the stitcher sees */
  gapMs?: number;
  durationMs?: number;
  whisper?: boolean;
  /** pause without speech (ms) */
  wait?: number;
  /** switch the speaking device for this and following steps */
  device?: "desk" | "pocket";
  activity?: Activity;
  /** finalize the open thread right now */
  endThread?: boolean;
  note?: string;
}

export interface ReplayScript {
  name: string;
  description?: string;
  sessionId?: string;
  steps: ReplayStep[];
}

export interface ReplayOptions {
  /** 1 = real time. 10 = ten times faster (client timestamps stay realistic). */
  speed?: number;
  /** await the model after every utterance (benchmarks) instead of streaming ahead */
  settle?: boolean;
  onStep?: (i: number, step: ReplayStep) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function devRef(kind: "desk" | "pocket", activity: Activity): DeviceRef {
  return { id: kind === "pocket" ? "replay-pocket" : "replay-desk", kind, activity };
}

export async function runReplay(ctx: AppCtx, script: ReplayScript, opts: ReplayOptions = {}): Promise<{ fragments: number; ids: string[] }> {
  const speed = Math.max(0.1, opts.speed ?? 1);
  let vt = Date.now();
  let kind: "desk" | "pocket" = "desk";
  let activity: Activity = "desk";
  let lastEnd = 0;
  let seq = 0;
  const session = script.sessionId ?? `replay-${script.name.replace(/\W+/g, "-").toLowerCase()}-${Date.now().toString(36)}`;
  const ids: string[] = [];

  for (let i = 0; i < script.steps.length; i++) {
    const step = script.steps[i] as ReplayStep;
    opts.onStep?.(i, step);
    if (step.device) {
      kind = step.device;
      activity = step.activity ?? (kind === "pocket" ? "walking" : "desk");
    } else if (step.activity) activity = step.activity;
    if (step.wait) {
      vt += step.wait;
      await sleep(step.wait / speed);
    }
    if (step.endThread) {
      await ctx.engine.finalizeDevice(devRef(kind, activity).id);
    }
    if (!step.say) continue;

    const gap = step.gapMs ?? 0;
    const words = step.say.split(/\s+/).length;
    const dur = step.durationMs ?? Math.max(700, words * 330);
    await sleep(gap / speed);
    const speechStart = vt + gap;
    const speechEnd = speechStart + dur;
    vt = speechEnd;
    await sleep(Math.min(dur / speed, 1500));
    const msg: FragmentFinal = {
      type: "fragment.final",
      fragmentId: `${session}-${(seq++).toString(36)}`,
      sessionId: session,
      text: step.say,
      t: { speechStart, speechEnd, commitSent: speechEnd, wisprFinal: speechEnd + 220 },
      durationMs: dur,
      pauseBeforeMs: lastEnd ? Math.max(0, speechStart - lastEnd) : 0,
      rmsMean: step.whisper ? 0.02 : 0.08,
      rmsMax: step.whisper ? 0.05 : 0.2,
      whisper: Boolean(step.whisper),
      activity,
      transport: "replay",
    };
    lastEnd = speechEnd;
    ids.push(msg.fragmentId);
    const dev = devRef(kind, activity);
    ctx.store.ensureSession(session, dev.id, dev.kind, activity);
    await ctx.engine.handleFragment(dev, msg);
    if (opts.settle) await ctx.engine.idle();
  }
  return { fragments: ids.length, ids };
}
