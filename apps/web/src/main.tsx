import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

// Placeholder shell: the UI agent replaces this with the real app (see docs/TRD.md §13).
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div style={{ padding: 24 }}>Synapse is starting…</div>
  </StrictMode>,
);
