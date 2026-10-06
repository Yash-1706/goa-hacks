import type { AudioState } from "@/audio/types";

/* ============================================================================
 * Orb state derivation (TRD §13.3). One pure function maps every signal the UI has to the single
 * visual mode of the orb plus its two overlays and the caption that tells the user what a tap does.
 * ========================================================================== */

export type OrbMode = "off" | "starting" | "listening" | "hearing" | "paused" | "error" | "degraded";
export type ConnStatus = "connecting" | "open" | "auth" | "closed";

export interface OrbInput {
  audioState: AudioState;
  /** server-wide privacy pause */
  serverPaused: boolean;
  conn: ConnStatus;
  /** any thought has analyzing=true */
  analyzing: boolean;
  /** a suggestion arrived recently */
  suggesting: boolean;
  /** engine kind actually running */
  engine: "mic" | "text" | null;
  /** the server resumed (from anywhere) but this device has not restarted its mic yet */
  resumeHint: boolean;
  /** speech/typing activity beyond what audioState says */
  speaking: boolean;
  detail?: string;
  degraded?: string;
}

export interface OrbView {
  mode: OrbMode;
  analyzing: boolean;
  suggesting: boolean;
  /** what the orb IS doing */
  label: string;
  /** what a tap WILL do */
  action: "start" | "pause" | "resume" | "retry" | "none";
  actionLabel: string;
}

export function deriveOrb(i: OrbInput): OrbView {
  const analyzing = i.analyzing && i.audioState !== "paused" && !i.serverPaused;
  const suggesting = i.suggesting && !i.serverPaused;
  const typed = i.engine === "text";

  const done = (mode: OrbMode, label: string, action: OrbView["action"], actionLabel: string): OrbView => ({
    mode,
    analyzing,
    suggesting,
    label,
    action,
    actionLabel,
  });

  if (i.serverPaused || i.audioState === "paused") {
    return done("paused", "Paused. Tap to resume", "resume", "Resume listening");
  }
  if (i.audioState === "error") {
    return done("error", i.detail ? `Problem: ${i.detail}` : "Something went wrong. Tap to retry", "retry", "Try again");
  }
  if (i.conn === "closed" || i.conn === "connecting") {
    // keep the mic state visible, but flag that the brain is out of reach
    const base = i.audioState === "listening" || i.audioState === "hearing";
    return done("degraded", base ? "Listening, but offline. Fragments are queued" : "Reconnecting…", base ? "pause" : "start", base ? "Pause memory" : "Start listening");
  }
  if (i.audioState === "starting") return done("starting", "Starting…", "none", "Starting");
  if (i.audioState === "hearing" || (i.speaking && (i.audioState === "listening" || typed))) {
    return done("hearing", "Hearing you", "pause", "Pause memory");
  }
  if (i.audioState === "listening") {
    // the mic engine can be up while transcription is not (no Wispr key, token failure): say so
    if (i.detail && !typed) return done("degraded", `Listening: ${i.detail}`, "pause", "Pause memory");
    if (i.degraded) return done("degraded", i.degraded, "pause", "Pause memory");
    return done("listening", typed ? "Listening (typed input)" : "Listening", "pause", "Pause memory");
  }
  // off
  if (i.resumeHint) return done("off", "Tap to resume listening", "start", "Resume listening");
  return done("off", "Tap to start listening", "start", "Start listening");
}
