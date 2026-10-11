import fs from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * `pnpm run site:build`: the landing page alone, as a static site for GitHub Pages (site-dist/). Relative base, so it works
 * under /<repo>/. No app code, no PWA, no API calls; the post-build check in scripts/site-check.mjs enforces that.
 */
const here = import.meta.dirname;
const out = path.resolve(here, "../../site-dist");

/** only the public files the page uses (favicon, share image, the hero's launch video and poster), plus .nojekyll so Pages serves the files as they are */
const copyAssets = (): Plugin => ({
  name: "synapse-site-assets",
  closeBundle() {
    fs.mkdirSync(path.join(out, "media"), { recursive: true });
    fs.mkdirSync(path.join(out, "demo"), { recursive: true });
    for (const f of ["favicon.svg", "og.png", ...["landscape", "vertical"].flatMap((v) => [`media/synapse-launch-${v}.mp4`, `media/synapse-launch-${v}.jpg`])]) fs.copyFileSync(path.join(here, "public", f), path.join(out, f));
    // the /demo/ page: both launch videos in real players (static HTML, no app code)
    fs.copyFileSync(path.join(here, "site-static/demo/index.html"), path.join(out, "demo/index.html"));
    fs.writeFileSync(path.join(out, ".nojekyll"), "");
  },
});

export default defineConfig({
  root: path.join(here, "site"),
  base: "./",
  publicDir: false,
  envDir: here,
  plugins: [react(), copyAssets()],
  resolve: { alias: { "@": path.join(here, "src") } },
  build: { outDir: out, emptyOutDir: true, target: "es2022" },
});
