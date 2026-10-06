import { Suspense, lazy, useEffect, useState } from "react";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import { MotionConfig } from "motion/react";
import { Nav } from "@/components/Nav";
import { PairingScreen } from "@/components/PairingScreen";
import { RecallSpeaker } from "@/components/RecallSpeaker";
import { Toasts } from "@/components/Toasts";
import { TopBar } from "@/components/TopBar";
import Desk from "@/screens/Desk";
import Pocket from "@/screens/Pocket";
import Recall from "@/screens/Recall";
import { startRuntime } from "@/runtime";
import { useConnection } from "@/state/connection";
import { usePrivacy } from "@/state/privacy";
import { useSettings } from "@/state/settings";

// heavy or rarely-opened screens are code-split (the graph pulls in a canvas force-layout engine)
const Graph = lazy(() => import("@/screens/Graph"));
const Lab = lazy(() => import("@/screens/Lab"));
const Privacy = lazy(() => import("@/screens/Privacy"));
const Outbox = lazy(() => import("@/screens/Outbox"));

const TITLES: Record<string, string> = {
  "/": "Desk",
  "/pocket": "Pocket",
  "/recall": "Recall",
  "/graph": "Graph",
  "/privacy": "Privacy Center",
  "/lab": "Lab",
  "/outbox": "Outbox",
};

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
              <Route path="/" element={<Desk />} />
              <Route path="/pocket" element={<Pocket />} />
              <Route path="/recall" element={<Recall />} />
              <Route path="/graph" element={<Graph />} />
              <Route path="/privacy" element={<Privacy />} />
              <Route path="/lab" element={<Lab />} />
              <Route path="/outbox" element={<Outbox />} />
              <Route path="*" element={<Desk />} />
            </Routes>
          </Suspense>
        </main>
      </div>
      <Toasts />
      <RecallSpeaker />
      {status === "auth" ? <PairingScreen /> : null}
    </div>
  );
}

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </MotionConfig>
  );
}
