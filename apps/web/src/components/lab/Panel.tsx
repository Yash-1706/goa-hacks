import type { ReactNode } from "react";
import { CheckCircle2, Minus, OctagonAlert, TriangleAlert } from "lucide-react";
import type { TargetTone } from "@/lib/lab-latency";

/** A glass panel with an icon, a title, a one-line explanation and optional badge / actions. */
export function Panel({
  id,
  icon,
  title,
  sub,
  badge,
  actions,
  className = "",
  children,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  sub?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className={`lab-panel glass ${className}`} aria-labelledby={`${id}-title`}>
      <header className="lab-panel__head">
        <span className="lab-panel__icon" aria-hidden>
          {icon}
        </span>
        <div className="lab-panel__titles">
          <h2 id={`${id}-title`} className="lab-panel__title">
            {title}
          </h2>
          {sub ? <p className="lab-panel__sub">{sub}</p> : null}
        </div>
        {badge ? <div className="lab-panel__badge">{badge}</div> : null}
        {actions ? <div className="lab-panel__actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

const TONE_ICON = { good: CheckCircle2, ok: TriangleAlert, bad: OctagonAlert, none: Minus } as const;
const TONE_LABEL: Record<TargetTone, string> = { good: "On target", ok: "Close", bad: "Over target", none: "No target" };

/**
 * A status verdict that never relies on colour alone: icon + word + tint.
 * `labels` lets a caller reword the verdicts ("Below target" for a reduction that falls short).
 */
export function ToneChip({ tone, labels, title, small = false }: { tone: TargetTone; labels?: Partial<Record<TargetTone, string>>; title?: string; small?: boolean }) {
  const Icon = TONE_ICON[tone];
  return (
    <span className={`lab-tone lab-tone--${tone}${small ? " lab-tone--sm" : ""}`} title={title}>
      <Icon size={small ? 11 : 13} aria-hidden />
      <span>{labels?.[tone] ?? TONE_LABEL[tone]}</span>
    </span>
  );
}

/** the plain-language verdict word for screen readers and tooltips */
export const toneWord = (tone: TargetTone): string => TONE_LABEL[tone];
