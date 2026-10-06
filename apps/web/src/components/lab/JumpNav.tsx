import { useEffect, useRef, useState, type RefObject } from "react";
import { AudioLines, BatteryCharging, BookMarked, Server, SlidersHorizontal, TrendingUp, Zap } from "lucide-react";
import { useReducedMotion } from "@/hooks/useMedia";

/** Sticky "jump to" pills for the long Lab page; the active pill follows the last section whose top has scrolled past the bar. */

export const LAB_SECTIONS = [
  { id: "lab-latency", label: "Latency", Icon: Zap },
  { id: "lab-battery", label: "Battery", Icon: BatteryCharging },
  { id: "lab-autonomy", label: "Autonomy", Icon: SlidersHorizontal },
  { id: "lab-dictionary", label: "Dictionary", Icon: BookMarked },
  { id: "lab-adaptation", label: "Tuning", Icon: TrendingUp },
  { id: "lab-system", label: "System", Icon: Server },
  { id: "lab-audio", label: "Audio", Icon: AudioLines },
] as const;

const IDS: readonly string[] = LAB_SECTIONS.map((s) => s.id);

/** px below the top of the scroll container where a section counts as "current" (clear of the sticky bar) */
const PROBE = 150;

function useActiveSection(nav: RefObject<HTMLElement | null>): string {
  const [active, setActive] = useState<string>(IDS[0] as string);
  useEffect(() => {
    const scroller = nav.current?.closest<HTMLElement>(".page") ?? null;
    if (!scroller) return;
    let raf = 0;
    const measure = (): void => {
      raf = 0;
      const top = scroller.getBoundingClientRect().top;
      let cur = IDS[0] as string;
      for (const id of IDS) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (el.getBoundingClientRect().top - top <= PROBE) cur = id;
        else break;
      }
      // the last panels can never reach the probe line on a short page: at the very bottom the last one is current
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) cur = IDS[IDS.length - 1] as string;
      setActive(cur);
    };
    const schedule = (): void => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [nav]);
  return active;
}

export function JumpNav() {
  const ref = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  const active = useActiveSection(ref);
  return (
    <nav className="lab-jump" aria-label="Jump to a section" ref={ref}>
      <div className="lab-jump__bar">
        {LAB_SECTIONS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            className="lab-jump__btn"
            aria-current={active === id ? "true" : undefined}
            onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" })}
          >
            <Icon size={13} aria-hidden />
            <span>{label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
