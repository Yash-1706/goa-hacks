import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type PluginOption } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { viteStaticCopy } from "vite-plugin-static-copy";

const server = process.env.SYNAPSE_SERVER ?? "http://localhost:8787";
const nm = (p: string) => path.posix.join("node_modules", p);

/**
 * Phones need a secure context for getUserMedia (TRD §11.2). `HTTPS=1 pnpm dev:web` serves the app over TLS
 * with a throwaway self-signed certificate (@vitejs/plugin-basic-ssl): accept the browser warning once on the phone,
 * then open https://<laptop-ip>:5173/pocket. In PowerShell: `$env:HTTPS=1; pnpm dev:web`.
 */
const useHttps = ["1", "true", "yes"].includes((process.env.HTTPS ?? "").toLowerCase());

export default defineConfig(async () => {
  const plugins: PluginOption[] = [
    react(),
    tailwindcss(),
    // Only the files the real-time VAD needs (the docs' *.wasm glob copies ~80 MB of unused variants).
    // vite-plugin-static-copy 4.x KEEPS the source folder structure under `dest` unless the target says
    // `rename: { stripBase: true }`; without it the files land at /vad/node_modules/... and MicVAD gets a 404
    // for /vad/silero_vad_v5.onnx (verified: 404 before, 200 after).
    viteStaticCopy({
      targets: [
        { src: nm("@ricky0123/vad-web/dist/vad.worklet.bundle.min.js"), dest: "vad", rename: { stripBase: true } },
        { src: nm("@ricky0123/vad-web/dist/silero_vad_v5.onnx"), dest: "vad", rename: { stripBase: true } },
        { src: nm("onnxruntime-web/dist/ort-wasm-simd-threaded.wasm"), dest: "vad", rename: { stripBase: true } },
        { src: nm("onnxruntime-web/dist/ort-wasm-simd-threaded.mjs"), dest: "vad", rename: { stripBase: true } },
      ],
    }),
    // PWA: the phone app (/capture) is installable. The big VAD assets (/vad/*.wasm, *.onnx) are deliberately NOT precached.
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "icon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Synapse",
        short_name: "Synapse",
        description: "Your voice is a second brain. Think out loud; Synapse does the rest.",
        theme_color: "#0c0c0d",
        background_color: "#0c0c0d",
        display: "standalone",
        orientation: "portrait",
        start_url: "/capture",
        scope: "/",
        categories: ["productivity", "utilities"],
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
        ],
        shortcuts: [
          { name: "Capture", short_name: "Capture", url: "/capture?autostart=1", description: "Record a thought (one tap to start)", icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }] },
          { name: "Inbox", url: "/" },
        ],
        // "Share → Synapse" from a voice recorder or any app: handled by public/share-target.js inside the service worker
        share_target: {
          action: "/capture/share",
          method: "POST",
          enctype: "multipart/form-data",
          params: { title: "title", text: "text", url: "url", files: [{ name: "audio", accept: ["audio/*", ".m4a", ".mp3", ".wav", ".ogg", ".opus", ".webm", ".aac", ".amr"] }] },
        },
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"],
        globIgnores: ["vad/**", "**/*.wasm", "**/*.onnx"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/ws/, /^\/vad\//, /^\/local-stt\//],
        // the share-target handler runs before Workbox's routes (it answers the share POST itself)
        importScripts: ["share-target.js"],
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ];

  if (useHttps) {
    try {
      const { default: basicSsl } = await import("@vitejs/plugin-basic-ssl");
      plugins.push(basicSsl());
    } catch (err) {
      console.warn(`[vite] HTTPS=1 needs @vitejs/plugin-basic-ssl (${(err as Error).message}); serving plain HTTP`);
    }
  }

  return {
    plugins,
    resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
    server: {
      port: 5173,
      host: true,
      proxy: {
        // xfwd: the API server decides trust (localhost vs paired device) from the real client IP
        "/api": { target: server, xfwd: true },
        "/ws": { target: server, ws: true, xfwd: true },
        // the on-device speech endpoints (a WebSocket and a REST route), same origin as the page so phones and HTTPS tunnels work
        "/local-stt": { target: server, ws: true, xfwd: true },
      },
    },
    // pre-bundle the VAD on startup so Vite doesn't re-optimise (and reload the page) the first time the mic is used
    optimizeDeps: { include: ["@ricky0123/vad-web"] },
    build: { target: "es2022" },
    test: { environment: "node", include: ["src/**/*.test.ts"] },
  };
});
