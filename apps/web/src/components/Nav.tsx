import { NavLink } from "react-router-dom";
import { motion } from "motion/react";
import { Inbox, Search, Settings, Type } from "lucide-react";
import { useRecall } from "@/state/recall";
import { useSettings } from "@/state/settings";

const ITEMS = [
  { to: "/", label: "Inbox", Icon: Inbox, end: true },
  { to: "/ask", label: "Ask", Icon: Search, end: false },
  { to: "/settings", label: "Settings", Icon: Settings, end: false },
] as const;

export function Nav() {
  const unseenVoice = useRecall((s) => s.unseenVoice);
  const largeType = useSettings((s) => s.largeType);
  const patch = useSettings((s) => s.patch);

  return (
    <nav className="nav" aria-label="Main">
      <div className="nav__brand" aria-hidden>
        <img src="/icon.svg" alt="" />
        <span className="nav__word">Synapse</span>
      </div>
      <div className="nav__list">
        {ITEMS.map(({ to, label, Icon, end }) => (
          <NavLink key={to} to={to} end={end} className="nav__item">
            {({ isActive }) => (
              <>
                {isActive ? <motion.span layoutId="nav-pill" className="nav__pill" transition={{ type: "spring", stiffness: 520, damping: 38 }} /> : null}
                <Icon size={20} strokeWidth={isActive ? 2.2 : 1.8} />
                <span>{label}</span>
                {label === "Ask" && unseenVoice > 0 ? <span className="nav__badge" aria-label="new spoken recall" /> : null}
              </>
            )}
          </NavLink>
        ))}
      </div>
      <div className="nav__spacer" />
      <div className="nav__foot">
        <button
          type="button"
          className="icon-btn"
          aria-pressed={largeType}
          aria-label="Large type for projectors"
          title="Large type (for a projector)"
          onClick={() => patch({ largeType: !largeType })}
        >
          <Type size={18} />
        </button>
      </div>
    </nav>
  );
}
