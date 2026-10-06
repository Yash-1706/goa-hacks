import { getItem, getSessionItem, removeItem, setItem, setSessionItem } from "@/lib/storage";
import { randomSuffix } from "@/lib/ids";

/* Device identity: a random id per browser profile, plus the token the server issues after pairing. */

const ID_KEY = "synapse.deviceId";
/** set when ANOTHER tab of this browser took the shared id: this tab then counts as a device of its own */
const TAB_ID_KEY = "synapse.deviceId.tab";
const TOKEN_KEY = "synapse.token";

export function getDeviceId(): string {
  const own = getSessionItem(TAB_ID_KEY);
  if (own && own.length >= 3) return own;
  return getBaseDeviceId();
}

function getBaseDeviceId(): string {
  let id = getItem(ID_KEY);
  if (!id || id.length < 3) {
    id = `web-${randomSuffix(10)}`;
    setItem(ID_KEY, id);
  }
  return id;
}

/**
 * The server keeps ONE connection per device id and closes the older one when a newer arrives (code 4000).
 * Two tabs of the same browser share the stored id, so the kicked tab calls this to become a device of its own
 * instead of fighting for the id forever. Survives a reload of that tab.
 */
export function rotateTabDeviceId(): string {
  const id = `${getBaseDeviceId()}-${randomSuffix(4)}`;
  setSessionItem(TAB_ID_KEY, id);
  return id;
}

export const getToken = (): string | undefined => getItem(TOKEN_KEY) ?? undefined;
export const saveToken = (t: string): void => setItem(TOKEN_KEY, t);
export const clearToken = (): void => removeItem(TOKEN_KEY);

export interface KindEnv {
  pathname: string;
  search: string;
  /** touch-first device (primary pointer is coarse) */
  coarse: boolean;
  width: number;
}

/**
 * Is this browser a "desk" (laptop, projector) or a "pocket" (phone)?
 * ?kind=pocket|desk wins, then the /pocket route, then a coarse pointer on a phone-sized viewport.
 */
export function detectKind(env: KindEnv): "desk" | "pocket" {
  const q = new URLSearchParams(env.search).get("kind");
  if (q === "pocket" || q === "desk") return q;
  if (env.pathname.startsWith("/pocket")) return "pocket";
  if (env.coarse && env.width < 820) return "pocket";
  return "desk";
}

export function currentKind(): "desk" | "pocket" {
  if (typeof window === "undefined") return "desk";
  let coarse = false;
  try {
    coarse = window.matchMedia("(pointer: coarse)").matches;
  } catch {
    /* no matchMedia */
  }
  return detectKind({ pathname: window.location.pathname, search: window.location.search, coarse, width: window.innerWidth });
}

export function socketUrl(loc: Pick<Location, "origin">): string {
  return `${loc.origin.replace(/^http/, "ws")}/ws`;
}
