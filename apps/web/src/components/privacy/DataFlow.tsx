import { memo, useMemo } from "react";
import { Ban, Brain, Cloud, Cpu, Mic, Server, ShieldCheck, Waves } from "lucide-react";
import { llmLabel, type LlmLabel } from "@/lib/llm-provider";
import { isOnDevice } from "@/lib/speech-engine";
import { useSettings } from "@/state/settings";
import { useThoughts } from "@/state/thoughts";

interface Node {
  icon: React.ReactNode;
  name: string;
  where: string;
  note: string;
  tone: "local" | "wispr" | "server" | "cloud";
}

/** the last stop is whichever provider the server is configured with (Claude unless it says otherwise); the speech stop is Wispr, or this machine when the on-device engine is in use */
const nodesFor = (llm: LlmLabel, onDevice: boolean): Node[] => [
  { icon: <Mic size={20} />, name: "Microphone", where: "this device", note: "The OS mic indicator is the truth.", tone: "local" },
  { icon: <Waves size={20} />, name: "Voice detector", where: "this device", note: "Silence is dropped here. It never leaves.", tone: "local" },
  onDevice
    ? { icon: <Cpu size={20} />, name: "On-device Whisper", where: "your laptop", note: "Receives audio only while you speak, in memory for one utterance, then zeroes it.", tone: "server" }
    : { icon: <Cloud size={20} />, name: "Wispr Flow", where: "transcription", note: "Receives audio only while you speak, directly from your browser.", tone: "wispr" },
  { icon: <Server size={20} />, name: "Your Synapse", where: "your laptop", note: onDevice ? "Text only, encrypted at rest. Audio is zeroed after each transcript." : "Text only, encrypted at rest. Audio never arrives.", tone: "server" },
  { icon: <Brain size={20} />, name: llm.provider, where: llm.model ? `reasoning · ${llm.model}` : "reasoning", note: "Sees redacted text. Emails, numbers and keys are masked first.", tone: "cloud" },
];

function Link({ kind, label }: { kind: "audio" | "text" | "redacted"; label: string }) {
  return (
    <div className={`pv-link pv-link--${kind}`} aria-hidden>
      <span className="pv-link__line" />
      <span className="pv-link__label">{label}</span>
    </div>
  );
}

/** "What leaves this device": audio goes only to Wispr, text goes to the cloud model (Claude or Groq) after redaction, nothing else. */
export const DataFlow = memo(function DataFlow() {
  const cfg = useSettings((s) => s.config);
  const llmName = llmLabel(cfg);
  const nodes = nodesFor(llmName, isOnDevice(cfg?.wisprMode, cfg?.sttProvider));
  const byId = useThoughts((s) => s.byId);
  const redactions = useMemo(() => Object.values(byId).reduce((n, t) => n + (t.redactions ?? 0), 0), [byId]);
  const thoughtsWithCloud = useMemo(() => Object.values(byId).filter((t) => t.source === "llm").length, [byId]);

  const wispr = cfg?.wisprMode ?? "mock";
  const llm = cfg?.llmMode ?? "mock";
  const localOnly = Boolean(cfg?.localOnly);

  return (
    <section className="pv-flow glass panel" aria-labelledby="pv-flow-h">
      <div className="section__title" id="pv-flow-h" style={{ marginTop: 0 }}>
        <ShieldCheck size={15} /> What leaves this device
      </div>

      <ol className="pv-pipe" aria-label="Data path">
        {nodes.map((n, i) => (
          <li key={n.name} className="pv-pipe__item">
            <div className={`pv-node pv-node--${n.tone}`}>
              <span className="pv-node__icon">{n.icon}</span>
              <div className="pv-node__name">{n.name}</div>
              <div className="pv-node__where">{n.where}</div>
              <div className="pv-node__note">{n.note}</div>
            </div>
            {i < nodes.length - 1 ? <Link kind={i < 2 ? "audio" : i === 2 ? "text" : "redacted"} label={i < 2 ? "audio" : i === 2 ? "text" : "redacted text"} /> : null}
          </li>
        ))}
      </ol>

      <div className="pv-flow__cols">
        <div className="pv-flow__col">
          <div className="eyebrow">Audio</div>
          {wispr === "local" && cfg?.sttProvider === "sarvam" ? (
            <p>
              <b>To Sarvam AI</b> (cloud speech-to-text), relayed by this laptop&apos;s server while the detector hears speech. Held in memory only and never written to a disk; each call is listed in the audit ledger (length only). Local-only mode switches to on-device Whisper.
            </p>
          ) : wispr === "local" ? (
            <p>
              <b>Stays on this machine.</b> From your browser to this laptop&apos;s own server, only while the detector hears speech, held in memory for one utterance, transcribed by Whisper on the CPU and zero-filled afterwards. It reaches no third party and is never written to a disk.
            </p>
          ) : (
            <p>
              <b>Only to Wispr Flow</b>, straight from your browser with a short-lived token, and only while the detector hears speech. It never reaches this server, never touches a disk, and is zero-filled in memory the moment the transcript returns.
            </p>
          )}
          <span className={`chip chip-tint ${wispr === "client" ? "chip-cyan" : wispr === "local" ? "chip-ok" : "chip-warn"}`}>
            <span>
              {wispr === "client"
                ? "live: streaming to Wispr while you speak"
                : wispr === "local" && cfg?.sttProvider === "sarvam"
                  ? "cloud: speech is transcribed by Sarvam AI"
                  : wispr === "local"
                  ? localOnly
                    ? "local-only: speech is transcribed on this machine, nothing is sent out"
                    : "on-device: speech is transcribed on this machine"
                  : wispr === "mock"
                    ? "mock mode: typed input, no audio leaves at all"
                    : "proxy mode"}
            </span>
          </span>
        </div>
        <div className="pv-flow__col">
          <div className="eyebrow">Text</div>
          <p>
            <b>To {llmName.provider}, after redaction.</b> Emails, phone numbers, cards, IDs, IBANs and key-like secrets are replaced with placeholders before the call and restored locally afterwards.
          </p>
          <div className="cchips">
            <span className={`chip chip-tint ${localOnly ? "chip-ok" : llm === "live" ? "chip-violet" : "chip-warn"}`}>
              <span>{localOnly ? "local-only: no cloud calls" : llm === "live" ? `cloud cortex live: ${llmName.full}` : "mock cortex: no cloud calls"}</span>
            </span>
            <span className="chip chip-tint chip-ok" title="Counted across the cards currently on screen">
              <ShieldCheck size={11} /> <span className="tnum">{redactions}</span> <span>value{redactions === 1 ? "" : "s"} masked{thoughtsWithCloud ? ` in ${thoughtsWithCloud} cloud call${thoughtsWithCloud === 1 ? "" : "s"}` : ""}</span>
            </span>
          </div>
        </div>
        <div className="pv-flow__col">
          <div className="eyebrow">Nothing else</div>
          <ul className="pv-no">
            {["No screenshots, page text or HTML to Wispr", "No analytics, no tracking, no third parties", "No emotion, health or relationship inference", "No speaker identification of other people", "Side remarks and talk to others are dropped, never stored"].map((t) => (
              <li key={t}>
                <Ban size={12} aria-hidden /> {t}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
});
