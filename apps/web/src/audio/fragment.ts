import { FragmentFinalSchema, type Activity, type FragmentFinal } from "@synapse/shared";

/**
 * fragmentId = `${deviceId}-${Date.now().toString(36)}-${seq}` (unique per device and per utterance).
 * The wire schema caps ids at 80 chars, so a very long deviceId is truncated from the left.
 */
export function makeFragmentId(deviceId: string, now: number, seq: number): string {
  const suffix = `-${Math.floor(now).toString(36)}-${seq.toString(36)}`;
  const room = 80 - suffix.length;
  const dev = deviceId.length > room ? deviceId.slice(deviceId.length - room) : deviceId;
  return `${dev}${suffix}`;
}

export interface FragmentInput {
  fragmentId: string;
  sessionId: string;
  text: string;
  detectedLanguage?: string;
  /** epoch ms of the first voiced frame */
  speechStart: number;
  /** epoch ms of the end of the last voiced frame */
  speechEnd: number;
  commitSent: number;
  wisprFinal: number;
  pauseBeforeMs: number;
  rmsMean: number;
  rmsMax: number;
  whisper: boolean;
  activity?: Activity;
  transport: FragmentFinal["transport"];
}

const clampNum = (n: number, lo: number, hi: number): number => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);
const round5 = (n: number): number => Math.round(n * 1e5) / 1e5;

/** Assemble the `fragment.final` payload (TRD §5.7 / FragmentFinalSchema), clamping every field into its schema range. */
export function buildFragmentFinal(i: FragmentInput): FragmentFinal {
  const speechStart = Math.round(i.speechStart);
  const speechEnd = Math.max(speechStart, Math.round(i.speechEnd));
  const lang = typeof i.detectedLanguage === "string" ? i.detectedLanguage.trim().slice(0, 16) : "";
  const out: FragmentFinal = {
    type: "fragment.final",
    fragmentId: i.fragmentId,
    sessionId: i.sessionId,
    text: i.text.trim().slice(0, 4000),
    t: {
      speechStart,
      speechEnd,
      commitSent: Math.round(i.commitSent),
      wisprFinal: Math.round(i.wisprFinal),
    },
    durationMs: clampNum(speechEnd - speechStart, 0, 600_000),
    pauseBeforeMs: clampNum(Math.round(i.pauseBeforeMs), 0, 86_400_000),
    rmsMean: round5(clampNum(i.rmsMean, 0, 1)),
    rmsMax: round5(clampNum(i.rmsMax, 0, 1)),
    whisper: i.whisper,
    transport: i.transport,
  };
  if (lang) out.detectedLanguage = lang;
  if (i.activity) out.activity = i.activity;
  return out;
}

/** true when the object satisfies the shared wire schema (what the server will validate) */
export function isValidFragment(f: FragmentFinal): boolean {
  return FragmentFinalSchema.safeParse(f).success;
}
