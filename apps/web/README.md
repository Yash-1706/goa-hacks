# Synapse web (apps/web)

React 19 + Vite 8 + Tailwind 4 + zustand 5 + motion 14. Everything on screen comes from the Synapse server (`/ws` + `/api`); there is no fake data in the UI.

## Run

```powershell
pnpm --filter @synapse/web dev        # or: pnpm dev:web   → http://localhost:5173
```

The Vite dev server proxies `/api` and `/ws` to `http://localhost:8787` (override with `SYNAPSE_SERVER`) and forwards the real client IP (`xfwd`), so the server can tell the laptop (trusted) from a phone (needs pairing).

### Phone / Pocket mode (HTTPS)

Phones only open the microphone in a secure context. Start the web app with a throwaway self-signed certificate (`@vitejs/plugin-basic-ssl`):

```powershell
$env:HTTPS = 1; pnpm dev:web          # bash: HTTPS=1 pnpm dev:web
```

Open `https://<laptop-ip>:5173/pocket` on the phone, accept the certificate warning once, enter the 6-digit pairing code (server console, or Privacy Center on the laptop) and "Add to Home Screen" to install the PWA. Without HTTPS the app still works on the phone with typed input.

### Production build / PWA

`pnpm --filter @synapse/web build` emits `manifest.webmanifest` + a Workbox service worker. The VAD model and ONNX wasm under `/vad/` are deliberately **not** precached.

## Screens

| Route | What it is |
|---|---|
| `/` | **Desk**: live stream · living cards · Synapse rail (suggestions, echoes, brief). The demo surface. |
| `/pocket` | **Pocket**: phone-first giant orb, pause, activity / battery / Eco, last cards. |
| `/recall` | Ask memory (typed, or spoken on the Desk): constraint chips, sources, streamed answer with `[T-12]` citations, local-voice TTS. |
| `/privacy` | Pause control, "what leaves this device", retention + key list, purge / local-only / export, ledger, audit chain verify, pairing. |
| `/graph` | Knowledge graph with timeline scrubber (lazy-loaded). |
| `/lab` | Latency table + histograms, Battery Lab (modeled), dictionary, adaptation, autonomy level, diagnostics (lazy-loaded). |
| `/outbox` | Drafts grouped by status with the same actions as the cards. |

Keyboard: `K` opens the (deliberately quiet) typed-input box. Large type for projectors: the `Aa` button in the nav.

## How it is wired

```
net/socket.ts      typed WS client: hello / pairing, reconnect + backoff, ping + clock offset, offline queue
net/handlers.ts    ServerMessage → store updates (one switch; unit-tested)
net/api.ts         REST wrapper (device + token headers); net/api-types.ts response shapes
state/*            zustand stores: thoughts (+ack map), stream, suggestions, recall, privacy, metrics, graph, notices, settings, devices, audio
audio-controller.ts  builds AudioEngineOptions, owns start / pause / resume / stop; mic engine or typed engine
runtime.ts         singletons (socket, handlers, controller); window.__synapse in dev for poking from the console
lib/               pure logic: formatting, stream grouping, orb state, latency tracker, markdown, artifacts, highlight
components/        Orb, TopBar + chips, FragmentStream, ThoughtCard (+ artifact renderers, trail, edit), SynapseRail, ...
screens/           one file per route
```

Latency reporting: for every fragment THIS device spoke, the first painted `thought.upsert` after its ack sends `metrics.client {firstPaint}`, and the finished analysis (`analyzing=false`) sends `{artifactRender}` against the thought's latest acked fragment. Fragments from other devices are never reported (their clock is not ours).

## Tests

```powershell
pnpm --filter @synapse/web typecheck
pnpm --filter @synapse/web test       # vitest, node environment, pure logic + stores + socket + controller
```
