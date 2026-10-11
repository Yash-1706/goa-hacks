import { useEffect, useMemo, useState } from "react";
import { Mic, Send, Sparkles, Square, X } from "lucide-react";
import type { ThoughtView } from "@synapse/shared";
import { PausedBanner } from "@/components/PausedBanner";
import { ShipCard } from "@/components/ship/ShipCard";
import { buckets, sessionSummary } from "@/lib/inbox";
import { api } from "@/net/api";
import { controller, socket } from "@/runtime";
import { useAudioUi } from "@/state/audio";
import { toast } from "@/state/notices";
import { useProfile } from "@/state/profile";
import { LIVE_STATUSES, useSuggestions } from "@/state/suggestions";
import { useThoughts } from "@/state/thoughts";

/* ============================================================================
 * The Inbox (V1): say or type anything at the top; below, what needs you (drafts and questions), what is done (shipped,
 * with links), and what is saved (notes, ideas, decisions). One suggestion at a time, as a dismissible banner.
 * ========================================================================== */

const QUIET_MS = 4000;
const RECENT_MS = 15 * 60_000;

function CaptureBar() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const live = useAudioUi((s) => s.state === "listening" || s.state === "hearing" || s.state === "starting");
  const send = async (): Promise<void> => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    try {
      await api.capture(t);
      setText("");
    } catch (e) {
      toast.warn((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="inbox-bar"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <label className="sr-only" htmlFor="capture-box">
        Type, or hold your Wispr Flow key and talk
      </label>
      <textarea
        id="capture-box"
        className="input inbox-bar__input"
        rows={1}
        value={text}
        placeholder="Type, or hold your Wispr Flow key and talk"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
        disabled={busy}
      />
      <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()} aria-label="Send">
        <Send size={15} />
        <span className="hide-sm">Send</span>
      </button>
      <button
        type="button"
        className={`icon-btn inbox-bar__mic${live ? " is-live" : ""}`}
        aria-pressed={live}
        aria-label={live ? "Stop listening" : "Talk (live microphone)"}
        title={live ? "Stop listening" : "Talk (live microphone)"}
        onClick={() => void (live ? controller.stop() : controller.start())}
      >
        {live ? <Square size={15} fill="currentColor" /> : <Mic size={17} />}
      </button>
    </form>
  );
}

function SuggestionBanner() {
  const items = useSuggestions((s) => s.items);
  // "draft ready" only repeats a card that is already in Needs you
  const top = items.find((s) => LIVE_STATUSES.has(s.status) && s.kind !== "draft_ready");
  if (!top) return null;
  const act = (action: "accept" | "dismiss"): void => void socket.send({ type: "suggestion.action", id: top.id, action });
  return (
    <div className="inbox-banner" role="status">
      <Sparkles size={16} aria-hidden />
      <div className="inbox-banner__text">
        <b>{top.title}</b>
        <span>{top.why || top.body}</span>
      </div>
      <button type="button" className="btn btn-sm" onClick={() => act("accept")}>
        {top.acceptLabel}
      </button>
      <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => act("dismiss")}>
        <X size={15} />
      </button>
    </div>
  );
}

/** "Captured 4 things · 2 need you", once the newest session has gone quiet. */
function useSessionLine(thoughts: ThoughtView[]): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(id);
  }, []);
  return useMemo(() => {
    const visible = thoughts.filter((t) => !["aside", "privacy", "correction"].includes(t.category));
    const newest = [...visible].sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!newest || now - newest.createdAt > RECENT_MS) return null;
    const session = visible.filter((t) => t.sessionId === newest.sessionId);
    const quiet = session.every((t) => !t.analyzing) && now - Math.max(...session.map((t) => t.updatedAt)) > QUIET_MS;
    return quiet ? sessionSummary(session) : null;
  }, [thoughts, now]);
}

function Section({ title, items, empty }: { title: string; items: ThoughtView[]; empty?: string }) {
  if (!items.length && !empty) return null;
  return (
    <section className="inbox-sec" aria-label={title}>
      <h2 className="section__title">
        {title}
        {items.length ? <span className="inbox-sec__n">{items.length}</span> : null}
      </h2>
      {items.length ? (
        <div className="inbox-grid">
          {items.map((t) => (
            <ShipCard key={t.id} thought={t} />
          ))}
        </div>
      ) : (
        <p className="inbox-empty">{empty}</p>
      )}
    </section>
  );
}

export default function Inbox() {
  const byId = useThoughts((s) => s.byId);
  const order = useThoughts((s) => s.order);
  const thoughts = useMemo(() => order.map((id) => byId[id]).filter((t): t is ThoughtView => Boolean(t)), [order, byId]);
  const b = useMemo(() => buckets(thoughts), [thoughts]);
  const line = useSessionLine(thoughts);
  useEffect(() => {
    if (!useProfile.getState().profile) void useProfile.getState().load();
  }, []);

  return (
    <div className="inbox">
      <h1 className="sr-only">Inbox</h1>
      <PausedBanner />
      <CaptureBar />
      {line ? (
        <p className="inbox-line" role="status">
          {line}
        </p>
      ) : null}
      <SuggestionBanner />
      {thoughts.length ? (
        <>
          <Section title="Needs you" items={b.needsYou} empty="Nothing waiting. Say or type something above." />
          <Section title="Done" items={b.done} />
          <Section title="Saved" items={b.saved} />
        </>
      ) : (
        <div className="inbox-hello">
          <p className="inbox-hello__lead">Ramble. Synapse turns it into things you can ship.</p>
          <p className="inbox-hello__eg">Try: “That bug from yesterday in the cart service… oh, and email the team that the launch moves to Friday. Remind me to call the landlord tomorrow at 6.”</p>
          <p className="inbox-hello__out">You get a GitHub issue, an email draft and a reminder, each one tap from done.</p>
        </div>
      )}
    </div>
  );
}
