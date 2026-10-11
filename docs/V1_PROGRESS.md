# V1 progress log

Plan: [docs/V1_PLAN.md](V1_PLAN.md). Branch `v1` (cut from `main` at 961283c).

## Current
**V1.1 run** (2026-10-11, second unattended run): Phase 3 (always-on Mac server, permanent free URL). Phases 1–2 done. V1 itself is done: [V1_REPORT.md](V1_REPORT.md).

## V1.1 pre-flight (verified, not assumed)
- `.env`: Sarvam + Groq keys, `GITHUB_SANDBOX_REPO=SayedZahur786/synapse-sandbox`, `LLM_MODE=live`, `WISPR_MODE=sarvam`. **Passcode is 8 digits (not 12+), kept as chosen** → MANUAL_STEPS; doctor warns.
- Tailscale 1.102.2 installed and signed in but was **stopped**; the run brought it back up with the existing flags (`tailscale up --accept-routes`). **Funnel is not enabled on the tailnet** (`tailscale funnel 8787` prints an approval link) → MANUAL_STEPS. Stable URL once approved: `https://sayeds-macbook-air.tail351c98.ts.net`.
- ngrok: not installed; it needs an account + authtoken (sign-up is off limits) → not used.
- So the live public URL for this run is the **cloudflared quick tunnel** (temporary).
- Mac sleeps after 1 min on AC (`pmset`: AC sleep 1) → MANUAL_STEPS; the run uses `caffeinate -i -s` only for itself.
- `gh` logged in as SayedZahur786.

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

### Phase 2
- `/capture` (`screens/Capture.tsx`, `styles/capture.css`): one big round button, timer, "Keep the screen on while recording", an "Or type it" box, "Your last captures" rows ("Made 3 things: GitHub issue · Email · Note") with per-clip status (Waiting for network / Sending… / Sent / Could not send + discard). No nav, no top bar; the socket still runs so cards arrive live. `/pocket` redirects to `/capture` (Pocket code kept); nav item renamed Capture.
- Recording: `capture/recorder.ts` (getUserMedia + MediaRecorder, screen wake lock) → `decodeAudioData` → OfflineAudioContext resample to 16 kHz mono (linear fallback) → WAV (`capture/wav.ts`, tested).
- Offline queue `capture/queue.ts`: clips sealed with AES-GCM under a non-extractable WebCrypto key into IndexedDB, uploaded when online, backoff 2/5/15/30/60 s, flush on `online`, visibility and app open; 401 pauses the queue and shows the sign-in; 400/413 are final; deleted from the phone once acknowledged. Tested (exactly-once under concurrent flushes, restore on reopen, ciphertext only).
- `capture/upload.ts`: multipart to `/api/capture` with clientId, capturedAt, context.source (android / ios / web from the UA).
- Manifest: `start_url /capture`, shortcut "Capture" → `/capture?autostart=1`, Web Share Target (`POST /capture/share`, audio files + text) handled by `public/share-target.js` imported into the Workbox service worker; shared files stay in worker memory only, the page decodes them to WAV and queues them.
- Passcode sign-in screen (`components/LoginScreen.tsx`, `state/auth.ts`) gating the app; an unreachable server does not block (the phone records into its queue offline).
- The live-mic engine is no longer preloaded on `/capture`.
- Audit test for the capture path (storage only in the queue and only sealed; audio sent only by upload.ts to `/api/capture`; share target memory-only).

### Phase 2 evidence (Playwright Chromium, Pixel 7 emulation at 390×844, fake mic playing the synthetic ramble WAV, through a real tunnel)
`node scripts/e2e/phase2.mjs <tunnel> <wav> docs/screenshots/v1` → signed in with the passcode; service worker active; record 13.5 s → stop → **"Made 3 things: GitHub issue · Email · Note" 0.5 s after stop** (fake Sarvam + mock cortex); the **desktop tab showed the same cards**; offline recording showed **"Waiting for network"**, server had **0** captures for its clientId while offline and **exactly 1** after going online; manifest `start_url /capture`, shortcut `/capture?autostart=1`, share target `POST /capture/share` (files: audio). Screenshots: `docs/screenshots/v1/capture-*-390.png`.

