import { useEffect, useState } from "react";
import { tunnelHeaders } from "@/net/tunnel";
import Landing from "./Landing";
import { REPO_URL } from "./links";

/** "/" on the Mac: the landing page, with "Open app" as the primary action for a visitor who is already signed in. */
export default function LandingRoute() {
  const [loggedIn, setLoggedIn] = useState(false);
  useEffect(() => {
    document.title = "Synapse · Think out loud. Synapse files it.";
    fetch("/api/auth/status", { credentials: "same-origin", headers: tunnelHeaders(), signal: AbortSignal.timeout(4000) })
      .then((r) => (r.ok ? (r.json() as Promise<{ authenticated?: boolean }>) : null))
      .then((j) => setLoggedIn(Boolean(j?.authenticated)))
      .catch(() => undefined); // unreachable: stays the public version
  }, []);
  return <Landing appUrl="/app" repoUrl={REPO_URL} loggedIn={loggedIn} />;
}
