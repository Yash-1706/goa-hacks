# V1 progress log

Plan: [docs/V1_PLAN.md](V1_PLAN.md). Branch `v1` (cut from `main` at 961283c).

## Current
Phase 2 (Android capture app `/capture`).

## Pre-flight state at start (2026-10-11)
- Branch `v1` created by the run.
- `cloudflared` installed by the run (`brew install cloudflared`, 2026.9.3), at Sayed's request.
- `gh` installed and logged in (@SayedZahur786).
- **No `.env`**: no Sarvam key, no Groq key, no `SYNAPSE_PASSCODE`, no `GITHUB_SANDBOX_REPO`. Sayed declined the sandbox repo creation and the `.env` copy for this run.

## Done
### Phase 0
- `pnpm install`: nothing to fix on macOS arm64 (lockfile up to date; native deps already resolved). `pnpm dev` boots: API on :8787, Vite on :5173, MiniLM cached in `data/models`, master key from the macOS keychain.
- Baseline: typecheck clean; 969/970 tests. The one failure (`groq-cortex` text-mode streaming) was timing-dependent: previews are throttled to one per 60 ms and the fake stream finished in ~150 ms on this Mac. Fixed by slowing the fake stream (test-only change).
- `pnpm run doctor` (`apps/server/src/cli/doctor-lib.ts` + `doctor.ts`, 8 tests): Node, pnpm, `.env`, Sarvam (1 s of silence through `SarvamStt`), Groq (`GET /models`), embedding model (cache, else Hugging Face reachability), GitHub (`GITHUB_TOKEN` or `gh auth token` → `/user`), cloudflared, passcode. No key value ever printed (asserted).
- CLAUDE.md Environment section updated for the Mac.

### Phase 0 smoke results (mock cortex: no Groq key, no Sarvam key)
The ramble: "That bug from yesterday... the null pointer in cart service, probably the discount code. Oh, and email the team that the launch moves to Friday. Remind me to call the landlord tomorrow at 6. Wait, was that my phone?"

| How it went in | Cards | Aside |
|---|---|---|
| One block via `/api/dev/inject` | **1 card**: `bug`, artifact `note` with the whole ramble as the body | not filtered (part of the block) |
| Sentences, fired back to back | **1 card**: `bug` / `github_issue`, but the email and reminder text are inside the issue body | filtered (1) |
| One closed thread per intent (replay with `endThread`) | `bug` → `github_issue` ✅ · `communication` → `email_draft` ✅ · `scheduling` → **`note`** ❌ | filtered ✅ |

All cards `source: mock` (no live model available). **Wrong results for Phase 3 to fix:**
1. A block containing several intents becomes one card: the engine never splits a single fragment; the stitcher joins short pauses. → Phase 1 capture needs an intent segmenter in front of the engine.
2. "Remind me to call the landlord tomorrow at 6" becomes a `note` (no reminder kind exists).
3. Issue body leaks internal IDs ("Related earlier note: T-2") and an odd "(re: Null pointer in cart-service)" suffix in the summary.
4. Email body is mechanical: "Quick note about the launch moves to Friday. [add details]"; recipient is the literal string `team`.
5. Reminder title echoes the sentence ("Remind me to call the landlord tomorrow at 6").
6. Synthetic-speech Sarvam check: skipped (no `SARVAM_API_KEY`) → MANUAL_STEPS.

### Phase 1
- `POST /api/capture` (JSON or multipart, 25 MB) → `capture/service.ts`: WAV → 16 kHz mono in memory (`capture/wav.ts`: PCM 8/16/24/32, float, EXTENSIBLE, any rate/channels), Sarvam when a key exists, on-device Whisper otherwise (always in local-only mode); zero-filled after. Ledger records `sent_to_stt` by length.
- `capture/segment.ts`: deterministic intent segmenter. Sentences, plus "… and <action> …" splits; a segment starts a new thought on an action lead (not aimed at a pronoun), a topic-shift lead, a correction or an interjection. Each new-thought segment closes the thread before it. Acceptance check passes: the demo ramble as ONE block → bug / email / reminder thoughts, aside dropped.
- Idempotency by `clientId` (stored in a new `captures` table, migration v2; detail sealed with the day key; no transcript stored: a retry rebuilds it from surviving fragments, so forgetting a thought also forgets it here). Concurrent retries coalesce. `GET /api/captures`. `capture.done` WS message.
- One stable device per source (`capture-android` …), one session per capture: a correction in a later capture finds its card.
- Paused memory → capture discarded unheard (`paused: true`, no STT call). Control intents ("pause memory") work via capture.
- Passcode auth (`gateway/auth.ts`): 90-day HttpOnly SameSite=Lax session cookie (Secure over https), HMAC keyed by a stored secret + the passcode; capture-only bearer token (`syn_cap_<gen>_<hmac>`, rotatable); login rate limit 5 / 15 min / address; `/api/auth/{login,logout,status,capture-token,capture-token/rotate}`.
- Tunnel/public mode: loopback no longer trusted, pairing codes refused, session required on `/api/*`, `/ws` and `/local-stt/*` (except health + login). Origin guard allows exactly the public origin.
- `pnpm start` builds the web app and the server serves it (`gateway/static.ts`, SPA fallback, immutable hashed assets, no-cache index/sw). `TUNNEL=1 pnpm start` / `pnpm tunnel` spawns cloudflared, parses the URL, activates it, prints URL + terminal QR; refuses without a passcode.
- E2E tooling: `scripts/e2e/` (Playwright with the cached Chromium, fake Sarvam runner, health waiter, phase checks).