### Phase 3
- New artifact kind `reminder` {what, due_iso, due_text, recurrence} in the shared schema, both prompts (Claude + Groq lite), Groq empty-defaults, eval mapping and 5 new eval items. Offline cortex: `cortex/reminder.ts` (bare hour 1–7 = pm, day without time = 09:00, past → tomorrow; "make it 7" keeps the day, "make it Friday" keeps the time). Timed reminder = scheduling, untimed = action.
- Quality fixes from Phase 0: issue body without internal ids or "(re: …)", footer "Captured by voice with Synapse"; email body says the thing ("The launch moves to Friday.", no "[add details]"), subject from the clause; titles no longer echo the sentence ("Call the landlord", "Email the team: the launch moves to Friday"). A correction finds the right card when one capture makes several thoughts in the same millisecond (tie-break on T-n).
- Duplicate decisions: the same decision continued in a new thread (same question, a shared option/component, or close embedding) joins the earlier card and is re-analysed whole (`engine.mergeInto`).
- Context profile (`profile/service.ts`): sealed with the long-term key, seeded once from USER_TEAM / TIMEZONE / GITHUB_SANDBOX_REPO; people pinned as entities; the cortex reads the team from it; learned facts (newest per question). `GET/PUT /api/profile`, `/merge`, `/parse` (vCard, CSV, "Name <email>", loose lines; the model for free text when one is configured).
- GitHub (`profile/github.ts`): saved token (sealed) > GITHUB_TOKEN > `gh auth token` (offered, saved only on "Use it"); `/api/github/{status,use-gh,token,import}`; import = 30 newest repos (5 preselected, newest default, aliases from name words + topics), teammates from the preselected repos' commits without the user, bots and noreply.
- Routing (`routing/router.ts`, pure, 17 tests; `routing/service.ts`): repo = answer > capture context > name/alias in speech > learned alias > only repo > default repo > ask "Which repo?" (top 3); email = address > answer > learned > profile (one / "Which Dev?" / "Dev's email?"), "the team" asks once and is saved as a group; reminder/event = answer > speech > ask "When?" (Tonight 9 pm / Tomorrow 9 am / This weekend / free text). Answers stored on the artifact (migration v3 `route_enc`, sealed with its key) and learned. Views carry `route`, `needs`, `links`, `canCreate`. `POST /api/artifacts/:id/answer`, `/shipped`.
- Handoffs: GitHub new-issue URL; mailto + Gmail compose; Google Calendar template (15 min, UTC dates, ctz) + `.ics` with VALARM; WhatsApp `wa.me`. Real issue creation goes to the routed repo through the connected account (`GITHUB_API_URL` lets tests use a recording fake). Autonomy L3 only auto-creates issues in the sandbox repo (a team repo notifies people).
- Web: `ShipCard` (label, destination, preview, ask block with option chips + free text, ONE primary action, done state "Created #1 ↗ / Opened in Gmail / Added to calendar", copy / .ics / forget), used on `/capture`; `lib/ship.ts` tested.

### Phase 3 evidence
- `node scripts/e2e/phase3.mjs <tunnel> <wav> <fake-github-peek>` (Pixel 7 emulation, fake mic, fake Sarvam, fake GitHub as `SayedZahur786/synapse-sandbox`): 3 cards (aside dropped); **Create issue** → "Created #1", filed in the sandbox repo with the footer and no internal ids; email asked **"Who is “the team”?"** with Open draft disabled, then enabled; mailto and Gmail decode to `sarah@acme.io,dev@acme.io`, "The launch moves to Friday", the full body; reminder **2026-10-12T18:00:00+05:30** (tomorrow 18:00 IST), calendar dates `20261012T123000Z/…124500Z`, `.ics` with VALARM; a **second identical ramble asked nothing**; "Actually make it 7." → **19:00**. Screenshots `docs/screenshots/v1/capture-{cards,ask,second-ramble}-390.png`.
- Real GitHub import, read-only via `gh auth token` (`scripts/e2e/import-check.ts`, counts only): 30 repos (5 preselected, 1 default), 16 teammates with email (8 preselected), 4.7 s. Two earlier attempts timed out on the network (transient).
- No live issue was created: `GITHUB_SANDBOX_REPO` is not configured (→ MANUAL_STEPS).
- Offline eval: dev set 100% (69 threads); held-out 87.3% macro-F1, **identical to `main`** on this machine (checked in a temporary worktree; the committed EVAL.md is older).

