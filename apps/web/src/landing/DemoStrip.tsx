import { useEffect, useRef, useState, type ReactNode } from "react";
import { ASIDE_START, DEMO_WORDS, FINAL_FRAME, LOOP_MS, frameAt, type DemoFrame } from "./demo";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION).matches;
}

function sameFrame(a: DemoFrame, b: DemoFrame): boolean {
  return a.words === b.words && a.asideFaded === b.asideFaded && a.cards === b.cards && a.done === b.done;
}

const svg = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, "aria-hidden": true } as const;

const ICONS = {
  issue: (
    <svg {...svg}>
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  ),
  mail: (
    <svg {...svg}>
      <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
      <path d="m2.5 4.5 5.5 4.25L13.5 4.5" />
    </svg>
  ),
  clock: (
    <svg {...svg}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.75V8l2.25 1.5" strokeLinecap="round" />
    </svg>
  ),
} satisfies Record<string, ReactNode>;

interface DemoCard {
  kind: string;
  icon: ReactNode;
  title: string;
  meta: string;
  action: string;
}

const CARDS: DemoCard[] = [
  { kind: "GitHub issue", icon: ICONS.issue, title: "Null pointer in cart-service", meta: "acme/shop", action: "Create issue" },
  { kind: "Email draft", icon: ICONS.mail, title: "The launch moves to Friday", meta: "To the team", action: "Open draft" },
  { kind: "Reminder", icon: ICONS.clock, title: "Call the landlord", meta: "Tomorrow, 6:00 pm", action: "Add to calendar" },
];

/**
 * The live demo: the ramble types out, the aside strikes out, three cards appear, hold, loop.
 * Driven by the pure `frameAt` timeline. Elapsed time only advances while the tab is visible,
 * and reduced-motion users get the final state with no animation.
 */
export default function DemoStrip() {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  const [frame, setFrame] = useState<DemoFrame>(() => (reduced ? FINAL_FRAME : frameAt(0)));
  const frameRef = useRef(frame);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(REDUCED_MOTION);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const show = (next: DemoFrame) => {
      if (sameFrame(frameRef.current, next)) return;
      frameRef.current = next;
      setFrame(next);
    };

    if (reduced) {
      show(FINAL_FRAME);
      return;
    }

    let elapsed = 0; // ms of visible playback, modulo LOOP_MS
    let last: number | null = null;
    let raf = 0;

    const tick = (now: number) => {
      if (last !== null) elapsed = (elapsed + Math.min(now - last, 250)) % LOOP_MS; // clamp: no jump after a stall
      last = now;
      show(frameAt(elapsed));
      raf = requestAnimationFrame(tick);
    };
    const start = () => {
      if (raf) return;
      last = null;
      raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };
    const onVisibility = () => (document.visibilityState === "hidden" ? stop() : start());

    show(frameAt(0));
    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reduced]);

  const typing = frame.words < DEMO_WORDS.length;

  return (
    <div className="lp-demo">
      <p className="lp-sr">
        Demo: someone says “That bug from yesterday… the null pointer in cart service, probably the discount code. Oh, and email
        the team that the launch moves to Friday. Remind me to call the landlord tomorrow at 6. Wait, was that my phone?” Synapse
        drops the aside about the phone and makes three cards: a GitHub issue “Null pointer in cart-service” for acme/shop with a
        Create issue button, an email draft “The launch moves to Friday” to the team with an Open draft button, and a reminder
        “Call the landlord” tomorrow at 6:00 pm with an Add to calendar button.
      </p>

      <div className="lp-demo__stage" aria-hidden="true">
        <div className="lp-demo__transcript">
          <div className="lp-demo__bar">
            <span className={`lp-demo__dot${typing ? " is-live" : ""}`} />
            <span>{typing ? "Listening" : frame.done ? "Made 3 things" : "Sorting"}</span>
          </div>
          <p className="lp-demo__text">
            {DEMO_WORDS.map((word, i) => {
              const aside = i >= ASIDE_START;
              const cls = [
                "lp-demo__w",
                i < frame.words && "is-on",
                typing && i === frame.words - 1 && "is-caret",
                aside && "is-aside",
                aside && frame.asideFaded && "is-struck",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <span key={i}>
                  <span className={cls}>{word}</span>{" "}
                </span>
              );
            })}
          </p>
        </div>

        <ul className="lp-demo__cards">
          {CARDS.map((card, i) => (
            <li key={card.kind} className={`lp-card${i < frame.cards ? " is-on" : ""}`}>
              <div className="lp-card__kind">
                {card.icon}
                <span>{card.kind}</span>
              </div>
              <div className="lp-card__title">{card.title}</div>
              <div className="lp-card__meta">{card.meta}</div>
              <span className="lp-card__btn">{card.action}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
