import { memo, useMemo } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { EyeOff, Link2, Waves } from "lucide-react";
import { categoryMeta } from "@/lib/category";
import { formatGap, plural } from "@/lib/format";
import { highlightCard } from "@/lib/dom";
import { MIN_VISIBLE_GAP_MS, buildStream, countFragments, type StreamGroup } from "@/lib/stream-group";
import { useStream } from "@/state/stream";
import { useThoughts } from "@/state/thoughts";

const spring = { type: "spring", stiffness: 420, damping: 36, mass: 0.8 } as const;
/** groups of thoughts created before this page loaded are drawn in place; only new ones animate in */
const BOOT = Date.now();

/** one stitched thought: its fragments joined by a bracket that grows as the stitcher snaps new ones on */
const GroupView = memo(function GroupView({ g }: { g: StreamGroup }) {
  const meta = categoryMeta(g.category);
  const stitched = g.fragments.length > 1;
  const color = g.thoughtId ? meta.color : "var(--cyan)";
  return (
    <motion.section
      layout
      className="sgroup"
      style={{ ["--cat" as string]: color }}
      data-analyzing={g.analyzing}
      data-fading={g.fading ? "true" : undefined}
      initial={g.startedAt > BOOT - 2000 ? { opacity: 0, y: -14, scale: 0.97 } : false}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.2 } }}
      transition={spring}
      aria-label={g.title ? `Thought: ${g.title}` : "Incoming thought"}
    >
      <div className="sgroup__head">
        {g.thoughtId ? (
          <button type="button" className="sgroup__code mono" onClick={() => g.thoughtId && highlightCard(g.thoughtId)} title="Jump to this thought's card">
            {g.code}
          </button>
        ) : (
          <span className="sgroup__code mono">…</span>
        )}
        <span className="sgroup__title">{g.title ? g.title : g.analyzing ? "hearing…" : "thought"}</span>
        {stitched ? (
          <span className="sgroup__stitch" title={`${g.fragments.length} fragments stitched into one thought`}>
            <Link2 size={11} /> ×{g.fragments.length}
          </span>
        ) : null}
        {g.analyzing ? <span className="sgroup__spin" aria-label="analysing" /> : null}
      </div>

      <div className="sgroup__body">
        {stitched ? <span key={g.fragments.length} className="sgroup__rail" aria-hidden /> : null}
        <AnimatePresence initial={false}>
          {g.fragments.map((f, i) => (
            <motion.div key={f.id} layout="position" layoutId={f.id} transition={spring} className="sline">
              {i > 0 && f.gapBeforeMs >= MIN_VISIBLE_GAP_MS ? (
                <div className="sgap tnum" aria-label={`pause of ${formatGap(f.gapBeforeMs)}`}>
                  <span aria-hidden>⋯</span> {formatGap(f.gapBeforeMs)}
                </div>
              ) : null}
              <motion.div
                className={`sfrag${f.whisper ? " sfrag--whisper" : ""}${f.pending ? " sfrag--pending" : ""}`}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={spring}
              >
                <motion.span
                  className="sfrag__dot"
                  aria-hidden
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", stiffness: 600, damping: 18, delay: 0.05 }}
                />
                <span className="sfrag__text">{f.text}</span>
                {f.whisper ? (
                  <span className="sfrag__tag" title="Whispered: smaller and softer on purpose">
                    whisper
                  </span>
                ) : null}
              </motion.div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </motion.section>
  );
});

export const FragmentStream = memo(function FragmentStream() {
  const order = useThoughts((s) => s.order);
  const byId = useThoughts((s) => s.byId);
  const fading = useThoughts((s) => s.fading);
  const pending = useStream((s) => s.pending);
  const ghosts = useStream((s) => s.ghosts);

  const groups = useMemo(
    () =>
      buildStream({
        thoughts: order.map((id) => byId[id]).filter((t): t is NonNullable<typeof t> => Boolean(t)),
        pending,
        fading,
      }),
    [order, byId, pending, fading],
  );
  const frags = countFragments(groups);
  const thoughts = groups.filter((g) => g.thoughtId).length;

  return (
    <div className="stream" role="log" aria-live="polite" aria-label="Live transcript">
      <LayoutGroup id="stream">
        <AnimatePresence initial={false}>
          {ghosts.map((g) => (
            <motion.div
              key={`ghost-${g.id}`}
              className="sghost"
              initial={{ opacity: 0.9, height: "auto", y: -6 }}
              animate={{ opacity: 0.55, y: 0 }}
              exit={{ opacity: 0, height: 0, scale: 0.9, filter: "blur(4px)", transition: { duration: 0.6 } }}
              transition={spring}
            >
              <EyeOff size={12} aria-hidden />
              <span className="sghost__text">{g.text}</span>
              <span className="sghost__tag">filtered</span>
            </motion.div>
          ))}
        </AnimatePresence>
        <AnimatePresence initial={false}>
          {groups.map((g) => (
            <GroupView key={g.key} g={g} />
          ))}
        </AnimatePresence>
      </LayoutGroup>

      {groups.length === 0 ? (
        <div className="stream__empty">
          <Waves size={22} aria-hidden />
          <p>Words appear here as you say them, grouped into the thought they belong to.</p>
        </div>
      ) : (
        <p className="stream__foot tnum">
          {plural(frags, "fragment")} · {plural(thoughts, "thought")}
        </p>
      )}
    </div>
  );
});
