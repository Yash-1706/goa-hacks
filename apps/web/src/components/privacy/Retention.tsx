import { memo } from "react";
import { Hourglass, KeyRound, Lock, Mic, Trash2 } from "lucide-react";
import { formatDayTime } from "@/lib/format";
import type { LedgerResponse } from "@/net/api-types";

/** How memory behaves: audio never stored, 72 h working memory, crypto-shredding (with the real key list). */
export const Retention = memo(function Retention({ ledger }: { ledger: LedgerResponse | null }) {
  const ttl = ledger?.retention.workingMemoryHours ?? 72;
  const keys = ledger?.keys ?? [];
  const dayKeys = keys.filter((k) => k.scope !== "ltm" && k.scope !== "long_term");
  const longTerm = keys.filter((k) => k.scope === "ltm" || k.scope === "long_term");
  const destroyed = dayKeys.filter((k) => k.destroyedAt).length;
  const kek = ledger?.kekSource ?? "…";

  return (
    <section className="glass panel" aria-labelledby="pv-ret-h">
      <div className="section__title" id="pv-ret-h" style={{ marginTop: 0 }}>
        <Hourglass size={15} /> How memory works
      </div>
      <div className="pv-ret">
        <div className="pv-ret__card">
          <span className="pv-ret__icon" style={{ color: "var(--cyan)" }}>
            <Mic size={18} />
          </span>
          <div className="pv-ret__big tnum">0 B</div>
          <div className="pv-ret__t">of audio stored. Ever.</div>
          <p>Audio lives in RAM for the length of one utterance and is then zero-filled. The server has no audio endpoint and nothing in the code can write it to disk.</p>
        </div>
        <div className="pv-ret__card">
          <span className="pv-ret__icon" style={{ color: "var(--warn)" }}>
            <Hourglass size={18} />
          </span>
          <div className="pv-ret__big tnum">{ttl} h</div>
          <div className="pv-ret__t">working memory</div>
          <p>Everything you say is locked with that day&rsquo;s key and forgotten after {ttl} hours unless it earns a place: you keep it, or it is actionable, repeated or anchored on something you care about.</p>
        </div>
        <div className="pv-ret__card">
          <span className="pv-ret__icon" style={{ color: "var(--ok)" }}>
            <Trash2 size={18} />
          </span>
          <div className="pv-ret__big tnum">{destroyed}</div>
          <div className="pv-ret__t">day key{destroyed === 1 ? "" : "s"} destroyed</div>
          <p>Crypto-shredding: when a day expires its key is destroyed, so any leftover bytes on disk can never be decrypted. Deleting a thought also deletes everything derived from it.</p>
        </div>
      </div>

      <div className="pv-keys">
        <div className="pv-keys__head">
          <KeyRound size={14} aria-hidden /> <b>Encryption keys</b>
          <span className="chip chip-mono" title="Where the master key that wraps every data key lives">
            master key: {kek}
          </span>
          <span className="chip chip-mono">AES-256-GCM per field</span>
          {kek === "keyfile" ? (
            <span className="chip chip-tint chip-warn" title="The master key is a file in the data folder. Set SYNAPSE_PASSPHRASE or use the OS keyring for stronger protection.">
              keyfile: weakest option
            </span>
          ) : null}
        </div>
        <ul className="pv-keys__list" aria-label="Data keys">
          {longTerm.map((k) => (
            <li key={k.id} className="pv-key pv-key--ltm" title="Long-term key: wraps everything you kept">
              <Lock size={12} aria-hidden /> <span className="mono">long-term</span>
              <span className="pv-key__s">active</span>
            </li>
          ))}
          {dayKeys.map((k) => (
            <li key={k.id} className={`pv-key${k.destroyedAt ? " pv-key--dead" : ""}`} title={k.destroyedAt ? `Destroyed ${formatDayTime(k.destroyedAt)}: its data is undecryptable` : `Created ${formatDayTime(k.createdAt)}`}>
              <KeyRound size={12} aria-hidden /> <span className="mono">{k.id.replace(/^day:/, "")}</span>
              <span className="pv-key__s">{k.destroyedAt ? "destroyed" : "active"}</span>
            </li>
          ))}
          {!keys.length ? <li className="ab__hint">No keys listed yet.</li> : null}
        </ul>
      </div>
    </section>
  );
});
