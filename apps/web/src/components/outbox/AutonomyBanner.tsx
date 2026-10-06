import { Link } from "react-router-dom";
import { ArrowRight, Lock } from "lucide-react";
import { useAutonomyLevel } from "@/components/lab/useAutonomy";
import { AUTONOMY_LEVELS, AUTONOMY_NEVER, autonomyDef, clampLevel } from "@/lib/lab-adapt";

/** The autonomy ladder in one glance, with the level the server enforces right now and a link to change it in the Lab. */
export function AutonomyBanner() {
  const raw = useAutonomyLevel();
  const level = raw === null ? null : clampLevel(raw);
  const def = level === null ? null : autonomyDef(level);

  return (
    <aside className="ob-aut glass" aria-label="Autonomy level">
      <ol className="ob-aut__ladder" aria-label={level === null ? "Autonomy ladder" : `Autonomy ladder, you are at level ${level} of 3`}>
        {AUTONOMY_LEVELS.map((l) => {
          const on = level !== null && l.level <= level;
          const now = level === l.level;
          return (
            <li key={l.level} className={`ob-aut__step${on ? " is-on" : ""}${now ? " is-now" : ""}`} aria-current={now ? "step" : undefined}>
              <span className="ob-aut__node">L{l.level}</span>
              <span className="ob-aut__name">{l.name}</span>
            </li>
          );
        })}
      </ol>
      <div className="ob-aut__text">
        {def ? (
          <p>
            <b>
              L{level} · {def.name}.
            </b>{" "}
            {def.detail}
          </p>
        ) : (
          <p>
            <span className="shimmer" style={{ display: "block", height: "0.9rem", width: "70%" }} aria-hidden />
          </p>
        )}
        <p className="ob-aut__never">
          <Lock size={12} aria-hidden /> {AUTONOMY_NEVER}
        </p>
      </div>
      <Link to="/lab#lab-autonomy" className="btn btn-sm ob-aut__link" title="Open the autonomy dial in the Lab">
        Change level <ArrowRight size={13} aria-hidden />
      </Link>
    </aside>
  );
}
