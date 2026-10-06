import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Keyboard, Send, X } from "lucide-react";
import { controller } from "@/runtime";
import { useSettings } from "@/state/settings";

/**
 * A deliberately quiet typed-input affordance (no microphone? demo fallback?). Collapsed it is a single
 * faint keyboard icon, so the demo still reads as voice-only. Shift+Enter starts a new fragment with a pause.
 */
export function KeyboardInput({ className }: { className?: string }) {
  const open = useSettings((s) => s.typedOpen);
  const patch = useSettings((s) => s.patch);
  const [text, setText] = useState("");
  const [whisper, setWhisper] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);

  // "k" opens the typed input from anywhere (unless you are already typing somewhere)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
      if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        useSettings.getState().patch({ typedOpen: true });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const send = (): void => {
    const v = text.trim();
    if (!v) return;
    setText("");
    void controller.injectText(v, { whisper });
    ref.current?.focus();
  };

  return (
    <div className={`typed ${className ?? ""}`}>
      <AnimatePresence initial={false} mode="wait">
        {open ? (
          <motion.form
            key="open"
            className="typed__form"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 38 }}
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <label className="sr-only" htmlFor="typed-input">
              Type what you would say
            </label>
            <textarea
              id="typed-input"
              ref={ref}
              className="input typed__input"
              rows={2}
              value={text}
              placeholder="Type what you'd say. Shift+Enter = a pause, then another fragment."
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
                if (e.key === "Escape") patch({ typedOpen: false });
              }}
            />
            <div className="typed__row">
              <label className="typed__whisper">
                <input type="checkbox" checked={whisper} onChange={(e) => setWhisper(e.target.checked)} /> whisper
              </label>
              <button type="button" className="icon-btn" aria-label="Close typed input" onClick={() => patch({ typedOpen: false })}>
                <X size={15} />
              </button>
              <button type="submit" className="btn btn-primary btn-sm" disabled={!text.trim()}>
                <Send size={13} /> Say it
              </button>
            </div>
          </motion.form>
        ) : (
          <motion.button
            key="closed"
            type="button"
            className="typed__toggle"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.55 }}
            whileHover={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            aria-label="Type instead of speaking (press K)"
            title="Type instead of speaking (K)"
            onClick={() => patch({ typedOpen: true })}
          >
            <Keyboard size={16} />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