### Phase 1 evidence (through a real cloudflared quick tunnel, fake Sarvam, mock cortex)
`node scripts/e2e/phase1.mjs https://guards-saving-intro-flip.trycloudflare.com <synthetic ramble WAV>`: no cookie → **401**; with session → **200 in 326 ms**; transcript = the ramble; cards: bug/github_issue, communication/email_draft, scheduling/note (aside dropped); all three **appeared live in a second signed-in desktop tab** (`docs/screenshots/v1/phase1-desk-live.png`).

## Decisions
- Ruling: no `.env` is created by the run. The app's no-`.env` default is mock mode; settings the checks need are passed as process environment. Sayed explicitly declined the `.env` copy — cost if wrong: one `cp` for Sayed, listed in MANUAL_STEPS.
- Ruling: commit messages carry no AI attribution — Sayed's global CLAUDE.md forbids it and outranks the session default — cost if wrong: none.
- Ruling: the doctor command is `pnpm run doctor`, not `pnpm doctor`, because `pnpm doctor` is a pnpm built-in that shadows any script of that name — cost if wrong: none; docs say `pnpm run doctor`.
- Ruling: the timing-dependent Groq text-mode test was fixed in the test (slower fake stream), not in the product, because the 60 ms preview throttle is intended behaviour — cost if wrong: none.

- Ruling: LAN pairing is kept for LAN-only use; the passcode works everywhere; in tunnel mode only the passcode session counts — least disruption to existing tests and flows, and a 6-digit code is brute-forceable over the internet — cost if wrong: one extra login on the laptop when a tunnel is up.
- Ruling: the session cookie is `Secure` only on https requests (tunnel, `x-forwarded-proto: https`) — a plain-http LAN browser would otherwise drop it — cost if wrong: none over the tunnel, where it is always Secure.
- Ruling: capture segments that start a new thought are fed with a 9 s virtual gap after closing the previous thread; continuations with 600 ms — mirrors how the replay tooling drives the stitcher — cost if wrong: an over-split thought; the segmenter tests pin the behaviour.
- Ruling: a speech-to-text failure answers 503, not 502 — Cloudflare replaced our JSON 502 with its own HTML page (observed through the tunnel) — cost if wrong: none.
- Ruling: added a `typed` fragment transport for text captures, instead of labelling them `mock`.
- Ruling: the audio audit (`no-audio.test.ts`) now allows `capture/wav.ts` and `capture/service.ts` to handle samples, under the same stricter rules as the on-device engine (no fs, no network of their own, must zero-fill) — the plan requires this path.
- Ruling: Playwright 1.64's own Chromium could not be downloaded (`cdn.playwright.dev` unresolvable from this sandbox); the e2e scripts fall back to the newest Chromium already in `~/Library/Caches/ms-playwright` (`PW_CHROMIUM` overrides).

## Blocked
- On-device Whisper model download (`Xenova/whisper-tiny.en`) fails here: Hugging Face is unreachable from the run's sandbox (`fetch failed`). The embedding model was already cached. E2E audio runs use the fake Sarvam instead. On Sayed's normal shell this downloads once (MANUAL_STEPS).

## Test counts
| Phase | typecheck | tests |
|---|---|---|
| baseline | clean | 969 / 970 (1 timing failure) |
| 0 | clean | 978 / 978 |
| 1 | clean | 1021 / 1021 (web 683, server 338) |

## Commits
| Phase | hash |
|---|---|
