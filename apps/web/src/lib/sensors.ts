import { ACTIVITIES, type Activity } from "@synapse/shared";

/* ============================================================================
 * Optional sensors (src/sensors/*, written by the audio side). They are resolved lazily with
 * import.meta.glob exactly like the mic engine in audio/index.ts: if a file is missing or throws, the app
 * keeps working and the feature is simply absent.
 *
 * Contract used here (matches src/sensors):
 *   startActivityClassifier(onChange(activity)) → Promise<{ stop(), supported }>   (iOS asks for motion permission
 *       synchronously inside the call, so it must be invoked straight from a tap: preloadSensors() makes that possible)
 *   watchBattery(onChange({ level 0..1, charging })) → Promise<{ stop(), supported }>
 *   holdWakeLock() → { release(): Promise<void>, active }                          (re-acquires on visibilitychange)
 * The adapters also tolerate a bare stop function or small shape differences.
 * ========================================================================== */

export type Stop = () => void;

type Mod = Record<string, unknown>;
const activityMods = import.meta.glob<Mod>("../sensors/activity.ts");
const batteryMods = import.meta.glob<Mod>("../sensors/battery.ts");
const wakeMods = import.meta.glob<Mod>("../sensors/wakelock.ts");

let activityMod: Mod | null | undefined;
let batteryMod: Mod | null | undefined;
let wakeMod: Mod | null | undefined;

async function load(mods: Record<string, () => Promise<Mod>>): Promise<Mod | null> {
  const loader = Object.values(mods)[0];
  if (!loader) return null;
  try {
    return await loader();
  } catch (err) {
    console.warn("[sensors] module failed to load:", (err as Error).message);
    return null;
  }
}

/** Load the sensor modules ahead of time so a tap can call them synchronously (iOS permission prompts need that). */
export async function preloadSensors(): Promise<void> {
  [activityMod, batteryMod, wakeMod] = await Promise.all([load(activityMods), load(batteryMods), load(wakeMods)]);
}

/** Turn whatever a sensor start function returned into a single stop() we can call. */
export function toStop(ret: unknown): Stop | null {
  if (typeof ret === "function") return () => void (ret as () => unknown)();
  if (ret && typeof ret === "object") {
    for (const k of ["stop", "release", "dispose", "close", "unsubscribe", "cancel"]) {
      const f = (ret as Record<string, unknown>)[k];
      if (typeof f === "function") return () => void (f as () => unknown).call(ret);
    }
  }
  return null;
}

export function normalizeActivity(v: unknown): Activity | null {
  const raw = typeof v === "string" ? v : v && typeof v === "object" ? ((v as Record<string, unknown>).activity ?? (v as Record<string, unknown>).label ?? (v as Record<string, unknown>).state) : undefined;
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  if ((ACTIVITIES as readonly string[]).includes(s)) return s as Activity;
  if (s === "driving" || s === "car") return "vehicle";
  if (s === "stationary" || s === "idle") return "still";
  return null;
}

export function normalizeBattery(...args: unknown[]): { level: number; charging: boolean } | null {
  const a = args[0];
  let level: unknown;
  let charging: unknown;
  if (a && typeof a === "object") {
    const o = a as Record<string, unknown>;
    level = o.level ?? o.percent ?? o.battery;
    charging = o.charging ?? o.isCharging;
  } else {
    level = a;
    charging = args[1];
  }
  if (typeof level !== "number" || !Number.isFinite(level)) return null;
  const l = level > 1 ? level / 100 : level;
  return { level: Math.max(0, Math.min(1, l)), charging: Boolean(charging) };
}

/**
 * Start the motion-based activity classifier. When the module was preloaded the sensor function is called
 * SYNCHRONOUSLY (before the first await), which keeps the tap's user activation for iOS.
 * Resolves to a stop function, or null when the sensor module is missing / unsupported.
 */
export function startActivity(onChange: (a: Activity) => void): Promise<Stop | null> {
  const run = (mod: Mod | null | undefined): Promise<Stop | null> => {
    const fn = mod?.startActivityClassifier;
    if (typeof fn !== "function") return Promise.resolve(null);
    try {
      const ret = (fn as (cb: (v: unknown) => void) => unknown)((v) => {
        const a = normalizeActivity(v);
        if (a) onChange(a);
      });
      return Promise.resolve(ret).then(
        (r) => toStop(r) ?? (() => undefined),
        (err: unknown) => {
          console.warn("[sensors] activity classifier failed:", (err as Error)?.message);
          return null;
        },
      );
    } catch (err) {
      console.warn("[sensors] activity classifier failed:", (err as Error).message);
      return Promise.resolve(null);
    }
  };
  if (activityMod !== undefined) return run(activityMod);
  return load(activityMods).then((m) => {
    activityMod = m;
    return run(m);
  });
}

export async function startBattery(onChange: (b: { level: number; charging: boolean }) => void): Promise<Stop | null> {
  batteryMod ??= await load(batteryMods);
  const fn = batteryMod?.watchBattery;
  if (typeof fn !== "function") return null;
  try {
    const ret = await (fn as (cb: (...a: unknown[]) => void) => unknown)((...a) => {
      const b = normalizeBattery(...a);
      if (b) onChange(b);
    });
    return toStop(ret) ?? (() => undefined);
  } catch (err) {
    console.warn("[sensors] battery watcher failed:", (err as Error).message);
    return null;
  }
}

export interface WakeHandle {
  release: Stop;
  /** is the screen lock actually held right now (false while the tab is hidden or the browser refused) */
  active: () => boolean;
}

/** Hold the screen awake while listening; null when the module is missing. */
export async function acquireWakeLock(): Promise<WakeHandle | null> {
  wakeMod ??= await load(wakeMods);
  const fn = wakeMod?.holdWakeLock;
  if (typeof fn !== "function") return null;
  try {
    const ret = await (fn as () => unknown)();
    if (ret === null || ret === undefined || ret === false) return null;
    const rel = toStop(ret) ?? (() => undefined);
    return {
      release: rel,
      active: () => {
        const a = (ret as { active?: unknown }).active;
        return typeof a === "boolean" ? a : true;
      },
    };
  } catch (err) {
    console.warn("[sensors] wake lock failed:", (err as Error).message);
    return null;
  }
}
