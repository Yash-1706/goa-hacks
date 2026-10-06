import { create } from "zustand";
import type { ConnStatus } from "@/lib/orb";

export interface ConnectionState {
  status: ConnStatus;
  deviceId: string;
  deviceKind: "desk" | "pocket";
  /** why the server asked for pairing ("pairing code required" / "wrong pairing code") */
  authReason: string | null;
  /** last pairing attempt failed with this */
  pairingError: string | null;
  /** round trip of the last ping, ms */
  rttMs: number | null;
  /** server clock − client clock (median of recent pings), ms */
  clockOffsetMs: number | null;
  welcomeAt: number | null;
  reconnectAttempt: number;
  set: (patch: Partial<Omit<ConnectionState, "set">>) => void;
}

export const useConnection = create<ConnectionState>()((set) => ({
  status: "connecting",
  deviceId: "",
  deviceKind: "desk",
  authReason: null,
  pairingError: null,
  rttMs: null,
  clockOffsetMs: null,
  welcomeAt: null,
  reconnectAttempt: 0,
  set: (patch) => set(patch),
}));
