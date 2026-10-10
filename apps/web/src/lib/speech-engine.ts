/**
 * What the UI calls the speech engine that is in effect right now (the server's `wisprMode`): Wispr Flow in the cloud, the on-device
 * Whisper engine on the server's machine (WISPR_MODE=local, or local-only mode), a relay, or none (typed input).
 */
export type SpeechMode = "client" | "proxy" | "mock" | "local";

export interface SpeechLabel {
  /** a few words, for chips */
  short: string;
  /** a name, for tooltips and the Lab */
  long: string;
  /** where the audio goes, as a clause that finishes "Audio goes …" */
  audio: string;
}

export function speechLabel(mode: string | undefined, provider?: string): SpeechLabel {
  if (mode === "local" && provider === "sarvam") return { short: "Sarvam", long: "Sarvam AI speech-to-text (cloud)", audio: "to this laptop's server, which sends it to Sarvam AI for transcription" };
  switch (mode) {
    case "client":
      return { short: "Wispr", long: "Wispr Flow (cloud)", audio: "from your browser straight to Wispr Flow" };
    case "proxy":
      return { short: "Wispr relay", long: "Wispr Flow via this server", audio: "to this server, which relays it to Wispr Flow" };
    case "local":
      return { short: "on-device", long: "on-device Whisper", audio: "to this machine only, in memory, and nowhere else" };
    default:
      return { short: "typed", long: "typed input (no speech engine)", audio: "nowhere: there is no microphone input" };
  }
}

/** true when the audio never leaves the machine that runs the server */
export const isOnDevice = (mode: string | undefined, provider?: string): boolean => mode === "local" && provider !== "sarvam";
