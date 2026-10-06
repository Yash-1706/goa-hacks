import { useCallback, useEffect, useState } from "react";
import { pickLocalVoice } from "@/lib/recall";

/* ============================================================================
 * Text-to-speech for recall answers. ONLY voices with localService === true are used (cloud-backed browser
 * voices would ship the answer text to a third party). No local voice → answers stay text-only.
 * ========================================================================== */

export interface Tts {
  supported: boolean;
  /** why it is unavailable (shown next to the toggle) */
  reason: string | null;
  voiceName: string | null;
  speak: (text: string) => void;
  cancel: () => void;
}

const hasSynth = (): boolean => typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";

export function localVoice(): SpeechSynthesisVoice | null {
  if (!hasSynth()) return null;
  return pickLocalVoice(window.speechSynthesis.getVoices(), (navigator.language || "en").slice(0, 2));
}

export function speakText(text: string): boolean {
  const voice = localVoice();
  if (!voice || !text.trim()) return false;
  const synth = window.speechSynthesis;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.voice = voice;
  u.lang = voice.lang;
  u.rate = 1.02;
  synth.speak(u);
  return true;
}

export function cancelSpeech(): void {
  if (hasSynth()) window.speechSynthesis.cancel();
}

export function useTts(): Tts {
  const [voice, setVoice] = useState<SpeechSynthesisVoice | null>(() => localVoice());
  useEffect(() => {
    if (!hasSynth()) return;
    const sync = (): void => setVoice(localVoice());
    sync();
    window.speechSynthesis.addEventListener("voiceschanged", sync);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", sync);
  }, []);
  const speak = useCallback((text: string) => void speakText(text), []);
  const supported = hasSynth() && voice !== null;
  return {
    supported,
    reason: !hasSynth() ? "This browser has no speech synthesis." : voice ? null : "No on-device voice is installed, so answers stay text-only.",
    voiceName: voice?.name ?? null,
    speak,
    cancel: cancelSpeech,
  };
}
