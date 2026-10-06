import { useEffect, useRef } from "react";
import { cancelSpeech, speakText } from "@/hooks/useTts";
import { stripCitations } from "@/lib/format";
import { useRecall } from "@/state/recall";
import { useSettings } from "@/state/settings";

/**
 * Reads finished recall answers aloud when the TTS switch is on, on whatever screen you are looking at (a
 * spoken question deserves a spoken answer). Invisible. Local voices only, see hooks/useTts.ts.
 */
export function RecallSpeaker() {
  const enabled = useSettings((s) => s.tts);
  const queries = useRecall((s) => s.queries);
  const spoken = useRef(new Set<string>());
  const primed = useRef(false);

  useEffect(() => {
    // answers that already existed when the switch / page came up are history, not news
    if (!primed.current) {
      primed.current = true;
      for (const q of Object.values(queries)) if (q.done) spoken.current.add(q.id);
      return;
    }
    for (const q of Object.values(queries)) {
      if (!q.done || spoken.current.has(q.id)) continue;
      spoken.current.add(q.id); // mark even when muted, so switching TTS on later does not replay old answers
      if (!enabled || q.error) continue;
      const text = stripCitations(q.answer);
      if (text) speakText(text);
    }
  }, [queries, enabled]);

  useEffect(() => {
    if (!enabled) cancelSpeech();
  }, [enabled]);

  return null;
}
