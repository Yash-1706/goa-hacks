/* ============================================================================
 * Activity classifier (TRD §11.3, DEV-3): still / walking / vehicle / desk from DeviceMotion.
 *
 *   4 s windows of |accelerationIncludingGravity| (m/s^2), ~50-60 Hz
 *     sigma    = standard deviation of the magnitude
 *     stepHz   = cycles per second of the detrended signal, counted as rising zero-crossings with hysteresis
 *   still   : sigma < 0.15
 *   walking : 0.6 <= sigma <= 4 AND stepHz in [1.3, 2.6]
 *   vehicle : 0.15 <= sigma < 0.6 WITHOUT step periodicity
 *   anything else (e.g. fidgeting, running, gentle sway with a step rhythm) -> "unknown"
 * The reported label is the majority of the last 3 windows. Desktop / no sensor -> "desk".
 * Only the label ever leaves the device: raw motion is never stored or sent.
 *
 * Exports: pure functions (classifyMotionWindow, majorityVote, accelMagnitude) for tests, and
 * startActivityClassifier(onChange) for the UI. Call the latter from a user gesture (iOS permission prompt).
 * ========================================================================== */
import type { Activity } from "@synapse/shared";

export const WINDOW_MS = 4000;
export const STILL_MAX_SIGMA = 0.15;
export const WALK_MIN_SIGMA = 0.6;
export const WALK_MAX_SIGMA = 4;
export const STEP_MIN_HZ = 1.3;
export const STEP_MAX_HZ = 2.6;
/** windows with fewer samples than this are not trusted (throttled sensor, backgrounded page) */
export const MIN_WINDOW_SAMPLES = 24;

export interface MotionWindowResult {
  label: Activity;
  /** std dev of the magnitude (m/s^2) */
  sigma: number;
  /** step / oscillation frequency of the detrended signal (Hz) */
  stepHz: number;
  mean: number;
  samples: number;
}

/** |a| of a DeviceMotionEvent.accelerationIncludingGravity-like object, or null when the sensor gave nothing */
export function accelMagnitude(
  a: { x: number | null; y: number | null; z: number | null } | null | undefined,
): number | null {
  if (!a) return null;
  const { x, y, z } = a;
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return Math.sqrt(x * x + y * y + z * z);
}

/**
 * Rising zero-crossings per second of the mean-removed signal, after a 3-point moving average, with a dead band of
 * max(0.25 sigma, 0.05) so noise around zero does not count as steps.
 */
export function oscillationHz(samples: ArrayLike<number>, durationSec: number): number {
  const n = samples.length;
  if (n < 8 || durationSec <= 0) return 0;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += samples[i] as number;
  mean /= n;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = (samples[i] as number) - mean;
  // 3-point moving average
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = x[Math.max(0, i - 1)] as number;
    const b = x[i] as number;
    const c = x[Math.min(n - 1, i + 1)] as number;
    s[i] = (a + b + c) / 3;
  }
  let varSum = 0;
  for (let i = 0; i < n; i++) varSum += (s[i] as number) * (s[i] as number);
  const band = Math.max(0.25 * Math.sqrt(varSum / n), 0.05);

  // Schmitt trigger: arm below -band, count when the signal rises above +band
  let armed = false;
  let rises = 0;
  let firstIdx = -1;
  let lastIdx = -1;
  for (let i = 0; i < n; i++) {
    const v = s[i] as number;
    if (v < -band) armed = true;
    else if (v > band && armed) {
      armed = false;
      rises++;
      if (firstIdx < 0) firstIdx = i;
      lastIdx = i;
    }
  }
  if (rises === 0) return 0;
  const dt = durationSec / (n - 1);
  if (rises >= 3 && lastIdx > firstIdx) return (rises - 1) / ((lastIdx - firstIdx) * dt);
  return rises / durationSec;
}

