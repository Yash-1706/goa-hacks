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
| `GROQ_API_KEY` + `LLM_MODE=live` | the same pipeline on Groq's free tier when there is no Anthropic key (gpt-oss hot path and recall/brief; see *Groq notes* below). `LLM_PROVIDER=auto` (default) prefers Anthropic when both keys exist; force one with `LLM_PROVIDER=anthropic` or `groq` |
| `GITHUB_TOKEN` + `GITHUB_REPO` (`owner/repo`) | real GitHub issues (otherwise clearly-labelled simulation) |
| `JIRA_*` | real Jira tickets (otherwise simulated) |
| `SYNAPSE_PASSPHRASE` | portable encryption key (default: OS credential store, else a key file) |

Before a demo: `pnpm --filter @synapse/server warm-models` (caches the local embedding model so it works offline).

### Groq (free tier) notes

No Anthropic key yet? A Groq key (`GROQ_API_KEY`, plus `LLM_MODE=live`) runs the same pipeline: the top-bar chip reads `live groq qwen3.8-27b` and the Privacy Center names Groq as the cloud stop. `LLM_PROVIDER=auto` (the default) uses Claude when both keys exist; `LLM_PROVIDER=groq|anthropic` forces one. Text is redacted before every call exactly as for Claude, `/api/health` and the audit trail name the provider (`groq:<model>`), and `LOCAL_ONLY=1` still sends nothing.

| | default | why (live comparison, 18 mixed inputs per model, same prompt) |
|---|---|---|
| hot path `GROQ_MODEL_FAST` | `qwen/qwen3.8-27b` | 17/18 categories right, 18/18 artifact kinds, p50 0.95 s per call; `gpt-oss-120b` 14/18 (1.27 s), `gpt-oss-20b` 13/18 (1.05 s); valid JSON 18/18 for all three |
| recall answer, brief, consolidation `GROQ_MODEL_DEEP` | `openai/gpt-oss-120b` | a larger reasoning model (`reasoning_effort` medium) on its own per-model budget, so a capture burst that empties the hot path's minute cannot starve a recall answer; a recall answer takes ~1.2 s |

What the free tier means in practice (measured on a free key):

- **8,000 tokens per minute and 1,000 requests per day, metered per model.** A call is admitted only while the model's remaining tokens cover its prompt *plus* `max_completion_tokens`; a prompt over 8,000 is rejected outright (HTTP 413). The 8.5k-token Claude prompt can never be sent, so Groq gets the ~2k-token contract in `cortex/prompts-lite.ts` (rules, category precedence, every artifact's fields, privacy prohibitions, two worked examples). A call costs about 2.6k tokens in all, so roughly **2.5 live calls per minute** per model after the first two or three. No prompt caching was reported on this tier.
- **There is also a per-model DAILY token cap** (HTTP 429 `rate_limit_exceeded (TPD)`). Heavy testing on this key exhausted `qwen/qwen3.8-27b` for the day: the server paused live calls for 120 s and every card fell back to the local cortex with `degraded: rate_limit` (the degradation path works), while `GROQ_MODEL_FAST=openai/gpt-oss-120b` still had budget and produced a live card end to end (category bug, artifact github_issue, confidence 0.92). If you see the TPD warning in the server log, switch `GROQ_MODEL_FAST` to the other model or wait for the window to roll over; keep demo-day experiments modest.
- **The client paces itself** (`llm/groq-client.ts`): a token bucket per model (`GROQ_TPM`, default 7,000), a call waits at most `GROQ_MAX_WAIT_MS` (2 s) for the budget and otherwise falls back to the local cortex with a `degraded: paced` badge instead of earning a 429. A 429 is never retried (`retry-after` cool-down), an auth failure switches the path off for 60 s, a dead connection for 4 s, `GROQ_MAX_REQUESTS_PER_DAY` (900) caps the day, and the response headers correct the bucket if the key is shared.
- **Expect degradation under a burst.** The engine makes one call per fragment when fragments arrive faster than a call finishes. Simulated with the real client against a fake that enforces Groq's admission rule (prompt 2.3k, answer 0.3k, 2 s patience): one single-fragment thought every 30 s stays 100% live; every 15 s 83%; every 10 s 67%; 2-fragment thoughts every 20 s 50%; 3-fragment thoughts every 20 s 33%; eight fragments in 12 s 25% (the first two). Never a 429. `GROQ_MAX_WAIT_MS=6000` trades latency for a few more live answers; `GROQ_TPM`/`GROQ_MAX_REQUESTS_PER_DAY` can be raised on a paid plan.
- **Cards appear whole, not typing in.** In JSON modes Groq delivers the answer as one chunk (gpt-oss after its reasoning), so there is no partial card to stream. `GROQ_OUTPUT_MODE=text` streams token by token (the card fills in from ~0.5 s) but gives up Groq's JSON guarantee (zod and one repair retry still apply). Strict `json_schema` works but costs ~1.5k extra prompt tokens on gpt-oss.
- **Watching it:** `/api/health` → `groq` (requests today, tokens left this minute, per-model buckets) and the Lab's System panel. `pnpm eval --live --limit 5 --budget 36` and `pnpm bench --live --limit 4 --runs 1 --budget 10` write `docs/EVAL.groq.md` / `docs/LATENCY.groq.md` and label the provider and model in the header (so far only a small, diluted eval run exists: `docs/EVAL.groq.md`; the Groq bench has not been run); the committed `docs/EVAL.md` and `docs/LATENCY.md` stay the offline numbers. A live run builds ONE client for all its apps (the budget belongs to the key), waits out cool-downs instead of racing through them, and on Groq seeds the recall section's memories with the local cortex (`--live-recall` for live seeding) to save ~14 requests.
- **Switching back:** unset `GROQ_API_KEY` or set `LLM_PROVIDER=anthropic`; nothing else changes.

