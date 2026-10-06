# Synapse: your voice is a second brain

> WhisperFlow Hackathon 2026 · **Problem Statement 4: Ambient Cognitive Offloading** · built on the **Wispr Flow API**

Think out loud: mumble, backtrack, whisper. Synapse stitches the fragments into thoughts, works out what you *meant*, and quietly turns them into tickets, GitHub issues, email drafts, calendar holds, code snippets and decisions, with **no commands**. It remembers selectively (a knowledge graph you can query by vague voice questions), speaks up only at natural pauses, and forgets by default. Say *"pause memory"* and the microphone is released.

| | |
|---|---|
| Product spec | [docs/PRD.md](docs/PRD.md) · research: [docs/RESEARCH.md](docs/RESEARCH.md) |
| Technical spec | [docs/TRD.md](docs/TRD.md) · as-built architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Deliverables | [Architecture diagram](docs/ARCHITECTURE.md) · [Latency benchmark](docs/LATENCY.md) · [Privacy whitepaper](docs/PRIVACY_WHITEPAPER.md) · [Failure modes](docs/FAILURE_MODES.md) · [Eval](docs/EVAL.md) · [Demo script](docs/DEMO_SCRIPT.md) · [Pitch](docs/PITCH.md) |

## Quickstart (works with no keys)

```bash
pnpm install
pnpm dev                 # API + WebSocket on :8787, web UI on http://localhost:5173
```

With no keys Synapse runs in **mock mode**: type into the collapsed keyboard field (or play a scripted ramble) and the whole pipeline runs with a local classifier and heuristic cortex. Add keys to go live:

```bash
cp .env.example .env     # then edit (never commit it)
```

| Variable | Needed for |
|---|---|
| `WISPR_API_KEY` + `WISPR_MODE=client` | live microphone transcription (API access is by approval from Wispr: ask the organizers) |
| `ANTHROPIC_API_KEY` + `LLM_MODE=live` | the real cortex (Haiku 4.5 hot path, Opus 5.5 recall/brief) |
| `GITHUB_TOKEN` + `GITHUB_REPO` (`owner/repo`) | real GitHub issues (otherwise clearly-labelled simulation) |
| `JIRA_*` | real Jira tickets (otherwise simulated) |
| `SYNAPSE_PASSPHRASE` | portable encryption key (default: OS credential store, else a key file) |

Before a demo: `pnpm --filter @synapse/server warm-models` (caches the local embedding model so it works offline).

### Phone ("Pocket mode")
Phones need HTTPS for the microphone. In PowerShell: `$env:HTTPS=1; pnpm dev:web`, open `https://<laptop-ip>:5173/pocket`, accept the self-signed certificate warning once, and enter the **6-digit pairing code** printed in the server console. Capture is foreground-only (iOS/Android suspend web audio in the background), so Pocket keeps the screen awake.

## Commands

| | |
|---|---|
| `pnpm dev` | server + web together |
| `pnpm test` / `pnpm typecheck` | all tests / all type checks |
| `pnpm replay scripts/replay/s1_bug.json [--speed 4] [--local]` | play a scripted ramble into the running server (watch the UI), or in-process |
| `pnpm seed [--reset]` | write ~8 backdated sessions (development aid; **the live demo should use real dogfooded sessions**) |
| `pnpm eval [--live]` | score intent, control phrases, reference resolution, recall, nonsense robustness → `docs/EVAL.md` |
| `pnpm bench [--live]` | per-stage latency benchmark → `docs/LATENCY.md`, `docs/latency.csv` |

## What is verified, and what is not

**Verified here** (130+ automated tests, `pnpm test`): the cortex pipeline end to end on the problem statement's own examples (stitching, self-repair, asides, retraction, recurring-concern suggestion, cross-session reference, recall); AES-256-GCM encryption, per-day-key crypto-shredding, cascade deletion, TTL expiry; pause/forget/purge and the hash-chained audit; device pairing and the origin guard over real WebSockets; the Claude backend against a faithful Messages-API streaming fake (partial cards, cache usage, redaction round-trip, auth/rate-limit/refusal/timeout degradation, strict-schema fallback); the Wispr streamer against a fake WebSocket.

**Not verifiable without credentials/devices, and therefore labelled unverified:** the real Claude API behaviour and latency (`pnpm eval --live`, `pnpm bench --live`), the real Wispr WebSocket (assumptions listed in `apps/web/src/audio/README.md`), microphone/VAD behaviour on real whispers, phone background behaviour, real battery deltas.

**Designed but not built:** on-device keyword spotting for an instant local pause, local speech-to-text for `LOCAL_ONLY`, owner-only speaker verification, Google Calendar/Gmail adapters, Wispr `proxy` mode.

## Layout

```
apps/server     Fastify + WebSocket brain: gate · cortex · memory · recall · proactive · privacy · integrations
apps/web        React 19 + Vite UI and the browser audio pipeline (VAD, Wispr streaming, sensors)
packages/shared zod protocol + domain schemas (also the model's structured-output contract)
eval/           golden corpora (held-out novel phrasings reported separately from the dev set)
scripts/replay  scripted rambles from the problem statement
docs/           PRD · TRD · architecture · privacy · failure modes · eval · latency · demo · pitch
```
