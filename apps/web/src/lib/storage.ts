/** localStorage that never throws (private windows, blocked storage, SSR/tests). */

const mem = new Map<string, string>();

function ls(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function getItem(key: string): string | null {
  try {
    const s = ls();
    if (s) return s.getItem(key);
  } catch {
    /* fall through to memory */
  }
  return mem.get(key) ?? null;
}

export function setItem(key: string, value: string): void {
  mem.set(key, value);
  try {
    ls()?.setItem(key, value);
  } catch {
    /* quota / blocked: the in-memory copy is enough for this session */
  }
}

export function removeItem(key: string): void {
  mem.delete(key);
  try {
    ls()?.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function getJson<T>(key: string, fallback: T): T {
  const raw = getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function setJson(key: string, value: unknown): void {
  setItem(key, JSON.stringify(value));
}

/* per-tab storage (sessionStorage): survives a reload of the same tab, not shared between tabs */
const sessionMem = new Map<string, string>();

function ss(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function getSessionItem(key: string): string | null {
  try {
    const s = ss();
    if (s) return s.getItem(key);
  } catch {
    /* fall through */
  }
  return sessionMem.get(key) ?? null;
}

export function setSessionItem(key: string, value: string): void {
  sessionMem.set(key, value);
  try {
    ss()?.setItem(key, value);
  } catch {
    /* blocked: memory copy is enough */
  }
}