### Phase 4
- Navigation: **Inbox** (`/`) · **Ask** (`/ask`) · **Settings** (`/settings/:tab`). Redirects: `/recall`→`/ask`, `/privacy`→`/settings/privacy`, `/graph`→`/settings/memory`, `/outbox`→`/settings/outbox`, `/lab`→`/settings/developer`, `/pocket`→`/capture`. Desk, Pocket, rail and stream code kept (unrouted).
- Inbox (`screens/Inbox.tsx`): capture bar ("Type, or hold your Wispr Flow key and talk", Enter → `/api/capture`) + live-mic button; one dismissible suggestion banner (draft-ready suggestions skipped: they repeat a card); session line "Captured 3 things · 3 need you" once the newest session is quiet; Needs you / Done / Saved (`lib/inbox.ts`, tested: newest capture first, spoken order inside a capture).
- Cards: `ShipCard` everywhere: icon + plain label, title, 1–2 lines, destination, ask block, ONE primary action, overflow menu Edit · Copy · Download .ics · Why? · Forget. "Why?" = "What I heard" (the fragments) + "Why I made this" (classifier phrasing rewritten in plain words) + why it was kept. No ids, timings, mock chips, score rings or autonomy levels on the face.
- Settings tabs: Profile & connections (GitHub connect: saved / .env / "Found your GitHub account @x. Use it?" / paste a token; import repos + teammates with ticks and a default; contact picker (feature-detected); paste a list → confirm; people, repos, default, email app, timezone; sign out), Voice engine, AI model (both with the local-only switch), Privacy, Memory map, Outbox history, Developer (Lab, collapsed).
- First-run setup (`components/Onboarding.tsx`), shown once, every step skippable: Welcome · GitHub · People · Your phone (QR of the public URL + Add to Home screen steps, or how to start the tunnel) · Try it ("Remind me to drink water at 4" → the card appears). `ClientConfig.publicUrl` added.
- Top bar: one status pill (Listening / Paused / Offline / Not connected / Ready).
- Ask: citations and sources numbered 1, 2, 3 (never T-n); timings removed.

### Phase 4 evidence
`node scripts/e2e/phase4.mjs <tunnel> docs/screenshots/v1` → **34 screenshots** (Inbox empty and with cards, Why?, Ask, 7 Settings tabs, 5 first-run steps, /capture; each at 1440 and 390), **0 violations**: no internal ids, ms timings, autonomy labels or "mock" on Inbox, Ask, Settings (default tab) and /capture; no horizontal overflow on any screen at either width; no page errors. Reviewed by eye; fixed after the first pass: an inverted QR code (some scanners fail), a banner duplicating the email card, cards of one capture shown in reverse, "Recall"/"Desk" copy on Ask.

### Phase 5
- README rewritten as a product page (old one → `docs/ENGINEERING.md`, links fixed); `docs/DEMO_V1.md`; Settings shows the capture-only token.
- `scripts/e2e/rehearse.mjs`: the demo on an emulated Pixel 7 (synthetic voice ending "actually make it 7") + a desktop browser, Gmail/Calendar intercepted, video recorded (`docs/screenshots/v1/demo-rehearsal*.webm`, video only). 8/8 beats in 3 runs (once after the review fixes).
- Final: typecheck clean, 1105/1105 tests, `pnpm build`, `pnpm run doctor`, clean clone of `v1` (frozen install, 1105/1105, typecheck, no secrets / env / data / audio).
- Tests now use the repo's model cache (a leftover `D:/goa-hack/data` default had created `apps/server/D:/…`, git-ignored, not deleted).

### Final review (fresh-context reviewer, opus) and fix pass
- Critical: percent-encoded `/%61pi/...` skipped the auth hook → fixed (matched route + decoded path), `review-fixes.test.ts` RED→GREEN, suite 1105/1105.
- Important, all fixed RED→GREEN: spoofable login limit (Cloudflare client address, global cap, pruning, 8+ char passcode for public mode); routing answers lost on restart (loaded into the wrong table); retry during processing got an empty duplicate; "tonight" → 9 am and past stated times; wipe-all/export missing the profile + GitHub token.
- Minor re-graded to Important and fixed: one undecryptable phone clip blocked the whole queue; a hand-run tunnel without PUBLIC_URL trusted loopback (now any request with Cloudflare headers needs a session).
- Final: minor (deferred): mergeInto double-counts moved fragments in the centroid.
- Final: minor (deferred): /shipped and /answer accept any status (can overwrite a real issue ref).
- Final: minor (deferred): migrations v2/v3 are not transactional.
- Final: minor (deferred): whenOptions weekday in UTC+13/14 and DST hour; "remind me at noon to eat" → "At to eat".
- Final: minor (deferred): contextFor unindexed scan, twice per view.
- Final: minor (deferred): sessions cannot be revoked server-side; open WebSockets not re-checked.
- Final: Ruling: the reviewer's "declined to judge" items (encrypted IndexedDB queue, mark-shipped-on-tap, default repo before asking, Secure-on-https cookie, LAN pairing kept) stand as ruled above — cost if wrong as stated per ruling.

