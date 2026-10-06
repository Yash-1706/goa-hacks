import { memo, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { BookLock, CircleHelp, Hourglass, Pin, RefreshCw, Search, Trash2, User } from "lucide-react";
import type { LedgerItem } from "@synapse/shared";
import { useNow } from "@/hooks/useNow";
import { categoryMeta } from "@/lib/category";
import { formatCountdown, formatDayTime, lifeLeft, plural } from "@/lib/format";
import { api } from "@/net/api";
import type { LedgerResponse } from "@/net/api-types";
import { toast } from "@/state/notices";

type Kind = "all" | LedgerItem["kind"];

const KIND_LABEL: Record<Kind, string> = { all: "Everything", thought: "Thoughts", entity: "Entities", artifact: "Artifacts", open_loop: "Open loops" };
const KIND_SINGULAR: Record<LedgerItem["kind"], string> = { thought: "Thought", entity: "Entity", artifact: "Artifact", open_loop: "Open loop" };

const Row = memo(function Row({ item, now, onDelete, deleting }: { item: LedgerItem; now: number; onDelete: (id: string) => void; deleting: boolean }) {
  const cat = item.category ? categoryMeta(item.category) : null;
  const left = item.expiresAt === null ? null : item.expiresAt - now;
  const frac = lifeLeft(item.expiresAt, item.createdAt, now);
  const urgent = left !== null && left < 3600_000;
  const KindIcon = item.kind === "entity" ? User : item.kind === "open_loop" ? CircleHelp : cat?.icon ?? BookLock;
  return (
    <motion.li
      layout="position"
      className="lg-row"
      style={{ ["--cat" as string]: cat?.color ?? "var(--faint)" }}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -24, transition: { duration: 0.2 } }}
    >
      <span className="lg-row__icon" aria-hidden>
        <KindIcon size={15} />
      </span>
      <div className="lg-row__main">
        <div className="lg-row__title">
          <span className="mono lg-row__code">{item.code}</span>
          <span className="lg-row__text">{item.title || "(untitled)"}</span>
        </div>
        <div className="lg-row__meta">
          <span className="lg-row__cat">{cat ? cat.label : KIND_SINGULAR[item.kind]}</span>
          <span className="tnum">{formatDayTime(item.createdAt, now)}</span>
          {item.whyKept.slice(0, 3).map((w) => (
            <span key={w} className="chip" title="Why Synapse keeps this">
              <span>{w}</span>
            </span>
          ))}
        </div>
      </div>
      <div className="lg-row__life">
        {left === null ? (
          <span className="chip chip-tint chip-ok" title="Kept in long-term memory until you delete it">
            <Pin size={11} /> <span>kept</span>
          </span>
        ) : (
          <>
            <span className={`lg-row__count tnum${urgent ? " lg-row__count--urgent" : ""}`} title="Working memory: forgotten automatically at this time">
              <Hourglass size={11} aria-hidden /> {formatCountdown(left)}
            </span>
            <span className="bar lg-row__bar" aria-hidden>
              <i style={{ width: `${Math.round(frac * 100)}%`, background: urgent ? "var(--danger)" : undefined }} />
            </span>
          </>
        )}
      </div>
      <div className="lg-row__act">
        {item.kind === "thought" ? (
          <button type="button" className="icon-btn" disabled={deleting} aria-label={`Delete ${item.code}`} title="Delete this thought and everything derived from it" onClick={() => onDelete(item.id)}>
            <Trash2 size={15} />
          </button>
        ) : null}
      </div>
    </motion.li>
  );
});

/**
 * The memory ledger (PRV-7): EVERYTHING Synapse stores, why it is kept, how long it will live, and a delete
 * button. Countdowns tick live.
 */
export function Ledger({ ledger, loading, onChanged, onRemoved }: { ledger: LedgerResponse | null; loading: boolean; onChanged: () => void; onRemoved: (id: string) => void }) {
  const now = useNow(1000);
  const [kind, setKind] = useState<Kind>("all");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(24);
  const [deleting, setDeleting] = useState<string | null>(null);

  const items = ledger?.items ?? [];
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items.length };
    for (const it of items) c[it.kind] = (c[it.kind] ?? 0) + 1;
    return c;
  }, [items]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((it) => (kind === "all" || it.kind === kind) && (!needle || `${it.code} ${it.title} ${it.whyKept.join(" ")} ${it.category ?? ""}`.toLowerCase().includes(needle)));
  }, [items, kind, q]);

  const del = async (id: string): Promise<void> => {
    setDeleting(id);
    try {
      const { count } = await api.purge({ ids: [id] });
      if (count) onRemoved(id);
      toast[count ? "success" : "info"](count ? "Deleted, with everything derived from it." : "Already gone.");
      onChanged();
    } catch (err) {
      toast.warn(`Delete failed: ${(err as Error).message}`);
    } finally {
      setDeleting(null);
    }
  };

  const kinds: Kind[] = ["all", "thought", "entity", "open_loop"];
  return (
    <section className="glass panel" aria-labelledby="pv-ledger-h">
      <div className="section__title" id="pv-ledger-h" style={{ marginTop: 0 }}>
        <BookLock size={15} /> Memory ledger
        <span className="tnum" style={{ marginLeft: "auto", textTransform: "none", letterSpacing: 0, fontWeight: 500, color: "var(--faint)" }}>
          {ledger ? `${plural(ledger.stats.thoughts, "thought")} · ${ledger.stats.promoted} kept · ${plural(ledger.stats.entities, "entity", "entities")}` : ""}
        </span>
        <button type="button" className="icon-btn" aria-label="Refresh ledger" title="Refresh" onClick={onChanged} disabled={loading}>
          <RefreshCw size={14} className={loading ? "spin" : undefined} />
        </button>
      </div>

      <div className="lg-tools">
        <div className="seg lg-seg" role="tablist" aria-label="Filter ledger">
          {kinds.map((k) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} className="seg__btn" onClick={() => { setKind(k); setLimit(24); }}>
              {KIND_LABEL[k]} <span className="tnum lg-count">{counts[k] ?? 0}</span>
            </button>
          ))}
        </div>
        <label className="lg-search">
          <Search size={14} aria-hidden />
          <input className="input" type="search" placeholder="Search the ledger" value={q} onChange={(e) => { setQ(e.target.value); setLimit(24); }} aria-label="Search the ledger" />
        </label>
      </div>

      {!ledger && loading ? (
        <div className="lg-skel" aria-busy>
          {[0, 1, 2].map((i) => (
            <div key={i} className="shimmer" style={{ height: "3.4rem", borderRadius: 14 }} />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <div className="empty">
          <BookLock size={22} />
          {items.length === 0 ? "Nothing is stored. Memory is empty." : "Nothing matches that filter."}
        </div>
      ) : (
        <>
          <ul className="lg-list" aria-label="Stored items">
            <AnimatePresence initial={false}>
              {shown.slice(0, limit).map((it) => (
                <Row key={`${it.kind}:${it.id}`} item={it} now={now} onDelete={(id) => void del(id)} deleting={deleting === it.id} />
              ))}
            </AnimatePresence>
          </ul>
          {shown.length > limit ? (
            <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: "0.6rem" }} onClick={() => setLimit((n) => n + 30)}>
              Show {Math.min(30, shown.length - limit)} more ({shown.length - limit} hidden)
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
