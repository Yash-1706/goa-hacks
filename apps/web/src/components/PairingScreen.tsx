import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { motion } from "motion/react";
import { KeyRound, ShieldCheck } from "lucide-react";
import { socket } from "@/runtime";
import { useConnection } from "@/state/connection";

const LEN = 6;

/**
 * Shown when the server answers `auth.required`: this device is not on localhost, so it must enter the
 * 6-digit pairing code once (printed in the server console, shown at /privacy on the host).
 */
export function PairingScreen() {
  const reason = useConnection((s) => s.authReason);
  const error = useConnection((s) => s.pairingError);
  const [digits, setDigits] = useState<string[]>(Array(LEN).fill(""));
  const [busy, setBusy] = useState(false);
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    refs.current[0]?.focus();
  }, []);
  useEffect(() => {
    if (error) {
      setBusy(false);
      setDigits(Array(LEN).fill(""));
      refs.current[0]?.focus();
    }
  }, [error]);

  const submit = (d: string[]): void => {
    const code = d.join("");
    if (code.length !== LEN) return;
    setBusy(true);
    socket.pair(code);
  };

  const setAt = (i: number, v: string): void => {
    const clean = v.replace(/\D/g, "");
    if (!clean) {
      setDigits((d) => d.map((x, j) => (j === i ? "" : x)));
      return;
    }
    const next = [...digits];
    for (let k = 0; k < clean.length && i + k < LEN; k++) next[i + k] = clean[k] as string;
    setDigits(next);
    const focusAt = Math.min(LEN - 1, i + clean.length);
    refs.current[focusAt]?.focus();
    if (next.every(Boolean)) submit(next);
  };

  const onKey = (i: number, e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Backspace" && !digits[i] && i > 0) refs.current[i - 1]?.focus();
    if (e.key === "ArrowLeft" && i > 0) refs.current[i - 1]?.focus();
    if (e.key === "ArrowRight" && i < LEN - 1) refs.current[i + 1]?.focus();
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>): void => {
    const text = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, LEN);
    if (!text) return;
    e.preventDefault();
    const next = Array.from({ length: LEN }, (_, i) => text[i] ?? "");
    setDigits(next);
    refs.current[Math.min(LEN - 1, text.length)]?.focus();
    if (next.every(Boolean)) submit(next);
  };

  return (
    <div className="pair" role="dialog" aria-modal="true" aria-labelledby="pair-title">
      <motion.div className="pair__card glass-strong glass-blur" initial={{ opacity: 0, y: 24, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: "spring", stiffness: 260, damping: 26 }}>
        <div style={{ display: "grid", placeItems: "center" }}>
          <img src="/icon.svg" alt="" width={64} height={64} style={{ borderRadius: 18 }} />
        </div>
        <h1 id="pair-title" style={{ margin: "1rem 0 0.3rem", fontSize: "1.4rem", fontWeight: 720, letterSpacing: "-0.02em" }}>
          Pair this device
        </h1>
        <p style={{ margin: 0, color: "var(--dim)", fontSize: "0.9rem" }}>
          Synapse only talks to devices you trust. Enter the 6-digit code from the server console or from <b>Privacy</b> on the laptop that runs Synapse.
        </p>
        <div className="pair__code" role="group" aria-label="Pairing code">
          {digits.map((d, i) => (
            <input
              key={i}
              ref={(el) => {
                refs.current[i] = el;
              }}
              value={d}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={LEN}
              aria-label={`Digit ${i + 1}`}
              onChange={(e) => setAt(i, e.target.value)}
              onKeyDown={(e) => onKey(i, e)}
              onPaste={onPaste}
              disabled={busy}
            />
          ))}
        </div>
        <div className="pair__error" role="alert">
          {error ?? (reason && reason !== "pairing code required" ? reason : "")}
        </div>
        <button type="button" className="btn btn-primary btn-lg" style={{ width: "100%" }} disabled={busy || digits.some((d) => !d)} onClick={() => submit(digits)}>
          <KeyRound size={16} /> {busy ? "Checking…" : "Pair"}
        </button>
        <p style={{ margin: "1rem 0 0", color: "var(--faint)", fontSize: "0.74rem", display: "flex", gap: "0.4rem", justifyContent: "center", alignItems: "center" }}>
          <ShieldCheck size={13} /> You only do this once. The device then holds a token, never the code.
        </p>
      </motion.div>
    </div>
  );
}