## V1.1
### V1.1 Phase 1: card quality on Groq's free tier
- **One call per capture** (`llm/batch.ts`, `cortex/prompts-batch.ts`): the whole transcript (redacted) goes to Groq once; the answer `{items:[{said, category, title, intent, confidence, artifact, repairs, entities, corrects}]}` is zod-validated (one repair round); each item becomes a one-fragment thread whose result is handed to the engine through a `PresetBackend` (no second call). In-capture corrections are applied inside the item; a correction or retraction of an EARLIER card names its code (`corrects: "T-3"`), which the engine now resolves directly. Asides come back as aside items (counted, dropped). On failure: the existing segmenter + per-thought path. Prompt + transcript + 1600-token allowance < 4.5k tokens (tested). The live mic keeps its streaming per-thought path.
- **Waiting for budget:** the capture call may queue `GROQ_CAPTURE_MAX_WAIT_MS` (25 s); the live mic keeps `GROQ_MAX_WAIT_MS` (2 s).
- **Re-draft queue** (`cortex/redraft.ts`): offline drafts degraded for paced / rate_limit / timeout / network are re-drafted in place when the bucket has room (≥3.5k tokens), one at a time, max 5 attempts; `improving` on the view ("improving…" on the card). Shipped, opened, dismissed or hand-edited cards are never overwritten (`artifact.edited` bus event). Same thought, never a duplicate (tested through the real app).
- **Offline model fix:** the segmenter splits comma-joined intents (", oh, and", ", and also", ", oh and", ", plus", ", also" before an action; lists are not split); an explicit "email/tell/message X…" is a confident communication item. The exact transcript real Sarvam produced now gives issue / email draft / reminder at 7.
- **"Double upload":** not an idempotency bug. `scripts/e2e/phase1.mjs` sent an unauthenticated probe upload (accepted on localhost) plus the real one, neither with a clientId. The probe is now a read (`GET /api/state`) and the upload carries a clientId. Same-clientId idempotency was already covered by tests.
- Tests: batch (6), redraft (5), segmenter (+6), reminder/offline (+5). Suite 1135/1135.

