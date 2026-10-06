import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyToClipboard } from "@/lib/download";

export function CopyButton({ text, label = "Copy", className = "btn btn-ghost btn-sm", disabled }: { text: string | (() => string); label?: string; className?: string; disabled?: boolean }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <button
      type="button"
      className={className}
      disabled={disabled}
      onClick={async () => {
        const ok = await copyToClipboard(typeof text === "function" ? text() : text);
        if (!ok) return;
        setDone(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setDone(false), 1600);
      }}
      aria-live="polite"
    >
      {done ? <Check size={13} style={{ color: "var(--ok)" }} /> : <Copy size={13} />}
      {done ? "Copied" : label}
    </button>
  );
}
