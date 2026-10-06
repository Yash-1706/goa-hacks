import { create } from "zustand";

/* Toasts. Server `notice` messages and local messages share this store. */

export type NoticeLevel = "info" | "warn" | "success";

export interface Toast {
  id: number;
  level: NoticeLevel;
  text: string;
  at: number;
  /** ms before it auto-dismisses */
  ttl: number;
}

export interface NoticesState {
  toasts: Toast[];
  seq: number;
  push: (level: NoticeLevel, text: string, opts?: { ttl?: number; now?: number }) => number;
  dismiss: (id: number) => void;
  clear: () => void;
}

const MAX_TOASTS = 4;

export const useNotices = create<NoticesState>()((set, get) => ({
  toasts: [],
  seq: 0,

  push: (level, text, opts = {}) => {
    const now = opts.now ?? Date.now();
    const { toasts, seq } = get();
    // identical text within 1.5 s is a duplicate (several services can announce the same thing)
    const dup = toasts.find((t) => t.text === text && now - t.at < 1500);
    if (dup) return dup.id;
    const id = seq + 1;
    const ttl = opts.ttl ?? (level === "warn" ? 7000 : 5000);
    set({ seq: id, toasts: [...toasts, { id, level, text, at: now, ttl }].slice(-MAX_TOASTS) });
    return id;
  },

  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

export const toast = {
  info: (text: string, ttl?: number) => useNotices.getState().push("info", text, { ttl }),
  success: (text: string, ttl?: number) => useNotices.getState().push("success", text, { ttl }),
  warn: (text: string, ttl?: number) => useNotices.getState().push("warn", text, { ttl }),
};