### Phone ("Pocket mode")
Phones need HTTPS for the microphone. In PowerShell: `$env:HTTPS=1; pnpm dev:web`, open `https://<laptop-ip>:5173/pocket`, accept the self-signed certificate warning once, and enter the **6-digit pairing code** printed in the server console (a paired phone stays paired across restarts). Capture is foreground-only (iOS/Android suspend web audio in the background), so Pocket keeps the screen awake.

*Phone can't connect?* Allow Node.js through the Windows firewall on **private** networks (ports 5173 and 8787), put the phone and laptop on the same Wi-Fi (venue Wi-Fi often isolates clients: use a phone hotspot), and use the laptop's LAN address, not `localhost`. Browsers on public websites cannot reach the API: only local/private-network origins are accepted.

## Commands

| | |
|---|---|
| `pnpm dev` | server + web together |
| `pnpm test` / `pnpm typecheck` | all tests / all type checks |
| `pnpm replay scripts/replay/s1_bug.json [--speed 4] [--local]` | play a scripted ramble into the running server (watch the UI), or in-process |
| `pnpm wispr:check [--rest] [--idle 60]` | the first thing to run once a Wispr key exists: speaks a synthetic sentence through the real token path and streamer and reports the Wispr wire assumptions as PASS / FAIL / UNKNOWN |
| `pnpm seed [--reset]` | write ~8 backdated sessions (development aid; **the live demo should use real dogfooded sessions**) |
| `pnpm eval [--live] [--limit N] [--out file]` | score intent, control phrases, reference resolution, recall, nonsense robustness → `docs/EVAL.md`. `--live` uses the configured provider and says so in the report header (`cortex: live groq/<model>`); `--limit N` samples N items per section (a free tier's quota is small); a Groq run writes `docs/EVAL.groq.md` so the committed offline report is never overwritten |
| `pnpm bench [--live] [--limit N] [--out file]` | per-stage latency benchmark → `docs/LATENCY.md`, `docs/latency.csv` (a Groq run writes `docs/LATENCY.groq.md`) |

## What is verified, and what is not

**Verified here** (890+ automated tests, `pnpm test`; the browser UI and the offline pipeline were also exercised end to end, see `docs/STATUS.md`): the cortex pipeline end to end on the problem statement's own examples (stitching, self-repair, asides, retraction, recurring-concern suggestion, cross-session reference, recall); AES-256-GCM encryption, per-day-key crypto-shredding, cascade deletion, TTL expiry; pause/forget/purge and the hash-chained audit; device pairing and the origin guard over real WebSockets; the Claude backend against a faithful Messages-API streaming fake (partial cards, cache usage, redaction round-trip, auth/rate-limit/refusal/timeout degradation, strict-schema fallback); the Groq backend against a faithful chat-completions fake that enforces Groq's real admission rule (one-chunk and token-by-token answers, repair retry, every degrade path, pacing per model, redaction round trip, local-only blocking every path, the key never leaving the server) and, measured on a free key, `docs/EVAL.groq.md`; the Wispr streamer against a fake WebSocket.

**Not verifiable without credentials/devices, and therefore labelled unverified:** the real Claude API behaviour and latency (`pnpm eval --live`, `pnpm bench --live` with an Anthropic key; with only a Groq key they produce the clearly labelled `*.groq.md` reports instead), the real Wispr WebSocket (assumptions listed in `apps/web/src/audio/README.md`), microphone/VAD behaviour on real whispers, phone background behaviour, real battery deltas.

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
