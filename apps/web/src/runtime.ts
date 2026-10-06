import { AudioController } from "@/audio-controller";
import { afterPaint } from "@/lib/latency";
import { createHandlers } from "@/net/handlers";
import { currentKind, getDeviceId, getToken, rotateTabDeviceId, saveToken, socketUrl } from "@/net/device";
import { SynapseSocket, type SocketHooks } from "@/net/socket";
import { useAudioUi, useLevel } from "@/state/audio";
import { useConnection } from "@/state/connection";
import { toast } from "@/state/notices";
import { usePrivacy } from "@/state/privacy";
import { useStream } from "@/state/stream";
import { useSuggestions } from "@/state/suggestions";
import { useThoughts } from "@/state/thoughts";

/* ============================================================================
 * The app's singletons: one socket, one set of handlers, one audio controller. Components never create
 * these; they import `socket` / `controller` and read stores. startRuntime() is idempotent.
 * ========================================================================== */

const hooks: SocketHooks = {
  onStatus: (status, info) => useConnection.getState().set({ status, reconnectAttempt: info?.attempt ?? 0 }),
  onAuth: (reason, wrongCode) => useConnection.getState().set({ authReason: reason, pairingError: wrongCode ? reason : null }),
  onWelcome: (msg) => {
    if (msg.token) saveToken(msg.token);
    useConnection.getState().set({ authReason: null, pairingError: null });
  },
  onReplaced: () => {
    const id = rotateTabDeviceId();
    useConnection.getState().set({ deviceId: id });
    toast.info("Synapse is open in another tab of this browser. This tab now counts as its own device.");
  },
  onMessage: (m) => {
    handlers.handle(m);
    // after the welcome snapshot is in the stores: re-announce a running session / honour an offline pause
    if (m.type === "welcome") controller.onReconnected();
  },
  onClock: ({ rttMs, offsetMs }) => useConnection.getState().set({ rttMs, clockOffsetMs: offsetMs }),
};

export const socket = new SynapseSocket({
  url: () => socketUrl(window.location),
  identity: () => ({ deviceId: getDeviceId(), kind: useConnection.getState().deviceKind, token: getToken() }),
  hooks,
});

const handlers = createHandlers({
  send: (m) => socket.send(m),
  now: () => Date.now(),
  schedule: (fn, ms) => setTimeout(fn, ms),
  afterPaint,
  onRemotePause: () => controller.onRemotePause(),
  onRemoteResume: () => controller.onRemoteResume(),
});

export const controller = new AudioController({
  send: (m) => socket.send(m),
  requestToken: (opts) => socket.requestWisprToken(undefined, opts?.force),
  tracker: () => handlers.tracker,
});

let started = false;

export function startRuntime(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  useConnection.getState().set({ deviceId: getDeviceId(), deviceKind: currentKind() });
  socket.start();
  controller.preload();
  controller.initBattery();

  const prune = setInterval(() => useStream.getState().prune(Date.now()), 1000);
  const onVisible = (): void => {
    if (document.visibilityState === "visible") socket.retryNow();
  };
  const onOnline = (): void => socket.retryNow();
  const onHide = (): void => controller.onPageHide();
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", onOnline);
  window.addEventListener("pagehide", onHide);

  if (import.meta.env.DEV) {
    // dev-only handles for poking the app from the console / browser tests
    (window as unknown as { __synapse?: unknown }).__synapse = { socket, controller, handlers, stores: { audio: useAudioUi, level: useLevel, connection: useConnection, privacy: usePrivacy, stream: useStream, suggestions: useSuggestions, thoughts: useThoughts } };
  }
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      clearInterval(prune);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pagehide", onHide);
      socket.stop();
      started = false;
    });
  }
}
