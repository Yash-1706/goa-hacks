import { memo, useId } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckCheck, ChevronDown, CircleSlash, PackageCheck, PenLine, Rocket, type LucideIcon } from "lucide-react";
import type { GroupDef, GroupId } from "@/lib/outbox-groups";
import type { OutboxItem } from "@/net/api-types";
import { GroupEmpty } from "./OutboxEmpty";
import { OutboxItemCard } from "./OutboxItemCard";

const GROUP_ICON: Record<GroupId, LucideIcon> = {
  draft: PenLine,
  staged: PackageCheck,
  accepted: CheckCheck,
  executed: Rocket,
  dismissed: CircleSlash,
};

/**
 * One status group: a header with the count, then its items. Items glide between groups when their status changes: every
 * card carries a layoutId inside the Outbox's LayoutGroup, so the card that leaves "Staged" and the one that arrives in
 * "Done" are the same element to Motion.
 */
export const OutboxGroup = memo(function OutboxGroup({
  def,
  items,
  moved,
  collapsed,
  onToggle,
}: {
  def: GroupDef;
  items: readonly OutboxItem[];
  /** ids that were drawn in another group a moment ago: they arrive by gliding, not by fading in */
  moved: ReadonlySet<string>;
  /** a quiet group folded behind its header (only offered in the "All" view) */
  collapsed: boolean;
  onToggle?: () => void;
}) {
  const Icon = GROUP_ICON[def.id];
  const listId = useId();
  return (
    <section className={`ob-group ob-group--${def.id}`} aria-labelledby={`${listId}-h`}>
      <header className="ob-group__head">
        <span className="ob-group__icon" aria-hidden>
          <Icon size={15} />
        </span>
        <h2 className="ob-group__title" id={`${listId}-h`}>
          {def.label}
        </h2>
        <span className="ob-group__count tnum" aria-label={`${items.length} ${items.length === 1 ? "item" : "items"}`}>
          {items.length}
        </span>
        <p className="ob-group__hint">{def.hint}</p>
        {onToggle && items.length > 0 ? (
          <button type="button" className="btn btn-ghost btn-sm ob-group__toggle" aria-expanded={!collapsed} aria-controls={listId} onClick={onToggle}>
            <ChevronDown size={13} aria-hidden style={{ transform: collapsed ? undefined : "rotate(180deg)", transition: "transform .2s" }} /> {collapsed ? "Show" : "Hide"}
          </button>
        ) : null}
      </header>

      {items.length === 0 ? (
        <GroupEmpty title={def.emptyTitle} body={def.emptyBody} />
      ) : collapsed ? null : (
        <div className="ob-list" id={listId}>
          <AnimatePresence initial={false} mode="popLayout">
            {items.map((it) => (
              <motion.div
                key={it.id}
                layout="position"
                layoutId={`ob-${it.id}`}
                className={moved.has(it.id) ? "ob-item is-moving" : "ob-item"}
                initial={moved.has(it.id) ? false : { opacity: 0, y: 14, scale: 0.985 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.16 } }}
                transition={{ type: "spring", stiffness: 380, damping: 34, mass: 0.9 }}
              >
                <OutboxItemCard item={it} />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </section>
  );
});
