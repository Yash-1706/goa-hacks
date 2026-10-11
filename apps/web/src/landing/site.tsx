import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Landing from "./Landing";
import { DEMO_URL, REPO_URL, SITE_APP_URL } from "./links";

/* The GitHub Pages copy (pnpm run site:build): the landing page alone, no app code, no API calls, no personal data. */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Landing appUrl={SITE_APP_URL} repoUrl={REPO_URL} demoUrl={DEMO_URL} />
  </StrictMode>,
);
