# V1 progress log

Plan: [docs/V1_PLAN.md](V1_PLAN.md). Branch `v1` (cut from `main` at 961283c).

## Current
Phase 1 (capture API, passcode auth, one-port serving, tunnel).

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

## Decisions
- Ruling: no `.env` is created by the run. The app's no-`.env` default is mock mode; settings the checks need are passed as process environment. Sayed explicitly declined the `.env` copy — cost if wrong: one `cp` for Sayed, listed in MANUAL_STEPS.
- Ruling: commit messages carry no AI attribution — Sayed's global CLAUDE.md forbids it and outranks the session default — cost if wrong: none.
- Ruling: the doctor command is `pnpm run doctor`, not `pnpm doctor`, because `pnpm doctor` is a pnpm built-in that shadows any script of that name — cost if wrong: none; docs say `pnpm run doctor`.
- Ruling: the timing-dependent Groq text-mode test was fixed in the test (slower fake stream), not in the product, because the 60 ms preview throttle is intended behaviour — cost if wrong: none.

## Blocked
(none)

## Test counts
| Phase | typecheck | tests |
|---|---|---|
| baseline | clean | 969 / 970 (1 timing failure) |

## Commits
| Phase | hash |
|---|---|
