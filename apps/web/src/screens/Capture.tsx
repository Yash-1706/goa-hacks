import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { AlertTriangle, Check, CloudOff, Loader2, Mic, Square, Trash2 } from "lucide-react";
import type { CaptureView, ThoughtView } from "@synapse/shared";
import type { QueueItem } from "@/capture/queue";
import { ClipRecorder, audioToWav } from "@/capture/recorder";
import { captureQueue, loadRecentCaptures } from "@/capture/runtime";
import { takeShared } from "@/capture/share";
import { madeLine, waitingLine } from "@/capture/summary";
import { ShipCard } from "@/components/ship/ShipCard";
import { api } from "@/net/api";
import { useCaptures } from "@/state/captures";
import { useProfile } from "@/state/profile";
import { useThoughts } from "@/state/thoughts";

/* ============================================================================
 * /capture: the phone app (V1 phase 2). Tap, talk, tap. The clip is sealed into the offline queue the moment it stops and
 * uploaded when there is network; the cards it made show below, and on the laptop at the same time.
 * ========================================================================== */

const MAX_MS = 5 * 60_000;

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

const clock = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const when = (t: number): string => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** One capture: its status on this phone (if it came from here) and what it made. */
function CaptureRow({ item, capture, thoughts, online }: { item?: QueueItem; capture?: CaptureView; thoughts: ThoughtView[]; online: boolean }) {
  const status = item?.status ?? "sent";
  const at = item?.capturedAt ?? capture?.capturedAt ?? 0;
  return (
    <li className="cap-row" data-status={status} data-client-id={item?.clientId}>
      <div className="cap-row__head">
        <span className="cap-row__time">{when(at)}</span>
        {status === "waiting" ? (
          <span className="cap-badge cap-badge--wait">
            <CloudOff size={14} aria-hidden /> {waitingLine(item ?? {}, online)}
          </span>
        ) : status === "sending" ? (
          <span className="cap-badge">
            <Loader2 size={14} className="spin" aria-hidden /> Sending…
          </span>
        ) : status === "failed" ? (
          <span className="cap-badge cap-badge--bad">
            <AlertTriangle size={14} aria-hidden /> Could not send
          </span>
        ) : (
          <span className="cap-badge cap-badge--ok">
            <Check size={14} aria-hidden /> Sent
          </span>
        )}
        {item && (status === "waiting" || status === "failed") ? (
          <button type="button" className="icon-btn cap-row__discard" aria-label="Discard this recording" onClick={() => void captureQueue().discard(item.clientId)}>
            <Trash2 size={15} />
          </button>
        ) : null}
      </div>
      {status === "failed" && item?.error ? <p className="cap-row__error">{item.error}</p> : null}
      {status === "sent" ? (
        <>
          <p className="cap-row__made">{madeLine(thoughts)}</p>
          {thoughts.length ? (
            <div className="cap-things">
              {thoughts.map((t) => (
                <ShipCard key={t.id} thought={t} compact />
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </li>
  );
}

export default function Capture() {
  const loc = useLocation();
  const autostart = new URLSearchParams(loc.search).get("autostart") === "1";
  const online = useOnline();
  const queue = useCaptures((s) => s.queue);
  const recent = useCaptures((s) => s.recent);
  const byId = useThoughts((s) => s.byId);
  const [phase, setPhase] = useState<"idle" | "starting" | "recording" | "processing">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const rec = useRef<ClipRecorder | null>(null);

  useEffect(() => {
    captureQueue();
    void loadRecentCaptures();
    void useProfile.getState().load();
  }, []);

  // "Share → Synapse" from another app lands here with ?shared=1
  useEffect(() => {
    if (new URLSearchParams(loc.search).get("shared") !== "1") return;
    window.history.replaceState(null, "", "/capture");
    void (async () => {
      for (const share of await takeShared()) {
        for (const f of share.files) {
          try {
            await captureQueue().add({ audio: await audioToWav(f) });
          } catch {
            setError("That shared file is not audio this phone can read.");
          }
        }
        if (share.text && !share.files.length) await captureQueue().add({ text: share.text });
      }
    })();
  }, [loc.search]);

  // the cards of recent captures that this page has not seen over the socket yet
  const wanted = useMemo(() => {
    const ids = new Set<string>();
    for (const c of recent) for (const id of c.thoughtIds) ids.add(id);
    for (const q of queue) for (const id of q.result?.thoughtIds ?? []) ids.add(id);
    return [...ids].filter((id) => !byId[id]);
  }, [recent, queue, byId]);
  useEffect(() => {
    for (const id of wanted) void api.thought(id).then((t) => useThoughts.getState().upsert(t as ThoughtView), () => undefined);
  }, [wanted]);

  useEffect(() => {
    if (phase !== "recording") return;
    const t0 = rec.current?.startedAt ?? Date.now();
    const id = setInterval(() => {
      const ms = Date.now() - t0;
      setElapsed(ms);
      if (ms >= MAX_MS) void toggle();
    }, 250);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  async function toggle(): Promise<void> {
    setError(null);
    if (phase === "idle") {
      setPhase("starting");
      try {
        rec.current = new ClipRecorder();
        await rec.current.start();
        setElapsed(0);
        setPhase("recording");
      } catch (e) {
        rec.current?.cancel();
        setPhase("idle");
        setError((e as Error).name === "NotAllowedError" ? "Synapse needs the microphone. Allow it in the browser's site settings." : "The microphone could not start.");
      }
      return;
    }
    if (phase === "recording" && rec.current) {
      setPhase("processing");
      const startedAt = rec.current.startedAt;
      try {
        const { wav } = await rec.current.stop();
        await captureQueue().add({ audio: wav, capturedAt: startedAt });
      } catch {
        setError("That recording could not be read. Try again.");
      } finally {
        rec.current = null;
        setPhase("idle");
      }
    }
  }

  async function sendText(): Promise<void> {
    const t = text.trim();
    if (!t) return;
    setText("");
    await captureQueue().add({ text: t });
  }

  // this phone's clips first (they carry a status), then captures from other devices
  const rows = useMemo(() => {
    const mine = new Set(queue.map((q) => q.result?.captureId).filter(Boolean));
    const fromQueue = queue.map((item) => ({ key: item.clientId, at: item.capturedAt, item, capture: undefined as CaptureView | undefined, ids: item.result?.thoughtIds ?? [] }));
    const others = recent.filter((c) => !mine.has(c.captureId) && !queue.some((q) => q.clientId === c.clientId)).map((c) => ({ key: c.captureId, at: c.capturedAt, item: undefined as QueueItem | undefined, capture: c, ids: c.thoughtIds }));
    return [...fromQueue, ...others].sort((a, b) => b.at - a.at).slice(0, 15);
  }, [queue, recent]);

  const recording = phase === "recording";
  return (
    <div className="cap">
      <header className="cap__top">
        <img src="/icon.svg" alt="" width={26} height={26} />
        <span className="cap__word">Synapse</span>
        <span className={`cap__net${online ? "" : " cap__net--off"}`} role="status">
          <span className={`dot ${online ? "dot-ok" : "dot-warn"}`} /> {online ? "Online" : "Offline: recordings wait on this phone"}
        </span>
      </header>

      <section className="cap__stage" aria-live="polite">
        <button
          type="button"
          className={`cap-btn${recording ? " cap-btn--rec" : ""}${autostart && phase === "idle" ? " cap-btn--invite" : ""}`}
          onClick={() => void toggle()}
          disabled={phase === "starting" || phase === "processing"}
          aria-label={recording ? "Stop recording" : "Start recording"}
        >
          {phase === "processing" || phase === "starting" ? <Loader2 size={56} className="spin" /> : recording ? <Square size={52} fill="currentColor" /> : <Mic size={64} />}
        </button>
        <p className="cap__hint">
          {recording ? (
            <>
              <span className="cap__timer">{clock(elapsed)}</span> Tap to stop
            </>
          ) : phase === "processing" ? (
            "Saving…"
          ) : autostart ? (
            "Tap to start recording"
          ) : (
            "Tap, say everything on your mind, tap again"
          )}
        </p>
        {recording ? <p className="cap__keep">Keep the screen on while recording.</p> : null}
        {error ? (
          <p className="cap__error" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      <form
        className="cap__type"
        onSubmit={(e) => {
          e.preventDefault();
          void sendText();
        }}
      >
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Or type it" aria-label="Type a capture" />
        <button type="submit" className="btn" disabled={!text.trim()}>
          Send
        </button>
      </form>

      <section className="cap__list" aria-label="Your last captures">
        <h2 className="section__title">Your last captures</h2>
        {rows.length ? (
          <ul className="cap-rows">
            {rows.map((r) => (
              <CaptureRow key={r.key} item={r.item} capture={r.capture} online={online} thoughts={r.ids.map((id) => byId[id]).filter((t): t is ThoughtView => Boolean(t))} />
            ))}
          </ul>
        ) : (
          <p className="cap__empty">Nothing yet. Try: “That bug from yesterday in the cart service… and remind me to call the landlord tomorrow at 6.”</p>
        )}
      </section>

      <footer className="cap__foot">
        <Link to="/">Open the full app</Link>
      </footer>
    </div>
  );
}
