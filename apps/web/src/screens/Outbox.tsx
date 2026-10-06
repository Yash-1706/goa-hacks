import { useMemo, useState } from "react";
import { LayoutGroup, motion } from "motion/react";
import { Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { Segmented, type SegOption } from "@/components/lab/Segmented";
import { AutonomyBanner } from "@/components/outbox/AutonomyBanner";
import { OutboxEmpty } from "@/components/outbox/OutboxEmpty";
import { OutboxGroup } from "@/components/outbox/OutboxGroup";
import { useOutboxLoader } from "@/components/outbox/useOutboxData";
import { useRecentMoves } from "@/components/outbox/useRecentMoves";
import { GROUPS, countGroups, groupItems, headline, shownGroups, type OutboxFilter } from "@/lib/outbox-groups";
import { useOutbox } from "@/state/outbox";

/**
 * The Outbox: everything Synapse drafted, grouped by what happens to it next. Draft-first: nothing here has been sent to
 * anyone; the buttons on each card are the only way a draft turns into an issue, a ticket or a calendar hold.
 * Live: artifact.upsert patches the shared store, so a card changes (and glides to its new group) the moment the server does.
 */
export default function Outbox() {
  const reload = useOutboxLoader();
  const items = useOutbox((s) => s.items);
  const loaded = useOutbox((s) => s.loaded);
  const loading = useOutbox((s) => s.loading);
  const error = useOutbox((s) => s.error);
  const [filter, setFilter] = useState<OutboxFilter>("all");
  const [showQuiet, setShowQuiet] = useState(false);

  const counts = useMemo(() => countGroups(items), [items]);
  const grouped = useMemo(() => groupItems(items), [items]);

  // an item that changed group glides to its new place (a shared layout transition) instead of playing the entrance of a new one
  const moved = useRecentMoves(items);
  const head = headline(counts);
  const groups = shownGroups(filter);

  const options: Array<SegOption<OutboxFilter>> = [{ id: "all", label: "All", count: counts.all }, ...GROUPS.map((g) => ({ id: g.id as OutboxFilter, label: g.label, count: counts[g.id] }))];
  const firstLoad = !loaded && !error;

  return (
    <motion.div className="page ob" layoutScroll>
      <div className="page__inner">
        <header className="page__head ob__head">
          <div>
            <div className="eyebrow">Outbox · draft-first</div>
            <h1 className="page__title" aria-live="polite">
              {loaded ? head.title : "Outbox"}
            </h1>
            <p className="page__sub">{loaded ? head.sub : "Everything Synapse drafted from your thinking, in one place."}</p>
          </div>
          <button type="button" className="btn btn-sm" onClick={reload} aria-busy={loading} title="Fetch the outbox again">
            {loading ? <Loader2 size={13} className="lab-spin" aria-hidden /> : <RefreshCw size={13} aria-hidden />} Refresh
          </button>
        </header>

        <AutonomyBanner />

        {error ? (
          <div className="ob-error" role="alert">
            <TriangleAlert size={15} aria-hidden />
            <span>{loaded ? `Showing the last list we have. The refresh failed: ${error}` : `Could not load the outbox: ${error}`}</span>
            <button type="button" className="btn btn-sm" onClick={reload}>
              Try again
            </button>
          </div>
        ) : null}

        {firstLoad ? (
          <div className="ob-skel" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span key={i} className="shimmer" />
            ))}
          </div>
        ) : loaded && counts.all === 0 ? (
          <OutboxEmpty />
        ) : loaded ? (
          <>
            <div className="ob-filter">
              <Segmented label="Show items by status" options={options} value={filter} onChange={setFilter} className="lab-seg--scroll" />
            </div>
            <LayoutGroup id="outbox">
              <div className="ob-groups">
                {groups.map((g) => (
                  <OutboxGroup
                    key={g.id}
                    def={g}
                    items={grouped[g.id]}
                    moved={moved}
                    collapsed={g.quiet && filter === "all" && !showQuiet}
                    onToggle={g.quiet && filter === "all" ? () => setShowQuiet((v) => !v) : undefined}
                  />
                ))}
              </div>
            </LayoutGroup>
          </>
        ) : null}
      </div>
    </motion.div>
  );
}
