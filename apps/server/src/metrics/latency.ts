import { percentile, type LatencySummary, type StageStats } from "@synapse/shared";
import type { Clock } from "../clock";
import type { Db } from "../memory/db";

/* ============================================================================
 * Latency instrumentation (TRD §15). Raw timestamps → named stages.
 *   wispr          commit sent → Wispr final text (client clock)
 *   toServer       Wispr final → server receipt (needs the clock offset)
 *   triage         server receipt → first card on the wire (embed + triage)
 *   firstPaint     Wispr final → first card rendered on the device (end to end)
 *   llmFirstField  start of the model call → first parsed field (streaming)
 *   cortex         whole model call
 *   artifact       Wispr final → complete artifact rendered on the device (end to end)
 *   speechToArtifact  end of speech → complete artifact rendered (includes Wispr)
 *   pause          end of "pause memory" → microphone released
 * ========================================================================== */

export interface LatencyRow {
  fragmentId: string;
  deviceId: string;
  transport: string;
  createdAt: number;
  speechEnd?: number;
  commitSent?: number;
  wisprFinal?: number;
  serverRecv?: number;
  firstPaintEmit?: number;
  llmStart?: number;
  llmDone?: number;
  llmFirstFieldMs?: number;
  artifactEmit?: number;
  clientFirstPaint?: number;
  clientArtifactRender?: number;
  /** server − client clock offset (ms) at the time of receipt */
  offset?: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  source?: string;
}

export const STAGES = ["wispr", "toServer", "triage", "firstPaint", "llmFirstField", "cortex", "artifact", "speechToArtifact", "pause"] as const;
export type Stage = (typeof STAGES)[number];

export function stagesOf(r: LatencyRow): Partial<Record<Stage, number>> {
  const out: Partial<Record<Stage, number>> = {};
  const off = r.offset;
  if (r.commitSent !== undefined && r.wisprFinal !== undefined) out.wispr = r.wisprFinal - r.commitSent;
  if (off !== undefined && r.wisprFinal !== undefined && r.serverRecv !== undefined) out.toServer = Math.max(0, r.serverRecv - (r.wisprFinal + off));
  if (r.serverRecv !== undefined && r.firstPaintEmit !== undefined) out.triage = r.firstPaintEmit - r.serverRecv;
  if (r.llmFirstFieldMs !== undefined) out.llmFirstField = r.llmFirstFieldMs;
  if (r.llmStart !== undefined && r.llmDone !== undefined) out.cortex = r.llmDone - r.llmStart;
  if (off !== undefined && r.wisprFinal !== undefined) {
    const base = r.wisprFinal + off;
    if (r.clientFirstPaint !== undefined) out.firstPaint = r.clientFirstPaint + off - base;
    else if (r.firstPaintEmit !== undefined) out.firstPaint = r.firstPaintEmit - base; // server emit time (render adds a few ms)
    if (r.clientArtifactRender !== undefined) out.artifact = r.clientArtifactRender + off - base;
    else if (r.artifactEmit !== undefined) out.artifact = r.artifactEmit - base;
  } else if (r.serverRecv !== undefined) {
    // no clock offset yet: measure from server receipt (excludes the network hop)
    if (r.firstPaintEmit !== undefined) out.firstPaint = r.firstPaintEmit - r.serverRecv;
    if (r.artifactEmit !== undefined) out.artifact = r.artifactEmit - r.serverRecv;
  }
  if (off !== undefined && r.speechEnd !== undefined) {
    const end = r.clientArtifactRender !== undefined ? r.clientArtifactRender + off : r.artifactEmit;
    if (end !== undefined) out.speechToArtifact = end - (r.speechEnd + off);
  }
  return out;
}

const WINDOW = 400;

export class Metrics {
  private rows = new Map<string, LatencyRow>();
  private order: string[] = [];
  private pauseSamples: number[] = [];
  private dirty = new Set<string>();
  private lastEmit = 0;
  onSummary?: (s: LatencySummary) => void;

