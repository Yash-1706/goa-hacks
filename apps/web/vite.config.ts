import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

const server = process.env.SYNAPSE_SERVER ?? "http://localhost:8787";
const nm = (p: string) => path.posix.join("node_modules", p);

// Phones need HTTPS for getUserMedia. HTTPS=1 uses a throwaway self-signed certificate (see TRD §11.2).
export default defineConfig(async () => {
  const plugins = [
    react(),
    tailwindcss(),
    // Only the files the real-time VAD needs (the docs' *.wasm glob copies ~80 MB of unused variants).
    viteStaticCopy({
      targets: [
        { src: nm("@ricky0123/vad-web/dist/vad.worklet.bundle.min.js"), dest: "vad" },
        { src: nm("@ricky0123/vad-web/dist/silero_vad_v5.onnx"), dest: "vad" },
        { src: nm("onnxruntime-web/dist/ort-wasm-simd-threaded.wasm"), dest: "vad" },
        { src: nm("onnxruntime-web/dist/ort-wasm-simd-threaded.mjs"), dest: "vad" },
      ],
    }),
  ];
  return {
    plugins,
    resolve: { alias: { "@": path.resolve(__dirname, "src") } },
    server: {
      port: 5173,
      host: true,
      proxy: {
        "/api": server,
        "/ws": { target: server, ws: true },
      },
    },
    build: { target: "es2022" },
    test: { environment: "node", include: ["src/**/*.test.ts"] },
  };
});
