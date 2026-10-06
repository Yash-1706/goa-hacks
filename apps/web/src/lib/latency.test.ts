import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage } from "@synapse/shared";
import { LatencyTracker, PAINT_FALLBACK_MS, afterPaint } from "./latency";

function setup() {
  const sent: ClientMessage[] = [];
  const recorded: Array<{ kind: string; fragmentId: string; thoughtId: string; ms: number }> = [];
  let clock = 10_000;
  const pending: Array<() => void> = [];
  const tracker = new LatencyTracker({
    send: (m) => (sent.push(m), true),
    now: () => clock,
    afterPaint: (cb) => pending.push(cb),
    onFirstPaint: (fragmentId, thoughtId, ms) => recorded.push({ kind: "first", fragmentId, thoughtId, ms }),
    onArtifact: (fragmentId, thoughtId, ms) => recorded.push({ kind: "artifact", fragmentId, thoughtId, ms }),
  });
  /** simulate the browser painting: run queued callbacks at time `at` */
  const paint = (at: number): void => {
    clock = at;
    for (const cb of pending.splice(0)) cb();
  };
  return { tracker, sent, recorded, paint };
}

describe("LatencyTracker", () => {
  it("reports first paint when the first upsert after the ack has been painted", () => {
    const { tracker, sent, recorded, paint } = setup();
    tracker.noteLocal("f1", 9_900);
    tracker.onAck("f1", "t1");
    tracker.onUpsert({ id: "t1", analyzing: true, provisional: true });
    expect(sent).toHaveLength(0); // nothing is reported before the paint
    paint(10_040);
    expect(sent).toEqual([{ type: "metrics.client", fragmentId: "f1", firstPaint: 10_040 }]);
    expect(recorded).toEqual([{ kind: "first", fragmentId: "f1", thoughtId: "t1", ms: 140 }]);
  });

  it("reports artifactRender only for the finished analysis, against the LATEST acked fragment, and only once", () => {
    const { tracker, sent, recorded, paint } = setup();
    tracker.noteLocal("f1", 9_000);
    tracker.noteLocal("f2", 9_500);
    tracker.onAck("f1", "t1");
    tracker.onUpsert({ id: "t1", analyzing: true, provisional: true });
    paint(9_050);
    tracker.onAck("f2", "t1");
    tracker.onUpsert({ id: "t1", analyzing: true, provisional: false }); // streaming partial: not done
    paint(9_600);
    tracker.onUpsert({ id: "t1", analyzing: false, provisional: false }); // done
    paint(10_300);
    tracker.onUpsert({ id: "t1", analyzing: false, provisional: false }); // finalize upsert 6 s later: must NOT re-report
    paint(16_300);

    const artifact = sent.filter((m) => m.type === "metrics.client" && m.artifactRender !== undefined);
    expect(artifact).toEqual([{ type: "metrics.client", fragmentId: "f2", artifactRender: 10_300 }]);
    expect(recorded.find((r) => r.kind === "artifact")).toMatchObject({ fragmentId: "f2", ms: 800 });
    // first paints: f1 on the first upsert, f2 on the next
    expect(sent.filter((m) => m.type === "metrics.client" && m.firstPaint !== undefined).map((m) => (m as { fragmentId: string }).fragmentId)).toEqual(["f1", "f2"]);
  });

  it("ignores fragments spoken on other devices (their clock is not ours)", () => {
    const { tracker, sent, paint } = setup();
    tracker.onAck("foreign", "t9");
    tracker.onUpsert({ id: "t9", analyzing: false, provisional: false });
    paint(11_000);
    expect(sent).toHaveLength(0);
  });

  it("a removed thought is forgotten", () => {
    const { tracker, sent, paint } = setup();
    tracker.noteLocal("f1", 9_000);
    tracker.onAck("f1", "t1");
    tracker.forget("t1");
    tracker.onUpsert({ id: "t1", analyzing: false, provisional: false });
    paint(10_100);
    expect(sent).toHaveLength(0);
  });

  it("never reports a negative duration", () => {
    const { tracker, recorded, paint } = setup();
    tracker.noteLocal("f1", 20_000); // clock skew: 'final' is in the future
    tracker.onAck("f1", "t1");
    tracker.onUpsert({ id: "t1", analyzing: false, provisional: false });
    paint(10_000);
    expect(recorded.every((r) => r.ms >= 0)).toBe(true);
  });
});

describe("afterPaint", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("runs straight away without a document (tests, workers) or in a hidden tab", () => {
    const cb = vi.fn();
    afterPaint(cb);
    expect(cb).toHaveBeenCalledOnce();
    vi.stubGlobal("document", { hidden: true });
    vi.stubGlobal("requestAnimationFrame", () => 0);
    afterPaint(cb);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("waits for the frame, then a macrotask, and runs exactly once", () => {
    vi.useFakeTimers();
    let frame: (() => void) | undefined;
    vi.stubGlobal("document", { hidden: false });
    vi.stubGlobal("requestAnimationFrame", (f: () => void) => {
      frame = f;
      return 1;
    });
    const cb = vi.fn();
    afterPaint(cb);
    expect(cb).not.toHaveBeenCalled();
    frame?.();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(PAINT_FALLBACK_MS * 2);
    expect(cb).toHaveBeenCalledOnce(); // the fallback timer must not fire it again
  });

  it("does not wait forever when frames are throttled", () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { hidden: false });
    vi.stubGlobal("requestAnimationFrame", () => 1); // never fires
    const cb = vi.fn();
    afterPaint(cb);
    vi.advanceTimersByTime(PAINT_FALLBACK_MS - 1);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(cb).toHaveBeenCalledOnce();
  });
});
