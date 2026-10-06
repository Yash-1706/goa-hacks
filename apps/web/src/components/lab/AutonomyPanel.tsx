import { memo, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, Loader2, Lock, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { AUTONOMY_LEVELS, AUTONOMY_NEVER, autonomyDef, autonomyLabel, clampLevel } from "@/lib/lab-adapt";
import { api } from "@/net/api";
import type { SettingsResponse } from "@/net/api-types";
import { toast } from "@/state/notices";
import { useSettings } from "@/state/settings";
import { Panel } from "./Panel";
import { syncAutonomyConfig } from "./useAutonomy";
import { errorText, type Polled } from "./usePolled";

/* Autonomy ladder (PRD PRO-6). Optimistic: the card selects at once, POST /api/settings confirms, a failure rolls back
 * to the level the server really has and says so in a toast. */

export const AutonomyPanel = memo(function AutonomyPanel({ settings }: { settings: Polled<SettingsResponse> }) {
  const configLevel = useSettings((s) => s.config?.autonomyLevel);
  const serverLevel = clampLevel(settings.data?.autonomyLevel ?? configLevel ?? 2);
  const [optimistic, setOptimistic] = useState<number | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = optimistic ?? serverLevel;

  // once the server confirms the optimistic level, drop it and follow the server again
  useEffect(() => {
    if (optimistic !== null && pending === null && settings.data?.autonomyLevel === optimistic) setOptimistic(null);
  }, [optimistic, pending, settings.data?.autonomyLevel]);

  const choose = async (level: number): Promise<void> => {
    if (pending !== null || level === current) return;
    const before = optimistic;
    setOptimistic(level);
    setPending(level);
    try {
      const res = await api.setAutonomy(level);
      const applied = clampLevel(res.autonomyLevel);
      setOptimistic(applied);
      syncAutonomyConfig(applied);
      settings.refresh();
      toast.success(
        applied >= 3
          ? `Autonomy is now ${autonomyLabel(applied)}: Synapse may create sandbox issues and tentative calendar holds on its own. It still never sends email or messages.`
          : `Autonomy is now ${autonomyLabel(applied)}.`,
        applied >= 3 ? 8000 : undefined,
      );
    } catch (err) {
      setOptimistic(before);
      toast.warn(`Could not change the autonomy level, kept ${autonomyLabel(before ?? serverLevel)}: ${errorText(err)}`);
    } finally {
      setPending(null);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number): void => {
    const n = AUTONOMY_LEVELS.length;
    let next = i;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % n;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else return;
    // arrows only move focus: choosing a level changes what Synapse may do, so it takes Space or Enter
    e.preventDefault();
    refs.current[next]?.focus();
  };

  return (
    <Panel
      id="lab-autonomy"
      icon={<SlidersHorizontal size={16} />}
      title="Autonomy"
      sub="How far Synapse may act without asking you. Draft-first: nothing ever reaches another person on its own."
      badge={
        <span className="chip chip-tint chip-violet" title="The level the server enforces right now">
          <ShieldCheck size={12} aria-hidden /> <span>{autonomyLabel(current)}</span>
        </span>
      }
      className="lab-panel--wide"
    >
      <div className="lab-aut" role="radiogroup" aria-label="Autonomy level" aria-busy={pending !== null}>
        {AUTONOMY_LEVELS.map((l, i) => {
          const on = l.level === current;
          const busy = pending === l.level;
          return (
            <button
              key={l.level}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={on}
              aria-disabled={pending !== null && !busy}
              tabIndex={on ? 0 : -1}
              className={`lab-aut__card${on ? " is-on" : ""}${l.level >= 3 ? " is-exec" : ""}`}
              onClick={() => void choose(l.level)}
              onKeyDown={(e) => onKey(e, i)}
            >
              <span className="lab-aut__top">
                <span className="lab-aut__level">L{l.level}</span>
                <span className="lab-aut__steps" aria-hidden>
                  {AUTONOMY_LEVELS.map((s) => (
                    <i key={s.level} className={s.level <= l.level ? "is-on" : ""} />
                  ))}
                </span>
                {busy ? (
                  <span className="lab-aut__state" aria-live="polite">
                    <Loader2 size={13} className="lab-spin" aria-hidden /> Applying
                  </span>
                ) : on ? (
                  <span className="lab-aut__state lab-aut__state--on">
                    <Check size={13} aria-hidden /> Current
                  </span>
                ) : null}
              </span>
              <span className="lab-aut__name">{l.name}</span>
              <span className="lab-aut__tag">{l.tagline}</span>
              <span className="lab-aut__detail">{l.detail}</span>
              <span className="lab-aut__allows">
                {l.allows.map((a) => (
                  <span key={a}>
                    <Check size={12} aria-hidden /> {a}
                  </span>
                ))}
              </span>
            </button>
          );
        })}
      </div>
      <div className="lab-aut__never">
        <Lock size={15} aria-hidden />
        <p>
          <b>{AUTONOMY_NEVER}</b> That holds at every level. Anything Synapse does beyond drafting is written to the audit trail and can be undone from the Outbox.
        </p>
      </div>
      <p className="sr-only" aria-live="polite">
        {autonomyDef(current).name}: {autonomyDef(current).detail}
      </p>
    </Panel>
  );
});