  constructor(
    private db: Db,
    private clock: Clock,
  ) {}

  /** Create or patch the row for a fragment (server-side facts). */
  server(fragmentId: string, deviceId: string, patch: Partial<LatencyRow>): LatencyRow {
    let r = this.rows.get(fragmentId);
    if (!r) {
      r = { fragmentId, deviceId, transport: patch.transport ?? "unknown", createdAt: this.clock.now() };
      this.rows.set(fragmentId, r);
      this.order.push(fragmentId);
      if (this.order.length > WINDOW) this.rows.delete(this.order.shift() as string);
    }
    Object.assign(r, patch);
    this.dirty.add(fragmentId);
    this.maybeEmit();
    return r;
  }

  /** Client-reported render times (client clock). */
  client(fragmentId: string, patch: { firstPaint?: number; artifactRender?: number }): void {
    const r = this.rows.get(fragmentId);
    if (!r) return;
    if (patch.firstPaint !== undefined && r.clientFirstPaint === undefined) r.clientFirstPaint = patch.firstPaint;
    if (patch.artifactRender !== undefined) r.clientArtifactRender = patch.artifactRender;
    this.dirty.add(fragmentId);
    this.maybeEmit();
  }

  recordPause(ms: number): void {
    this.pauseSamples.push(ms);
    if (this.pauseSamples.length > 100) this.pauseSamples.shift();
    this.maybeEmit(true);
  }

  rowsSnapshot(): LatencyRow[] {
    return this.order.map((id) => this.rows.get(id) as LatencyRow);
  }

  summary(): LatencySummary {
    const buckets: Record<string, number[]> = {};
    for (const r of this.rows.values()) {
      for (const [k, v] of Object.entries(stagesOf(r))) {
        if (v === undefined || !Number.isFinite(v) || v < 0 || v > 120_000) continue;
        (buckets[k] ??= []).push(v);
      }
    }
    if (this.pauseSamples.length) buckets.pause = [...this.pauseSamples];
    const stages: Record<string, StageStats> = {};
    for (const [k, vals] of Object.entries(buckets)) {
      stages[k] = {
        n: vals.length,
        p50: Math.round(percentile(vals, 50)),
        p95: Math.round(percentile(vals, 95)),
        max: Math.round(Math.max(...vals)),
      };
    }
    return { n: this.rows.size, stages, updatedAt: this.clock.now() };
  }

  /** Write dirty rows to SQLite (called on a timer and at shutdown). */
  flush(): void {
    if (this.dirty.size === 0) return;
    this.db.tx(() => {
      for (const id of this.dirty) {
        const r = this.rows.get(id);
        if (!r) continue;
        const st = stagesOf(r);
        this.db.run(
          `INSERT INTO latency(fragment_id, device_id, created_at, speech_end, commit_sent, wispr_final, server_recv, first_paint, llm_done,
             artifact_render, wispr_ms, first_paint_ms, artifact_ms, speech_to_artifact_ms, cortex_ms, model, cached_tokens, transport)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(fragment_id) DO UPDATE SET first_paint=excluded.first_paint, llm_done=excluded.llm_done,
             artifact_render=excluded.artifact_render, wispr_ms=excluded.wispr_ms, first_paint_ms=excluded.first_paint_ms,
             artifact_ms=excluded.artifact_ms, speech_to_artifact_ms=excluded.speech_to_artifact_ms, cortex_ms=excluded.cortex_ms,
             model=excluded.model, cached_tokens=excluded.cached_tokens`,
          r.fragmentId, r.deviceId, r.createdAt, r.speechEnd, r.commitSent, r.wisprFinal, r.serverRecv, r.clientFirstPaint ?? r.firstPaintEmit,
          r.llmDone, r.clientArtifactRender ?? r.artifactEmit, st.wispr, st.firstPaint, st.artifact, st.speechToArtifact, st.cortex,
          r.model, r.cachedTokens, r.transport,
        );
      }
    });
    this.dirty.clear();
  }

