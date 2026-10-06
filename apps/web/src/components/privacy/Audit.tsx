import { memo, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, Link2, ScrollText, ShieldAlert, ShieldCheck } from "lucide-react";
import { formatClockSeconds, formatDayTime } from "@/lib/format";
import { api } from "@/net/api";
import type { AuditResponse, AuditRow, AuditVerify } from "@/net/api-types";

const EVENT_TONE: Record<string, string> = {
  paused: "var(--danger)",
  purged: "var(--danger)",
  deleted: "var(--danger)",
  expired: "var(--warn)",
  resumed: "var(--ok)",
  exported: "var(--cyan)",
  sent_to_llm: "var(--violet)",
};

const eventLabel = (e: string): string => e.replace(/_/g, " ");

const AuditLine = memo(function AuditLine({ r, verified, broken }: { r: AuditRow; verified: boolean; broken: boolean }) {
  return (
    <li className={`au-row${verified ? " au-row--ok" : ""}${broken ? " au-row--bad" : ""}`}>
      <span className="au-row__seq mono tnum">#{r.seq}</span>
      <span className="au-row__dot" style={{ background: EVENT_TONE[r.event] ?? "var(--faint)" }} aria-hidden />
      <span className="au-row__event">{eventLabel(r.event)}</span>
      <span className="au-row__ref mono">{r.ref ?? ""}</span>
      {r.count !== null ? <span className="chip chip-mono tnum">×{r.count}</span> : <span />}
      <span className="au-row__time tnum" title={formatDayTime(r.ts)}>
        {formatClockSeconds(r.ts)}
      </span>
      <span className="au-row__hash mono" title={`hash ${r.hash}\nprev ${r.prevHash}`}>
        <Link2 size={11} aria-hidden /> {r.hash.slice(0, 10)}
      </span>
      <span className="au-row__check" aria-hidden>
        {broken ? <ShieldAlert size={14} /> : verified ? <CheckCircle2 size={14} /> : null}
      </span>
    </li>
  );
});

/**
 * The hash-chained audit trail (PRV-8): lifecycle events only, never content. "Verify chain" recomputes the
 * SHA-256 chain on the server and animates each row turning green as the check walks the chain.
 */
export function Audit({ data, onReload }: { data: AuditResponse | null; onReload: () => void }) {
  const rows = data?.rows ?? [];
  const [verify, setVerify] = useState<AuditVerify | null>(null);
  const [progress, setProgress] = useState(-1);
  const [running, setRunning] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => void (timer.current && clearInterval(timer.current)), []);

  const shown = rows.slice(0, 14); // newest first

  const run = async (): Promise<void> => {
    if (running) return;
    setRunning(true);
    setVerify(null);
    setProgress(-1);
    onReload();
    let result: AuditVerify;
    try {
      result = await api.verifyAudit();
    } catch (err) {
      setRunning(false);
      setVerify({ ok: false, count: 0 });
      void err;
      return;
    }
    // walk the chain oldest → newest so the green wave follows the hashes
    const order = [...shown].reverse();
    let i = 0;
    const total = order.length;
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => {
      i++;
      setProgress(i);
      if (i >= total) {
        if (timer.current) clearInterval(timer.current);
        timer.current = null;
        setVerify(result);
        setRunning(false);
      }
    }, Math.max(40, Math.min(120, 1400 / Math.max(total, 1))));
    if (total === 0) {
      setVerify(result);
      setRunning(false);
    }
  };

  const brokenSeq = verify && !verify.ok ? verify.brokenAt : undefined;
  const orderIndex = (r: AuditRow): number => shown.length - 1 - shown.indexOf(r) + 1; // 1 = oldest shown

  return (
    <section className="glass panel" aria-labelledby="pv-audit-h">
      <div className="section__title" id="pv-audit-h" style={{ marginTop: 0 }}>
        <ScrollText size={15} /> Tamper-evident audit trail
        <button type="button" className="btn btn-sm btn-primary" style={{ marginLeft: "auto" }} onClick={() => void run()} disabled={running || !data}>
          <ShieldCheck size={13} /> {running ? "Verifying…" : "Verify chain"}
        </button>
      </div>
      <p className="au-intro">
        Every data lifecycle event is logged <b>without content</b> and chained: each row&rsquo;s hash covers the one before it, so editing or deleting any past row breaks every later hash.
      </p>

      <AnimatePresence initial={false}>
        {verify ? (
          <motion.div
            key="result"
            className={`au-result ${verify.ok ? "au-result--ok" : "au-result--bad"}`}
            initial={{ opacity: 0, scale: 0.96, height: 0 }}
            animate={{ opacity: 1, scale: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            role="status"
          >
            {verify.ok ? (
              <>
                <motion.span initial={{ scale: 0, rotate: -40 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: "spring", stiffness: 380, damping: 14, delay: 0.1 }} className="au-result__icon">
                  <CheckCircle2 size={26} />
                </motion.span>
                <div>
                  <b>Chain intact.</b> All <span className="tnum">{verify.count}</span> events re-hashed and every link matches. Nothing has been altered or removed.
                </div>
              </>
            ) : (
              <>
                <span className="au-result__icon">
                  <ShieldAlert size={26} />
                </span>
                <div>
                  <b>Chain broken</b>
                  {verify.brokenAt !== undefined ? <> at event #{verify.brokenAt}</> : null}. Something was edited or deleted after it was written.
                </div>
              </>
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>

      {shown.length === 0 ? (
        <div className="empty">
          <ScrollText size={22} />
          No events yet.
        </div>
      ) : (
        <ul className="au-list" aria-label="Latest audit events, newest first">
          {shown.map((r) => (
            <AuditLine key={r.seq} r={r} verified={progress >= orderIndex(r) || Boolean(verify?.ok)} broken={brokenSeq !== undefined && r.seq >= brokenSeq && Boolean(verify)} />
          ))}
        </ul>
      )}
      {rows.length > shown.length ? <p className="ab__hint tnum" style={{ marginTop: "0.5rem" }}>Showing the latest {shown.length} of {rows.length} loaded events; verification covers the whole chain ({data?.verify.count ?? rows.length}).</p> : null}
    </section>
  );
}