### V1.1 Phase 2: fixes from review
- **Revocable sessions:** a session epoch (settings row) is part of the HMAC key, read on every check. `POST /api/auth/revoke-all` ("Log out all devices" in Settings → Profile & connections) and `pnpm run sessions:revoke` (works against a running server's database) end every session and the capture token; open WebSockets carry their session cookie and are closed (4001) on revoke and every 30 s check. Changing `SYNAPSE_PASSCODE` still invalidates everything.
- **Doctor:** warns when the passcode is under 12 characters or digits only (never prints it).
- **Idempotent actions:** a per-card push lock in the outbox: two concurrent "Create issue" taps file ONE issue (reproduced first: it filed two); a retried push of a created issue returns the card (200). `answer` refuses opened/executed/dismissed cards (409); `shipped` never overwrites a created issue (409) and is idempotent.
- **Default-deny auth:** public = exact routes (health, login, logout, status) + GET/HEAD of the static shell; everything that canonicalises to /api, /ws or /local-stt (decoded, slashes collapsed, `..` resolved, trailing dots dropped, lowercased) needs a session; any other method needs auth too. 17 spellings × GET/POST tested through the tunnel: all 401/404, never data.
- **Phone key:** confirmed AES-GCM 256, non-extractable (`exportKey` rejects); now pinned by a test.
- **"Opened" state:** new `opened` artifact status. Open draft / Add to calendar → "Opened in Gmail" with a one-tap **Done** (and "Open again"); Done → executed ("Sent from Gmail" / "Added to calendar"). Opened cards stay in Needs you. `POST /api/artifacts/:id/done`.
- **Migrations:** each step + its `user_version` bump in one transaction; v3's column add is idempotent (a half-applied v3 no longer bricks the database: reproduced first).
- Suite: web 724, server 421.

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

- Ruling: the offline queue keeps pending clips in IndexedDB as AES-GCM ciphertext under a non-extractable key and deletes them once acknowledged. The plan asks for IndexedDB, the non-negotiables say audio never touches disk; this keeps the offline queue working after the app is closed while never storing audio in the clear or after it is sent — cost if wrong: switch the queue to the in-memory store (one line in `capture/runtime.ts`), losing clips when the app is closed offline.
- Ruling: shared audio (Web Share Target) is held in service-worker memory, never in Cache Storage or IndexedDB, until the page takes it — cost if wrong: a share is lost if the browser kills the worker in the second between the share and the page opening.
- Ruling: `/capture` has an "Or type it" box as well as the mic button — typed and dictated text use the same queue — cost if wrong: one input to remove.

- Ruling: the default repo is used before asking "Which repo?" (order: answer > context > named > learned > only repo > default > ask). The plan lists "ask" after "only one repo" but also wants the demo to file into the default sandbox repo with one tap; with no default, it asks — cost if wrong: issues go to the default repo silently; the card always shows the destination before the tap.
- Ruling: answers live on the artifact (new `route_enc` column, sealed with the artifact's own key) and learned facts in the profile — cost if wrong: none for privacy (both encrypted).
- Ruling: link handoffs (Gmail, mail app, calendar) are marked shipped when tapped (`POST /shipped`), so the card moves to Done; Synapse itself sends nothing — cost if wrong: a draft the user then abandons shows as Done.
- Ruling: a GitHub issue is "self-only" for autonomy L3 only in the sandbox repo — draft-first; a real team repo notifies watchers.
- Ruling: teammates are read from commits only (not the contributors endpoint): commits carry names and emails, contributors only logins — cost if wrong: people with no recent commits are not suggested.
- Ruling: the old integration test that wanted the thought code (T-n) in the issue body was changed to assert the opposite (plan: no internal ids in anything other people read).
- Ruling: the Mac's idle sleep (1 min) froze the test run twice for ~4 min; the run now keeps it awake with `caffeinate -i -s` (pre-flight step 4 was not done).

- Ruling: the status pill has a fifth state, "Ready" (connected, mic off) — the plan's four states leave the normal idle state unnamed.
- Ruling: the "no internal ids" check runs in Playwright against the real UI (not a DOM-less unit test), on the screens a user lands on: Inbox, Ask, Settings' default tab, /capture. The Developer tab (Lab) still shows latencies by design.
- Ruling: engine and model are chosen in `.env` (as before); the Voice engine and AI model tabs explain the current choice and offer the local-only switch rather than editing `.env` from the browser.

- Ruling (V1.1): one call per capture is built for Groq only; with an Anthropic key the per-thought path stays (no free-tier budget problem there) — cost if wrong: more calls per capture on Claude.
- Ruling (V1.1): a batch item's "needs" are not taken from the model; questions stay computed by the deterministic router from the profile (tested, no hallucinated questions) — cost if wrong: none.

## Blocked
- On-device Whisper model download (`Xenova/whisper-tiny.en`) fails here: Hugging Face is unreachable from the run's sandbox (`fetch failed`). The embedding model was already cached. E2E audio runs use the fake Sarvam instead. On Sayed's normal shell this downloads once (MANUAL_STEPS).

## Test counts
| Phase | typecheck | tests |
|---|---|---|
| baseline | clean | 969 / 970 (1 timing failure) |
| 0 | clean | 978 / 978 |
| 1 | clean | 1021 / 1021 (web 683, server 338) |
| 2 | clean | 1041 / 1041 (web 703, server 338) |
| 3 | clean | 1091 / 1091 (web 710, server 381) |
| 4 | clean | 1095 / 1095 (web 714, server 381) |
| 5 | clean | 1095 / 1095 |
| review fixes | clean | 1105 / 1105 (web 715, server 390) |

## Commits
| Phase | hash |
|---|---|
| 0 | 522f703 |
| 1 | afdf10c |
| 2 | d8034ea |
| 3 | eb421bd |
| 4 | 85a874c |
| 5 | 356f739 |
| review fixes | 8386ef6 |
