import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";

/* V1.1: "/" is the public landing page, everything else is the app. Both are lazy so the landing page never downloads the app
 * (and the app never downloads the landing page). */
const LandingRoute = lazy(() => import("./landing/LandingRoute"));
const App = lazy(() => import("./App"));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={null}>{window.location.pathname === "/" ? <LandingRoute /> : <App />}</Suspense>
  </StrictMode>,
);