  private maybeEmit(force = false): void {
    const now = this.clock.now();
    if (!force && now - this.lastEmit < 1000) return;
    this.lastEmit = now;
    this.onSummary?.(this.summary());
  }
}

// ----------------------------------------------------------------- battery --

export interface BatterySample {
  deviceId: string;
  ts: number;
  mode: "normal" | "eco";
  cpuMs: number;
  radioMs: number;
  bytesUp: number;
  windowMs: number;
  level?: number;
  charging?: boolean;
}

/** Constants of the energy MODEL (relative units, labelled "model" in the UI; not measurements). */
export const ENERGY = { cpuMsCost: 1, radioMsCost: 6, byteCost: 0.004 };

export function modelledEnergy(s: Pick<BatterySample, "cpuMs" | "radioMs" | "bytesUp">): number {
  return s.cpuMs * ENERGY.cpuMsCost + s.radioMs * ENERGY.radioMsCost + s.bytesUp * ENERGY.byteCost;
}

/** What always-on streaming would cost over the same window: radio on 100%, 16 kHz × 16 bit as base64. */
export function naiveBaseline(windowMs: number): { cpuMs: number; radioMs: number; bytesUp: number; energy: number } {
  const bytesUp = Math.round((windowMs / 1000) * 32_000 * (4 / 3));
  const b = { cpuMs: windowMs * 0.05, radioMs: windowMs, bytesUp };
  return { ...b, energy: modelledEnergy(b) };
}

export class BatteryLog {
  private samples: BatterySample[] = [];
  constructor(private db: Db) {}

  add(s: BatterySample): void {
    this.samples.push(s);
    if (this.samples.length > 500) this.samples.shift();
    this.db.run(
      "INSERT INTO battery(device_id, ts, mode, cpu_ms, radio_ms, bytes_up, window_ms, level, charging) VALUES(?,?,?,?,?,?,?,?,?)",
      s.deviceId, s.ts, s.mode, s.cpuMs, s.radioMs, s.bytesUp, s.windowMs, s.level ?? null, s.charging ?? null,
    );
  }

  /** Aggregate per device and mode, compared with naive always-on streaming. */
  report(): Array<{
    deviceId: string;
    mode: string;
    windowMs: number;
    cpuMs: number;
    radioMs: number;
    bytesUp: number;
    energy: number;
    naiveEnergy: number;
    savedPct: number;
    radioActivePct: number;
    lastLevel?: number;
  }> {
    const groups = new Map<string, BatterySample[]>();
    for (const s of this.samples) {
      const k = `${s.deviceId}|${s.mode}`;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(s);
    }
    return [...groups.entries()].map(([k, arr]) => {
      const [deviceId, mode] = k.split("|") as [string, string];
      const sum = (f: (s: BatterySample) => number) => arr.reduce((a, s) => a + f(s), 0);
      const windowMs = sum((s) => s.windowMs);
      const cpuMs = sum((s) => s.cpuMs);
      const radioMs = sum((s) => s.radioMs);
      const bytesUp = sum((s) => s.bytesUp);
      const energy = modelledEnergy({ cpuMs, radioMs, bytesUp });
      const naive = naiveBaseline(windowMs);
      return {
        deviceId, mode, windowMs, cpuMs, radioMs, bytesUp,
        energy: Math.round(energy), naiveEnergy: Math.round(naive.energy),
        savedPct: naive.energy > 0 ? Math.round((1 - energy / naive.energy) * 100) : 0,
        radioActivePct: windowMs > 0 ? Math.round((radioMs / windowMs) * 1000) / 10 : 0,
        lastLevel: [...arr].reverse().find((s) => s.level !== undefined)?.level,
      };
    });
  }
}
