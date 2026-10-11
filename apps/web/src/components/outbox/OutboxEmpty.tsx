import { Link } from "react-router-dom";
import { ArrowRight, Inbox, Lock, Mic } from "lucide-react";

/** Nothing exists yet: say what will appear here and why nothing leaves the device without a tap. */
export function OutboxEmpty() {
  return (
    <div className="ob-empty glass" role="status">
      <div className="ob-empty__art" aria-hidden>
        <span className="ob-empty__ring" />
        <Inbox size={30} />
      </div>
      <h2 className="ob-empty__title">Your outbox is empty</h2>
      <p className="ob-empty__copy">Drafts appear here the moment Synapse hears something actionable; nothing leaves this device until you say so. Draft-first.</p>
      <ul className="ob-empty__try" aria-label="Things to say">
        {["“I need to email the team about the delay”", "“That bug from yesterday… in the cart service… probably the discount code”", "“Let’s schedule a design review Thursday at 3pm”"].map((t) => (
          <li key={t}>
            <Mic size={12} aria-hidden /> {t}
          </li>
        ))}
      </ul>
      <div className="ob-empty__foot">
        <Link to="/app" className="btn btn-primary btn-sm">
          Open the Desk <ArrowRight size={13} aria-hidden />
        </Link>
        <span className="ob-empty__lock">
          <Lock size={12} aria-hidden /> Email and messages are only ever drafted, never sent.
        </span>
      </div>
    </div>
  );
}

/** A group with nothing in it: one intentional line, not a blank. */
export function GroupEmpty({ title, body }: { title: string; body: string }) {
  return (
    <div className="ob-gempty" role="status">
      <b>{title}</b>
      <span>{body}</span>
    </div>
  );
}
