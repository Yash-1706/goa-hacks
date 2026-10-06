import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { useNotices, type Toast } from "@/state/notices";

function ToastItem({ t }: { t: Toast }) {
  const dismiss = useNotices((s) => s.dismiss);
  useEffect(() => {
    const id = setTimeout(() => dismiss(t.id), t.ttl);
    return () => clearTimeout(id);
  }, [t.id, t.ttl, dismiss]);
  const Icon = t.level === "success" ? CircleCheck : t.level === "warn" ? TriangleAlert : Info;
  return (
    <motion.div
      layout
      className={`toast toast--${t.level}`}
      initial={{ opacity: 0, y: 18, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 40, scale: 0.97, transition: { duration: 0.18 } }}
      transition={{ type: "spring", stiffness: 420, damping: 34 }}
      role={t.level === "warn" ? "alert" : "status"}
    >
      <Icon size={18} className="toast__icon" aria-hidden />
      <div className="toast__body">{t.text}</div>
      <button type="button" className="icon-btn" style={{ width: "1.6rem", height: "1.6rem" }} onClick={() => dismiss(t.id)} aria-label="Dismiss notification">
        <X size={14} />
      </button>
      <span className="toast__timer" style={{ ["--dur" as string]: `${t.ttl}ms` }} aria-hidden />
    </motion.div>
  );
}

export function Toasts() {
  const toasts = useNotices((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite" aria-relevant="additions">
      <AnimatePresence initial={false} mode="popLayout">
        {toasts.map((t) => (
          <ToastItem key={t.id} t={t} />
        ))}
      </AnimatePresence>
    </div>
  );
}
