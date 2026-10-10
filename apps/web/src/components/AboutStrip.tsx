import { useSettings } from "@/state/settings";
import { speechLabel } from "@/lib/speech-engine";

/** One line on the Desk: what Synapse does and which speech engine is in use right now. */
export function AboutStrip() {
  const cfg = useSettings((s) => s.config);
  const speech = speechLabel(cfg?.wisprMode, cfg?.sttProvider);
  return (
    <p className="about-strip" role="note">
      Synapse turns what you say into cards. Speech: <b>{speech.long}</b>. Audio goes {speech.audio}. Memory is forgotten by default.
    </p>
  );
}
