import "../silence";
import { loadConfig } from "../config";
import { createEmbedder } from "../memory/embeddings";

/** Pre-download the local embedding model (do this once, before the demo, on good Wi-Fi). */
const cfg = loadConfig();
const t0 = Date.now();
const e = await createEmbedder({ mode: "model", model: cfg.embeddings.model, dataDir: cfg.embeddings.cacheDir });
console.log(`embedding model: ${e.name} (${e.mode}) ready in ${Date.now() - t0} ms, cached under ${cfg.embeddings.cacheDir}/models`);
if (e.mode !== "model") {
  console.error("✖ the neural model did not load; Synapse will fall back to the lexical hash embedder");
  process.exit(1);
}
