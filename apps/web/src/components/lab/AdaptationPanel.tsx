import { memo, useMemo } from "react";
import { ArrowDown, ArrowUp, Check, Minus, Repeat, ThumbsDown, ThumbsUp, TrendingDown, TrendingUp, X } from "lucide-react";
import {
  DELIVERY_DEFAULT,
  DELIVERY_DOWN,
  DELIVERY_MAX,
  DELIVERY_MIN,
  DELIVERY_UP,
  adaptSentence,
  describeAdaptations,
  recurringRule,
  type AdaptView,
} from "@/lib/lab-adapt";
import type { SettingsResponse } from "@/net/api-types";
import { Panel } from "./Panel";
import type { Polled } from "./usePolled";

/* Proactivity tuning (PRD PRO-7, TRD §9.4): per suggestion kind, the bar a suggestion has to clear before Synapse
 * interrupts. Dismiss raises it, accept lowers it. Drawn from the server's pattern_state rows. */

function Track({ v }: { v: AdaptView }) {
  const lo = Math.min(v.at, v.defAt) * 100;
  const hi = Math.max(v.at, v.defAt) * 100;
  return (
    <div
      className="lab-adapt__track"
      role="img"
      aria-label={`${v.title}: ${v.valueText} on a scale from ${v.min} to ${v.max}; default ${v.defText}`}
    >
      <span className="lab-adapt__rail" />
      {hi > lo ? <span className={`lab-adapt__span lab-adapt__span--${v.stance}`} style={{ left: `${lo}%`, width: `${hi - lo}%` }} /> : null}
      <span className="lab-adapt__def" style={{ left: `${v.defAt * 100}%` }}>
        <i>default {v.defText}</i>
      </span>
      <span className={`lab-adapt__dot lab-adapt__dot--${v.stance}`} style={{ left: `${v.at * 100}%` }} />
      <span className="lab-adapt__end lab-adapt__end--l">{v.kind === "recurring" ? `${v.min}×` : v.min.toFixed(2)}</span>
      <span className="lab-adapt__end lab-adapt__end--r">{v.kind === "recurring" ? `${v.max}×` : v.max.toFixed(2)}</span>
    </div>
  );
}

function StanceTag({ stance }: { stance: AdaptView["stance"] }) {
  if (stance === "stricter")
    return (
      <span className="lab-stance lab-stance--up" title="Dismissals raised the bar: Synapse speaks up less about this">
        <TrendingUp size={12} aria-hidden /> stricter
      </span>
    );
  if (stance === "easier")
    return (
      <span className="lab-stance lab-stance--down" title="Accepts lowered the bar: Synapse speaks up sooner about this">
        <TrendingDown size={12} aria-hidden /> easier
      </span>
    );
  return (
    <span className="lab-stance" title="Back at the default">
      <Minus size={12} aria-hidden /> default
    </span>
  );
}

function Row({ v }: { v: AdaptView }) {
  return (
    <li className="lab-adapt__row">
      <div className="lab-adapt__head">
        <div className="lab-adapt__title">
          {v.kind === "recurring" ? <Repeat size={14} aria-hidden /> : null}
          {v.title}
        </div>
        <StanceTag stance={v.stance} />
        <div className="lab-adapt__val tnum" title={v.what}>
          {v.valueText}
        </div>
      </div>
      <Track v={v} />
      <div className="lab-adapt__foot">
        <span className="lab-fb lab-fb--ok" title="Times you accepted this kind of suggestion">
          <Check size={12} aria-hidden /> <b className="tnum">{v.accepts}</b> accepted
        </span>
        <span className="lab-fb lab-fb--no" title="Times you dismissed this kind of suggestion">
          <X size={12} aria-hidden /> <b className="tnum">{v.dismisses}</b> dismissed
        </span>
        <span className="lab-adapt__sentence">{adaptSentence(v)}</span>
      </div>
    </li>
  );
}

export const AdaptationPanel = memo(function AdaptationPanel({ settings }: { settings: Polled<SettingsResponse> }) {
  const { data, error, loading } = settings;
  const rule = data ? recurringRule(data.recurring) : null;
  const views = useMemo(() => (data ? describeAdaptations(data.adaptation, data.recurring.n) : []), [data]);

  return (
    <Panel
      id="lab-adaptation"
      icon={<TrendingUp size={16} />}
      title="Proactivity tuning"
      sub="Synapse learns when to speak up. Each time you dismiss a suggestion the bar for that kind goes up; each accept brings it down."
      className="lab-panel--adapt"
    >
      <div className="lab-rules">
        <div className="lab-rule lab-rule--no">
          <ThumbsDown size={14} aria-hidden />
          <div>
            <b>Dismiss</b>
            <span>
              raises the bar <ArrowUp size={11} aria-hidden /> +{DELIVERY_UP.toFixed(2)} (and +1 repeat for recurring concerns)
            </span>
          </div>
        </div>
        <div className="lab-rule lab-rule--ok">
          <ThumbsUp size={14} aria-hidden />
          <div>
            <b>Accept</b>
            <span>
              lowers the bar <ArrowDown size={11} aria-hidden /> −{DELIVERY_DOWN.toFixed(2)} (and −1 repeat)
            </span>
          </div>
        </div>
      </div>

      {rule ? (
        <p className="lab-adapt__rule">
          <Repeat size={14} aria-hidden /> <b>Recurring concern:</b> <span>{rule.trigger}</span> · <span>{rule.gap}</span>
        </p>
      ) : null}

      {loading && !data ? (
        <div className="lab-skel" aria-hidden>
          <span className="shimmer" style={{ height: "4rem" }} />
        </div>
      ) : error && !data ? (
        <p className="lab-error" role="alert">
          Could not load the tuning rows: {error}
        </p>
      ) : views.length === 0 ? (
        <div className="lab-adapt__none">
          <div
            className="lab-adapt__track lab-adapt__track--demo"
            role="img"
            aria-label={`Every suggestion kind starts at ${DELIVERY_DEFAULT.toFixed(2)} on a scale from ${DELIVERY_MIN} to ${DELIVERY_MAX}`}
          >
            <span className="lab-adapt__rail" />
            <span className="lab-adapt__def" style={{ left: `${((DELIVERY_DEFAULT - DELIVERY_MIN) / (DELIVERY_MAX - DELIVERY_MIN)) * 100}%` }}>
              <i>default {DELIVERY_DEFAULT.toFixed(2)}</i>
            </span>
            <span className="lab-adapt__end lab-adapt__end--l">{DELIVERY_MIN.toFixed(2)}</span>
            <span className="lab-adapt__end lab-adapt__end--r">{DELIVERY_MAX.toFixed(2)}</span>
          </div>
          <p>
            <b>No feedback yet.</b> Accept or dismiss one of Synapse’s suggestions on the Desk and the bar for that kind starts to move here.
          </p>
        </div>
      ) : (
        <ul className="lab-adapt__list">
          {views.map((v) => (
            <Row key={v.key} v={v} />
          ))}
        </ul>
      )}
    </Panel>
  );
});