/** classify one window of acceleration magnitudes */
export function classifyMotionWindow(magnitudes: ArrayLike<number>, durationSec: number): MotionWindowResult {
  const n = magnitudes.length;
  if (n < MIN_WINDOW_SAMPLES || !(durationSec > 0)) {
    return { label: "unknown", sigma: 0, stepHz: 0, mean: 0, samples: n };
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += magnitudes[i] as number;
  mean /= n;
  let v = 0;
  for (let i = 0; i < n; i++) {
    const d = (magnitudes[i] as number) - mean;
    v += d * d;
  }
  const sigma = Math.sqrt(v / n);
  const stepHz = oscillationHz(magnitudes, durationSec);
  const stepping = stepHz >= STEP_MIN_HZ && stepHz <= STEP_MAX_HZ;

  let label: Activity = "unknown";
  if (sigma < STILL_MAX_SIGMA) label = "still";
  else if (sigma >= WALK_MIN_SIGMA && sigma <= WALK_MAX_SIGMA && stepping) label = "walking";
  else if (sigma < WALK_MIN_SIGMA && !stepping) label = "vehicle";
  return { label, sigma, stepHz, mean, samples: n };
}

/**
 * Majority of the last (up to) 3 labels. A single window is taken at face value; with no majority the previous
 * stable label stays.
 */
export function majorityVote(history: readonly Activity[], previous: Activity): Activity {
  const last = history.slice(-3);
  if (last.length === 0) return previous;
  if (last.length === 1) return last[0] as Activity;
  const counts = new Map<Activity, number>();
  for (const l of last) counts.set(l, (counts.get(l) ?? 0) + 1);
  let best: Activity | null = null;
  let bestN = 0;
  for (const [l, c] of counts) {
    if (c > bestN) {
      best = l;
      bestN = c;
    }
  }
  return best !== null && bestN >= 2 ? best : previous;
}

/* ------------------------------------------------------------------ the DeviceMotion wrapper */

export interface MotionEventLike {
  accelerationIncludingGravity?: { x: number | null; y: number | null; z: number | null } | null;
  timeStamp?: number;
}

export interface ActivityDeps {
  /** where "devicemotion" events come from (default: window) */
  target?: { addEventListener(type: string, fn: (e: never) => void): void; removeEventListener(type: string, fn: (e: never) => void): void } | null;
  /** the DeviceMotionEvent constructor (for the iOS requestPermission static); default: globalThis.DeviceMotionEvent */
  deviceMotionEvent?: { requestPermission?: () => Promise<"granted" | "denied" | string> } | null;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
  /** window length (default 4000 ms) */
  windowMs?: number;
  /** how long to wait for the first real sensor reading before concluding "desk" (default 1500 ms) */
  probeMs?: number;
}

export interface ActivityHandle {
  stop(): void;
  /** false on desktops, browsers without DeviceMotion, or when the user denied motion access */
  supported: boolean;
}

/**
 * Start classifying. On iOS this requests the DeviceMotion permission, so call it from a user gesture
 * (the permission request is issued synchronously, before this function returns its promise).
 * Unsupported / desktop: resolves {supported:false} and calls onChange("desk") once.
 * Permission denied: resolves {supported:false} and calls onChange("unknown") once.
 */
export function startActivityClassifier(
  onChange: (a: Activity) => void,
  deps: ActivityDeps = {},
): Promise<ActivityHandle> {
  const g = globalThis as unknown as { window?: ActivityDeps["target"]; DeviceMotionEvent?: ActivityDeps["deviceMotionEvent"] };
  const target = deps.target === undefined ? (g.window ?? null) : deps.target;
  const DME = deps.deviceMotionEvent === undefined ? (g.DeviceMotionEvent ?? null) : deps.deviceMotionEvent;
  const now = deps.now ?? (() => performance.now());
  const setT = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = deps.clearTimeout ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const windowMs = deps.windowMs ?? WINDOW_MS;
  const probeMs = deps.probeMs ?? 1500;

  const safeEmit = (a: Activity) => {
    try {
      onChange(a);
    } catch {
      /* a UI bug must not break sensing */
    }
  };
  const unsupported = (label: Activity): ActivityHandle => {
    safeEmit(label);
    return { stop: () => undefined, supported: false };
  };

  if (!target || !DME) return Promise.resolve(unsupported("desk"));

  // iOS 13+: must be called synchronously inside the user gesture
  let permission: Promise<string> | null = null;
  if (typeof DME.requestPermission === "function") {
    try {
      permission = Promise.resolve(DME.requestPermission()).catch(() => "denied");
    } catch {
      permission = Promise.resolve("denied");
    }
  }

  return (async (): Promise<ActivityHandle> => {
    if (permission) {
      const result = await permission;
      if (result !== "granted") return unsupported("unknown");
    }

    let stopped = false;
    let sawData = false;
    let samples: number[] = [];
    let windowStart = 0;
    let lastT = 0;
    const history: Activity[] = [];
    let stable: Activity = "unknown";
    let emitted: Activity | null = null;
    let probeTimer: unknown = null;
    let resolveReady!: (h: ActivityHandle) => void;
    const ready = new Promise<ActivityHandle>((r) => (resolveReady = r));

    const handler = (e: MotionEventLike) => {
      if (stopped) return;
      const m = accelMagnitude(e.accelerationIncludingGravity);
      if (m === null) return;
      const t = typeof e.timeStamp === "number" && Number.isFinite(e.timeStamp) ? e.timeStamp : now();
      if (!sawData) {
        sawData = true;
        windowStart = t;
        if (probeTimer !== null) clearT(probeTimer);
        resolveReady({ stop, supported: true });
      }
      samples.push(m);
      lastT = t;
      if (t - windowStart >= windowMs) {
        const durationSec = (lastT - windowStart) / 1000;
        const res = classifyMotionWindow(samples, durationSec);
        history.push(res.label);
        if (history.length > 3) history.shift();
        stable = majorityVote(history, stable);
        if (stable !== emitted) {
          emitted = stable;
          safeEmit(stable);
        }
        samples = [];
        windowStart = t;
      }
    };

    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (probeTimer !== null) clearT(probeTimer);
      probeTimer = null;
      target.removeEventListener("devicemotion", handler as (e: never) => void);
      samples = [];
    };

    target.addEventListener("devicemotion", handler as (e: never) => void);
    // no real reading soon (desktop Chrome fires one all-null event, others none): this is a desk
    probeTimer = setT(() => {
      probeTimer = null;
      if (sawData || stopped) return;
      stop();
      safeEmit("desk");
      resolveReady({ stop: () => undefined, supported: false });
    }, probeMs);
    return ready;
  })();
}
