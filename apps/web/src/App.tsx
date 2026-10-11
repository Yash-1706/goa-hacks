import { Suspense, lazy, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { MotionConfig } from "motion/react";
import { LoginScreen } from "@/components/LoginScreen";
import { Nav } from "@/components/Nav";
import { PairingScreen } from "@/components/PairingScreen";
import { RecallSpeaker } from "@/components/RecallSpeaker";
import { Toasts } from "@/components/Toasts";
import { TopBar } from "@/components/TopBar";
import { captureQueue } from "@/capture/runtime";
import { Onboarding } from "@/components/Onboarding";
import Inbox from "@/screens/Inbox";
import Recall from "@/screens/Recall";
import { socket, startRuntime } from "@/runtime";
import { useAuth } from "@/state/auth";
import { useConnection } from "@/state/connection";
import { usePrivacy } from "@/state/privacy";
import { useSettings } from "@/state/settings";
import "./index.css";

// heavy or rarely-opened screens are code-split (the graph pulls in a canvas force-layout engine)
const Settings = lazy(() => import("@/screens/Settings"));
const Capture = lazy(() => import("@/screens/Capture"));

const TITLES: Record<string, string> = {
  "/app": "Inbox",
  "/capture": "Capture",
  "/app/ask": "Ask",
  "/app/settings": "Settings",
};

/** V1.1: the app lives under /app (the landing page has /); every older URL keeps working */
function OldSettingsTab() {
  const { tab } = useParams();
  return <Navigate to={`/app/settings/${tab ?? ""}`} replace />;
}

function RouteFallback() {
  return (
    <div className="empty" role="status" style={{ height: "100%" }}>
      <span className="shimmer" style={{ width: "12rem", height: "1rem" }} />
    </div>
  );
}

/** Offline banner: only after a short grace period so the initial connect does not flash it. */
function useDelayed(flag: boolean, ms: number): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!flag) {
      setOn(false);
      return;
    }
    const id = setTimeout(() => setOn(true), ms);
    return () => clearTimeout(id);
  }, [flag, ms]);
  return on;
}

function Shell() {
  const loc = useLocation();
  const status = useConnection((s) => s.status);
  const largeType = useSettings((s) => s.largeType);
  const paused = usePrivacy((s) => s.paused);
  const pocket = loc.pathname.startsWith("/pocket");
  const offline = useDelayed(status === "closed" || status === "connecting", 1400);

  useEffect(() => {
    startRuntime();
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("lg", largeType);
  }, [largeType]);
  useEffect(() => {
    const base = TITLES[loc.pathname] ?? "Synapse";
    document.title = pocket ? "Synapse Pocket" : `${base} · Synapse`;
  }, [loc.pathname, pocket]);

  return (
    <div className="app" data-paused={paused}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className={`aurora${pocket ? " calm" : ""}`} aria-hidden />
      <Nav />
      <div className="app__main">
        {pocket ? null : <TopBar />}
        <main className="app__page" id="main" tabIndex={-1}>
          {offline && status !== "auth" ? (
            <div className="banner" role="status">
              <span className="dot dot-warn dot-pulse" /> Offline: reconnecting to the Synapse server. Fragments you say are queued.
            </div>
          ) : null}
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/app" element={<Inbox />} />
              <Route path="/app/ask" element={<Recall />} />
              <Route path="/app/settings" element={<Settings />} />
              <Route path="/app/settings/:tab" element={<Settings />} />
              {/* older URLs keep working: V1's top-level screens, then the screens V1 moved into Settings */}
              <Route path="/ask" element={<Navigate to="/app/ask" replace />} />
              <Route path="/settings" element={<Navigate to="/app/settings" replace />} />
              <Route path="/settings/:tab" element={<OldSettingsTab />} />
              <Route path="/login" element={<Navigate to="/app" replace />} />
              <Route path="/pocket" element={<Navigate to="/capture" replace />} />
              <Route path="/recall" element={<Navigate to="/app/ask" replace />} />
              <Route path="/privacy" element={<Navigate to="/app/settings/privacy" replace />} />
              <Route path="/graph" element={<Navigate to="/app/settings/memory" replace />} />
              <Route path="/outbox" element={<Navigate to="/app/settings/outbox" replace />} />
              <Route path="/lab" element={<Navigate to="/app/settings/developer" replace />} />
              <Route path="*" element={<Navigate to="/app" replace />} />
            </Routes>
          </Suspense>
        </main>
      </div>
      <Toasts />
      <RecallSpeaker />
      <Onboarding />
      {status === "auth" ? <PairingScreen /> : null}
    </div>
  );
}

/** The phone app: no navigation, no top bar; the socket still runs so cards arrive live. */
function CaptureShell() {
  useEffect(() => {
    startRuntime();
    document.title = "Synapse";
  }, []);
  return (
    <main id="main">
      <Suspense fallback={<RouteFallback />}>
        <Capture />
      </Suspense>
      <Toasts />
    </main>
  );
}

/**
 * Sign-in first when the server asks for it (always through the tunnel). An unreachable server is not a reason to block:
 * the phone app opens offline and records into its queue.
 */
function AuthGate() {
  const status = useAuth((s) => s.status);
  const loc = useLocation();
  useEffect(() => {
    void useAuth.getState().check();
  }, []);
  if (status === "checking") return <RouteFallback />;
  if (status === "needed")
    return (
      <LoginScreen
        onSignedIn={() => {
          socket.retryNow();
          void captureQueue().flush();
        }}
      />
    );
  return loc.pathname.startsWith("/capture") ? <CaptureShell /> : <Shell />;
}

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <BrowserRouter>
        <AuthGate />
      </BrowserRouter>
    </MotionConfig>
  );
}
