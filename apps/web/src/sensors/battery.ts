/* ============================================================================
 * Battery Status wrapper (Chromium only: Chrome / Edge / Samsung / Android).
 * Safari, iOS and Firefox have no navigator.getBattery(): watchBattery() then resolves {supported:false} and the UI
 * offers a manual "Saver" toggle instead. Never throws.
 * ========================================================================== */

export interface BatteryReading {
  /** 0..1 */
  level: number;
  charging: boolean;
}

export interface BatteryWatch {
  stop(): void;
  /** false where navigator.getBattery is missing (or blocked by a permissions policy) */
  supported: boolean;
}

interface BatteryManagerLike {
  level: number;
  charging: boolean;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

export interface BatteryDeps {
  navigator?: { getBattery?: () => Promise<BatteryManagerLike> } | null;
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1);

/**
 * Calls onChange with the current reading right away, then on every level / charging change.
 * Resolves {supported:false} (and never calls onChange) where the API is unavailable.
 */
export async function watchBattery(
  onChange: (b: BatteryReading) => void,
  deps: BatteryDeps = {},
): Promise<BatteryWatch> {
  const none: BatteryWatch = { stop: () => undefined, supported: false };
  try {
    const nav =
      deps.navigator === undefined
        ? ((globalThis as unknown as { navigator?: BatteryDeps["navigator"] }).navigator ?? null)
        : deps.navigator;
    if (!nav || typeof nav.getBattery !== "function") return none;
    const bm = await nav.getBattery();
    if (!bm) return none;
    let stopped = false;
    const emit = () => {
      if (stopped) return;
      try {
        onChange({ level: clamp01(bm.level), charging: Boolean(bm.charging) });
      } catch {
        /* a UI bug must not break the listener */
      }
    };
    const events = ["levelchange", "chargingchange"] as const;
    for (const ev of events) bm.addEventListener(ev, emit);
    emit();
    return {
      supported: true,
      stop: () => {
        if (stopped) return;
        stopped = true;
        for (const ev of events) bm.removeEventListener(ev, emit);
      },
    };
  } catch {
    return none;
  }
}

/** TRD §11.4 layer 5: below 30 % and not charging -> eco; leave eco when charging or back above 35 % (hysteresis). */
export function pickPowerMode(b: BatteryReading, previous: "normal" | "eco" = "normal"): "normal" | "eco" {
  if (b.charging) return "normal";
  if (b.level < 0.3) return "eco";
  if (previous === "eco" && b.level < 0.35) return "eco";
  return "normal";
}
