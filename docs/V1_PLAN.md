# Synapse V1: build plan for Claude Code (unattended run)

> **How to use this file**
> 1. Do the 5-minute pre-flight in section A yourself.
> 2. Save this file in the repo as `docs/V1_PLAN.md`.
> 3. Start Claude Code in the repo with bypass permissions and give it this one message:
>
>    "Read docs/V1_PLAN.md fully and execute it end to end, Phase 0 through Phase 5, without stopping. Follow section B exactly. When everything is done, write the final report and the manual checklist, then stop."
>
> When you come back, open `docs/V1_REPORT.md` and do only what `docs/MANUAL_STEPS.md` lists.

---

## A. Pre-flight (Sayed does this before starting; about 5 minutes)

Everything that needs a human, a secret or an account happens here, so the run never has to wait for you.

1. **Install tools:**
   ```
   brew install cloudflared gh
   gh auth login
   ```
   Log in to GitHub in the browser when prompted.
2. **Create a throwaway private repo** for real issue tests, so the run never creates issues in your real repos:
   ```
   gh repo create synapse-sandbox --private
   ```
3. **Create `.env`** in the repo root (`cp .env.example .env`) and fill in:
   ```
   SARVAM_API_KEY=...
   GROQ_API_KEY=...            # free key from console.groq.com/keys
   SYNAPSE_PASSCODE=...        # any passphrase you'll type on your phone
   GITHUB_SANDBOX_REPO=SayedZahur786/synapse-sandbox
   ```
4. **Keep the Mac awake and plugged in.** Either turn on "Prevent automatic sleeping when the display is off" in System Settings → Battery, or run Claude Code inside `caffeinate -i` (`caffeinate -i claude ...`).
5. **Work on a branch:**
   ```
   git checkout -b v1
   ```

If any of steps 1–3 are skipped, the run still completes using mocks and fakes; the missing pieces simply move to the manual checklist.

---

## B. Autonomy rules (Claude Code: read carefully)

You are running **unattended with bypass permissions**. Sayed is away. Nobody will answer questions until the end.

**Never stop to ask:**
- **Ambiguity:** pick the option most consistent with the product principles in section 0. Record it under "Decisions" in the progress log, and keep going.
- **Missing key, account, device or tool:**
  - finish the work with fakes and mocks
  - write tests against the fakes
  - add the live verification to `docs/MANUAL_STEPS.md`
  - continue
- **Something that genuinely blocks a phase:** for example a dependency that won't install after three different attempts.
  - implement around it (feature flag, fallback, stub with a clear TODO)
  - log it under "Blocked" with what you tried
  - continue with the next task
- **Failing tests:** fix them. If a fix takes more than about 45 minutes of attempts:
  - mark the test `.skip` with a comment `// V1-BLOCKED: <reason>`
  - log it
  - continue

  Never skip a test just to avoid work.

**Progress log, kept for resumability:**
- Maintain `docs/V1_PROGRESS.md` from the first minute. It records:
  - current phase and task
  - what is done
  - decisions made
  - blocked items
  - test counts per phase
  - commit hashes
- Update it after every completed task. If your context gets long or the session restarts, re-read this plan and `docs/V1_PROGRESS.md`, then resume from the first unfinished task.
- Use subagents for large, separable chunks (for example the `/capture` screen while you work on server routes) when it speeds things up.

**Safety limits (these hold even with bypass permissions):**
- **Git:**
  - work only on branch `v1`, committing after every phase (more often is fine)
  - **do not push**, force-push, rebase shared history, or delete branches
  - never commit `.env`, `data/`, keys, audio or `node_modules`
- **Filesystem:** stay inside this repo, except for `~/.cache` model downloads and `brew install` of a missing CLI tool. No `sudo`. No global npm installs beyond what `pnpm` needs.
- **Secrets:** never print, log, echo or commit key values. Redact them in all outputs. Read them only from `.env`.
- **GitHub:**
  - real API writes go **only** to `GITHUB_SANDBOX_REPO`
  - never create issues, comments or repos anywhere else
  - reading the user's repo list and commits (for profile import) is allowed
- **Other services:** never send email, messages or calendar invites to anyone. Deep links are generated and tested as URLs, never opened in a way that sends.
- **Cost:** Sarvam and Groq calls are capped at about 50 each for the whole run. Prefer fakes in unit tests; use live keys only for the smoke checks this plan names.

**Automating the "manual" checks you can't do by hand:**
- **Synthetic speech on the Mac** (for live Sarvam checks):
  ```
  say -v Samantha "<text>" -o /tmp/s.aiff
  afconvert -f WAVE -d LEI16@16000 /tmp/s.aiff /tmp/s.wav
  ```
  For a basic Hinglish check, use `say` with an Indian English voice (`say -v '?'` lists the available voices).
- **Phone simulation:** Playwright Chromium with mobile emulation (Pixel 7 viewport, touch, Android user agent), plus Chrome flags `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=/tmp/s.wav`. This lets the `/capture` flow record "real" audio with no human. The repo already has related tooling in `apps/web/scripts/voice-smoke/`.
- **Offline simulation:** use Playwright `context.setOffline(true/false)`.
- **Tunnel:** if `cloudflared` is installed, actually start the quick tunnel and run the curl checks through the public URL; if not, test through `localhost` and log the tunnel check as manual.
- **Screenshots:** capture with Playwright at 1440×900 and 390×844. Save to `docs/screenshots/v1/` and look at them yourself to catch layout problems.

---

## 0. Read this first

You are working on **Synapse** (this repo). It is a voice "second brain": the user rambles out loud, and Synapse turns the ramble into finished, shippable things (a GitHub issue, an email draft, a reminder, a note), ignores asides, remembers everything, and answers questions about the past.

The engine already exists and works: fragment stitching, a 13-class intent classifier, artifact drafting, corrections ("actually make it Friday", "scratch that"), encrypted memory, recall, and proactive suggestions. Sarvam speech-to-text is already integrated (`apps/server/src/wispr/sarvam.ts`). Typecheck is clean and about 970 tests pass.

**What is wrong today:** the product is unusable outside a demo.
- The server runs on the laptop and a phone can only reach it over the same Wi-Fi, so capture while walking is impossible.
- The UI is an engineering dashboard: 7 screens, internal IDs (`T-16`, `A-15`), latency numbers, `Staged L2`, score rings, "mock" chips.
- The cards don't hand off to real apps cleanly.
- There is no setup flow, and personal context (repos, teammates) lives in `.env`.

**V1 goal:** one complete, real loop.

```
Android phone, anywhere on 4G:  tap → talk → tap
  → audio uploaded to POST /api/capture (queued if offline)
  → Sarvam STT → existing engine
  → cards: GitHub issue · Email draft · Reminder · Note   (asides ignored)
  → one-tap ship: real GitHub issue, prefilled Gmail/mail draft, prefilled calendar event
The laptop shows the same cards live and is the main review-and-ship screen.
```

**Product principles (apply them in every phase):**
1. **The user never picks a destination before speaking.** The engine routes by meaning.
2. **One ramble can become many items.** One breath with a bug, an email and a reminder becomes three cards.
3. **Hand off, don't hold.** Ship into the apps people already use, through prefilled deep links or real APIs. Synapse is a router, not another notes app.
4. **Draft-first.** Nothing reaches another human without a tap.
5. **Ask instead of guess.** When routing needs a fact the system doesn't have (which repo, someone's email, what time), the card asks one question with tap-able options. Each answer is remembered so the same question is never asked twice.
6. **Zero required setup.** Every setup step is skippable; the profile fills in from imports and from answered questions.

## 1. Ground rules

- Read `README.md`, `CLAUDE.md`, `docs/ARCHITECTURE.md` and the relevant parts of `docs/TRD.md` before changing code. Reuse existing modules; do not rewrite the engine.
- **The machine is now a MacBook Air (Apple Silicon, macOS, zsh).** `CLAUDE.md` still describes Windows/PowerShell; update its Environment section in Phase 0.
- Keep the non-negotiables in `CLAUDE.md`:
  - audio is never written to disk
  - keys never reach the browser
  - draft-first
  - user content is encrypted at rest
  - no plaintext user content in logs
- **TypeScript strict.** Zod schemas in `packages/shared` remain the single source of truth for the protocol and artifacts.
- **Hide, don't delete.** Existing features that leave the main navigation (Graph, Lab, Privacy Center) stay reachable from Settings. Update tests that break because of intentional UI changes; never delete a test just to make the suite pass.
- **Every phase ends green:** `pnpm typecheck`, `pnpm test`, plus the automated check listed for that phase.
- **Commit at the end of each phase** on branch `v1` with a clear message (`V1 phase N: ...`), then **continue straight to the next phase**. Never commit `.env` or anything under `data/`.
- When you need a fact about an external API (Sarvam, GitHub, Groq, Cloudflare), check its current docs rather than guessing. Sarvam docs: https://docs.sarvam.ai (index at https://docs.sarvam.ai/llms.txt).
- **Do not stop between phases.** Section B governs everything about blockers and decisions.

---

## Phase 0: Run it for real and add `pnpm doctor`

**Goal:** the existing app runs on this Mac with a real speech engine and a real LLM, and a single command explains what is missing.

**Tasks**
1. Install and run: `pnpm install`, copy `.env.example` to `.env`, run `pnpm dev`. Fix anything that fails on macOS arm64 and record what you fixed.
2. Configure the real stack in `.env` (it already exists from pre-flight; only add or adjust non-secret settings):
   - `WISPR_MODE=sarvam` if `SARVAM_API_KEY` is set
   - `LLM_MODE=live` if `GROQ_API_KEY` is set
   - `EMBEDDINGS=model`

   If a key is missing, use mock mode for that part and add it to `docs/MANUAL_STEPS.md`. Never print keys.
3. Add **`pnpm doctor`** (`apps/server/src/cli/doctor.ts`). It prints a checklist with ✅ / ⚠️ / ❌ and a one-line fix for each item:
   - Node ≥ 22.12, pnpm 10, and `.env` present
   - **Sarvam key valid:** send 1 s of silence as a 16 kHz WAV through the existing `SarvamStt`; treat an auth error as ❌
   - **Groq key valid:** `GET /models`
   - **Embedding model:** cached, or downloadable
   - **GitHub:** a token is found (`GITHUB_TOKEN`, or the output of `gh auth token` if the `gh` CLI is installed) and the token can read `/user`
   - `cloudflared` is installed (needed in Phase 1)
   - `SYNAPSE_PASSCODE` is set (needed in Phase 1)
4. Smoke test the engine with typed input, by script or Playwright through the real UI, using this exact ramble:
   > "That bug from yesterday... the null pointer in cart service, probably the discount code. Oh, and email the team that the launch moves to Friday. Remind me to call the landlord tomorrow at 6. Wait, was that my phone?"

   Record what cards appear, their categories, whether they came from the live model (`source: llm`), and whether the aside was filtered. Note every place the result is wrong in `docs/V1_PROGRESS.md`; Phase 3 fixes these.
5. If `SARVAM_API_KEY` is set, also run the ramble as synthetic speech (`say` + `afconvert`, section B) through the existing Sarvam path, and record the transcript quality.

**Done when:**
- `pnpm doctor` runs and is accurate.
- The ramble produces cards, from the live model if a key exists.
- The results are logged.

---

## Phase 1: Capture API, passcode auth, one-port serving, tunnel

**Goal:** any client (the phone today, an iPhone Shortcut or Mac app later) can send text or audio to one endpoint, over the internet, securely.

### 1a. `POST /api/capture`

Request (JSON or multipart):
```ts
{
  text?: string;           // already-transcribed text (web box, Wispr Flow, iPhone Shortcut later)
  audio?: File;            // 16 kHz mono WAV (multipart field "audio"), max ~5 min / 25 MB
  context?: {              // optional now, used by the Mac app and Shortcut later
    source: "android" | "web" | "mac" | "ios" | "cli";
    app?: string;          // frontmost app on desktop
    repo?: string;         // "owner/name" if known (e.g. the git repo open in the editor)
    url?: string;
  };
  clientId?: string;       // idempotency key, so a retried offline upload is processed only once
  capturedAt?: number;     // ms epoch when the user spoke (offline uploads arrive later)
}
```

Response:
```ts
{ captureId, transcript, thoughtIds: string[] }
```
The response returns after the engine finishes, with a timeout of about 15 s. Cards also stream to every connected client over the existing WebSocket.

**Implementation notes:**
- **Audio path:** parse WAV to Float32 at 16 kHz and pass it to the existing `SarvamStt.transcribe` (it already chunks at 28 s). Audio stays in memory and is zero-filled afterwards, the same as the existing local-STT path. Record the call in the privacy ledger like the existing Sarvam path does.
- **Text into the engine:** feed text through the same path as `/api/dev/inject` (`engine.handleFragment`), which you can refactor into a shared function.
  - First check how the engine handles one long fragment that contains several intents.
  - If it doesn't split reliably, split the transcript into sentence-sized fragments with short, realistic `pauseBeforeMs` values, the same way the replay tooling does.
  - **Acceptance check:** the Phase 0 ramble sent as one block yields separate bug, email and reminder items, with the aside dropped.
- **Speech before text:** run the existing control-intent check first, so a spoken "pause memory" or "forget what I said about X" still works when it arrives via capture.
- **Context:** store `context` on the fragment or session so later phases can use `context.repo` for routing.
- **Idempotency:** if `clientId` has already been processed, return the stored result.

### 1b. Passcode auth (replaces LAN pairing for remote access)

- New env `SYNAPSE_PASSCODE`.
- `POST /api/auth/login { passcode }` sets an HttpOnly, Secure, SameSite=Lax cookie holding an HMAC session token valid for 90 days. `POST /api/auth/logout` clears it.
- `GET /api/auth/capture-token` returns a long-lived **capture-only** bearer token. It is allowed only on `POST /api/capture`, and is for the iPhone Shortcut and Mac app later. Rotating it is possible from Settings later.
- **Every** `/api/*` route, the WebSocket and the `/local-stt/*` endpoints require a valid session, except `/api/health` and `/api/auth/*`. Rate-limit login attempts.
- **Loopback exemption:** today, loopback requests are trusted (see `gateway/trust.ts`). Behind a tunnel, remote requests can arrive from loopback.
  - When a tunnel or `PUBLIC_URL` is active, **do not trust loopback**: require the session for everything.
  - Write a test that proves a request arriving through the tunnel path without a cookie gets 401.
  - Keep the existing pairing code for LAN-only use, or replace it with the passcode if that is simpler. Explain the choice in the report.
- **Origin guard:** `isAllowedOrigin` currently refuses public origins. Allow exactly the active public URL's origin; never a wildcard.

### 1c. One port, production build

- Add `pnpm start`. It builds the web app and has the Fastify server serve the built SPA (with `@fastify/static` and an SPA fallback) on port 8787 alongside the API and WebSocket.
- A single origin keeps cookies, the service worker and the WebSocket simple through a tunnel.
- Keep `pnpm dev` working for development.

### 1d. Tunnel

- `TUNNEL=1 pnpm start` (or a `pnpm tunnel` script):
  1. spawns `cloudflared tunnel --url http://localhost:8787`
  2. parses the `https://*.trycloudflare.com` URL from its output
  3. tells the server (it becomes the active `PUBLIC_URL` for the origin guard)
  4. prints the URL plus a terminal QR code (`qrcode-terminal`)
- If `cloudflared` is missing, print `brew install cloudflared`.
- Document a named tunnel (stable URL) as an optional step in the README later; don't build it now.

**Tests (vitest):**
- WAV parsing
- capture with text
- capture with audio, against the existing `fake-sarvam`
- idempotency
- auth: 401 without a session, 200 with one, capture-token scope
- origin allowlist with a public URL
- the multi-intent split acceptance check

**Done when** (automated, results logged):
- `curl -F audio=@/tmp/s.wav -b cookie.txt <public-or-local-url>/api/capture` returns a transcript and thought IDs. Use real Sarvam if a key exists, otherwise the fake.
- A Playwright tab connected to the same server shows the cards appear live.
- Without the cookie, the same request gets 401.
- If `cloudflared` is installed, all of the above ran through the tunnel URL.

---

## Phase 2: Android capture app (`/capture`)

**Goal:** on a real Android phone over 4G, tap → talk → tap produces cards within a few seconds, even after a network drop.

**Tasks**
1. **New route `/capture`**, mobile-first.
   - One huge round record button and a timer while recording.
   - Below the button, "Your last captures" as compact result rows, e.g. "Made 3 things: GitHub issue · Email · Reminder", each with its ship button inline (the ship buttons themselves are built in Phase 3; render placeholders until then).
   - Set the PWA manifest `start_url` to `/capture`. Redirect `/pocket` to `/capture` (keep the Pocket component code; it just leaves the nav).
2. **Recording:**
   - Use `getUserMedia` plus `MediaRecorder`. On stop, decode with `AudioContext.decodeAudioData`, resample to 16 kHz mono with `OfflineAudioContext`, and encode a WAV in the browser.
   - Unit test the encoder and resampler.
   - Hold a screen wake lock while recording, and show "Keep the screen on while recording".
   - Do not promise background recording.
3. **Offline queue:**
   - Store pending clips in IndexedDB, each with a `clientId` and `capturedAt`.
   - Upload immediately when online; retry with backoff; flush on the `online` event and on app open.
   - Each pending row shows "Waiting for network", then "Sent".
4. **Manifest:**
   - Add an app shortcut "Capture" that opens `/capture?autostart=1` and starts recording after one tap (browsers require a gesture).
   - Add a **Web Share Target** that accepts audio files and text, so the user can share from any voice recorder or app into Synapse. Uploads go to `/api/capture`.
5. **Login screen:** passcode entry, shown when there is no session, then remembered for 90 days.
6. **Live capture stays laptop-only.** Live streaming via the existing streamer is not used on `/capture`.

**Done when** (automated with Playwright mobile emulation and a fake mic fed the synthetic ramble WAV, section B):
- Log in with the passcode, open `/capture`, tap record, wait for the clip, tap stop.
- Cards appear on the mobile page and in a second desktop page connected to the same server.
- With the context set offline, a recording shows "Waiting for network". After going back online, it uploads **exactly once** (assert one server-side capture for that `clientId`).
- The manifest validates (`start_url`, shortcut, share target) and the service worker registers on the production build.
- The real-phone install over the tunnel is added to `docs/MANUAL_STEPS.md`.

---

## Phase 3: Context profile, ask-cards, and usable outputs

**Goal:** the four V1 outputs ship into real apps with one tap, routed correctly using the user's context, and the system asks instead of guessing.

### 3a. Context profile (stored encrypted, like other user data)

```ts
Profile {
  name; timezone;                                   // timezone defaults to the browser's Intl zone
  repos: { fullName; aliases: string[]; isDefault: boolean; description?; topics?: string[] }[];
  people: { name; aliases: string[]; email?; phone?; githubLogin?; preferredChannel?: "email" | "whatsapp" }[];
  learned: { kind: "repo_alias" | "person_alias" | "person_email"; key; value; at }[];   // filled by answered ask-cards
}
```
`USER_TEAM` from `.env` becomes only an initial seed. The resolver and cortex read people from the profile. Expose `GET/PUT /api/profile`.

### 3b. Import with the least friction (all steps skippable)

1. **GitHub: one tap.**
   - Server-side, try `gh auth token` (the server runs on the user's Mac). If it finds a token: "Found your GitHub account @login. Use it?" → Yes.
   - Otherwise, a paste field for a fine-grained token, with a link and a one-line instruction ("Repository access: your repos · Issues: Read and write · Metadata: Read").
   - Store the token encrypted, server-side only.
2. **Repos: auto-suggested.**
   - `GET /user/repos?sort=pushed&per_page=30`.
   - Preselect the 5 most recently pushed and mark the most recent as the default. Seed aliases from the repo name split into words, plus its description and topics.
3. **Teammates: imported from commits.**
   - For the selected repos, read recent commits (`/repos/{r}/commits?per_page=100`) and contributors.
   - Collect author names and emails, excluding the user, bots and `noreply` addresses.
   - Preselect the people with the most commits. The user unticks anyone they don't want.
4. **Android contacts.** On Android Chrome, use the **Contact Picker API** (`navigator.contacts.select(['name','email','tel'], { multiple: true })`) through a "Pick from your contacts" button. Feature-detect it; hide the button where it's unsupported.
5. **Paste anything.** A textarea for a team list, CSV, vCard or a copied Slack member list.
   - Parse vCard and CSV directly; send free text to the LLM to extract `{ name, email, phone }`.
   - Always show the extracted list for confirmation before saving.
6. **Learn from use.** Every answered ask-card adds to `profile.learned`.

### 3c. Ask-cards (ask instead of guess)

- Add an optional `needs` list to artifacts:
  ```ts
  needs?: { field; question; options: { label; value }[]; allowFreeText: boolean }[]
  ```
  An artifact with open `needs` shows as **"Needs one answer"** and its ship button stays disabled until the needs are answered.
- Answering goes through `POST /api/artifacts/:id/answer { field, value }` (or a WebSocket message). It fills the field, saves the fact to `profile.learned`, re-renders the card, and makes it shippable.
- The existing calendar "Needs a time" UI is a starting point; generalize it.
- **When to ask** (only when needed to ship; never ask what can be inferred):
  - **GitHub issue, repo unknown:**
    1. Use `context.repo` if present.
    2. Otherwise use a repo or alias match in the text.
    3. Otherwise, if only one repo is selected, use it.
    4. Otherwise ask: "Which repo?" with the top 3 repos as options, ranked by alias or topic similarity to the thought.
  - **Email, recipient has no email address:** "Dev's email?" with free text, plus matching contacts as options. "The team" with no matching group asks for the recipients once and saves them as a group alias.
  - **Reminder, time missing or vague:** "When?" with options Tonight 9 pm, Tomorrow 9 am, This weekend, and Pick… (use the profile timezone).
  - **Ambiguous person:** two Devs → "Which Dev?"

### 3d. Outputs: four V1 types, each with one primary action

| Type | Primary action | Implementation |
|---|---|---|
| **GitHub issue** | **Create issue** | If a GitHub token is connected, create the issue for real (extend the existing outbox code to take the repo from the artifact, not one global `GITHUB_REPO`) and show "Created #123 ↗". Otherwise open `https://github.com/{repo}/issues/new?title=…&body=…&labels=…`. Body includes a summary, what was observed and a suspected cause, plus "Captured by voice with Synapse". |
| **Email draft** | **Open draft** | Mobile: `mailto:` (opens the default mail app, such as Gmail). Desktop: Gmail compose `https://mail.google.com/mail/?view=cm&fs=1&to=…&su=…&body=…`. A setting picks Gmail web or the default mail app on desktop. Secondary action: Copy. |
| **Reminder** (NEW artifact kind) | **Add to calendar** | Schema `{ kind: "reminder", what, dueAt (ISO), dueText, recurrence? }`. Opens a Google Calendar template link (`calendar.google.com/calendar/render?action=TEMPLATE&text=…&dates=…`, 15 min block). Secondary action: `.ics` download with a VALARM. The engine must produce this kind for "remind me…" style thoughts (add it to the cortex prompts, the lite prompt, the mock cortex, and the eval corpus). |
| **Note / Idea / Decision** | (none, saved) | Saved to memory and searchable in Ask. Secondary actions: Copy as Markdown, Forget. |

Everything else the engine produces keeps working but isn't promoted:
- **Message drafts:** show Copy plus a WhatsApp `https://wa.me/?text=…` link.
- **Code snippets:** Copy.
- **Jira:** stays behind its existing env config.

### 3e. Quality fixes from the Phase 0 smoke test

- Fix every wrong result you recorded in Phase 0.
- **Duplicate cards:** the seeded data produced two "Which auth approach?" decision cards for one thread. Make sure the same decision across fragments updates one card.
- **Title rewriting:** a card title must never just echo the sentence. With the live model, titles are rewritten (e.g. "Null pointer in cart-service discount code"). With the offline cortex, at least trim the filler words.

**Testing GitHub without touching real repos:**
- Unit and integration tests run against a **fake GitHub API server**, which you write (it records requests).
- Profile import may read the user's real repo list and commits through `gh auth token` (read-only).
- The one live issue-creation check targets `GITHUB_SANDBOX_REPO` only. If it isn't set, skip it and add it to the manual steps.
- For the purposes of the run, the sandbox repo is selected as the **default repo**, so the demo ramble files there. Sayed can switch the default later in Settings.

**Done when** (automated, through the Phase 2 Playwright mobile flow):
- The Phase 0 ramble produces:
  - **Bug:** a GitHub issue created with one tap. Live in the sandbox repo if configured (log the issue URL), otherwise against the fake.
  - **Email:** the generated `mailto:` and Gmail URLs decode to the right recipient, subject and body. If "the team" is unknown, one ask-card appears first; after it's answered, a second identical ramble asks nothing.
  - **Reminder:** the calendar URL encodes tomorrow 18:00 in the profile timezone, and the `.ics` parses with a VALARM.
  - **Aside:** dropped.
- Profile import, run against the user's real GitHub (read-only) if `gh` is logged in, populates repos and teammates. Log the counts only, not personal data.

---

## Phase 4: Laptop UI: Inbox, Ask, Settings

**Goal:** a first-time user understands the product in 10 seconds without reading anything.

**Tasks**
1. **Navigation becomes three items plus Settings:**
   - **Inbox** (`/`)
   - **Ask** (`/ask`, which replaces `/recall`; keep a redirect)
   - **Settings** (`/settings`)

   Settings has these tabs:
   - Profile & connections (Phase 3 imports)
   - Voice engine (Sarvam / on-device / Wispr / typed)
   - AI model (Groq / Claude / offline)
   - Privacy (the existing Privacy Center)
   - Memory map (the existing Graph)
   - Outbox history
   - Developer (the existing Lab, collapsed by default)
2. **Inbox layout, top to bottom:**
   - **Capture bar.** A text box labelled *"Type, or hold your Wispr Flow key and talk"* (Wispr Flow types into it and Enter sends to `/api/capture`), plus a mic button for live Sarvam capture through the existing streamer.
   - **Needs you:** drafts and ask-cards, newest first.
   - **Done:** shipped items with links ("Created #123 ↗").
   - **Saved:** notes, ideas, decisions.

   The current three-column layout and the "Synapse rail" go away. Suggestions (reschedule, echo, contradiction) appear as a single dismissible banner at the top of Needs you.
3. **Card redesign rules:**
   - **Remove from the face of the card:**
     - IDs (`T-16`, `A-15`)
     - latency numbers, `mock` chips, score rings
     - autonomy levels (`Staged L2`)
     - "forgets in 70h 59m" and "Local heuristic classified this as…"
   - **The face of each card shows:**
     - a type icon and plain label ("GitHub issue", "Email draft", "Reminder", "Note")
     - the title, and 1–2 lines of content
     - destination details (repo, recipient, time)
     - one primary button, plus a small overflow menu with Edit, Copy, Forget and **"Why?"**
   - **"Why?"** opens the existing Trail and keep-reason information, renamed as *"What I heard"* and *"Why I made this"*.
4. **Session summary.** After a capture session goes quiet (or after an upload completes), show one summary line: "Captured 4 things · 2 need you".
5. **First-run setup** (shown once, every step skippable):
   1. Welcome: one sentence on what Synapse does, with the example ramble.
   2. Connect GitHub (Phase 3 import).
   3. People (commits, contacts, paste).
   4. Put it on your phone: a QR code of the public URL, plus "Add to Home screen" instructions.
   5. Try it: "Say or type: *Remind me to drink water at 4*" and watch the card appear.
6. **Status:** the top bar keeps one status pill (Listening / Paused / Offline / Not connected) and nothing else. Engine and model details move to Settings.
7. **Visual style:** keep the existing design tokens (graphite surfaces, single orange accent) and make sure everything works at 375 px on the phone.

**Done when:**
- Screenshots of Inbox (empty and with cards), Ask, every Settings tab, every First-run step and `/capture` exist at 1440 px and 390 px in `docs/screenshots/v1/`. You have looked at each one and fixed overflow, clipping and contrast problems.
- An automated test asserts that no default screen renders internal IDs (`/\b[TA]-\d+\b/`), millisecond timings or autonomy labels.

---

## Phase 5: README and demo

1. **Rewrite `README.md` as a product page.** Move the current README to `docs/ENGINEERING.md` and link to it. In order:
   1. what Synapse is (2 sentences)
   2. a 30-second GIF/screenshot placeholder
   3. what you can say and what you get (the four outputs)
   4. setup in 5 steps: install, `.env` (Sarvam + Groq + passcode), `pnpm doctor`, `TUNNEL=1 pnpm start`, scan the QR on Android
   5. a "Powered by Wispr Flow" section explaining Wispr dictation into the capture box
   6. privacy in 5 bullets
   7. a roadmap: Mac quick-capture with repo context, iPhone Shortcut, Slack/WhatsApp sending, a webhook output
2. **Write `docs/DEMO_V1.md`:** a 2-minute demo script, beat by beat.
   1. Phone outside on 4G: tap the icon and speak the Phase 0 ramble plus "actually make it 7".
   2. The phone shows 3 cards, with the reminder now at 7.
   3. Laptop: the same cards are already there.
   4. Create issue: the real issue appears on GitHub.
   5. Open draft: the prefilled Gmail opens.
   6. Add to calendar: the event opens.
   7. Ask: "what was that cart bug?" returns a cited answer.
3. **Rehearse the demo automatically** with the Playwright mobile + desktop flow (synthetic speech including "actually make it 7"). Record a video with Playwright's `recordVideo` into `docs/screenshots/v1/demo-rehearsal.webm` and list anything flaky.
4. **Final full verification:** `pnpm typecheck`, `pnpm test`, `pnpm doctor`, `pnpm build`, and a clean-clone check. Clone the `v1` branch into a temp dir, then `pnpm install` and `pnpm test` there, so missing files or committed secrets show up.

---

## 9. Final deliverables (write these at the very end, then stop)

### `docs/V1_REPORT.md`
1. **Summary:** what Synapse V1 does now, in 5 lines.
2. **Per phase:** what changed (5–15 bullets), test counts, and the commit hash.
3. **Verification evidence:** doctor output, curl outputs, live Sarvam/Groq/GitHub results, and links to screenshots and the rehearsal video (all secrets redacted).
4. **Decisions made:** everything this plan didn't specify, with one-line reasons.
5. **Blocked, skipped and flaky:** every `V1-BLOCKED` item and what was tried.
6. **Known gaps vs. this plan,** honestly.
7. **Recommended next steps** for V2.

### `docs/MANUAL_STEPS.md`
Only what truly needs Sayed, as a numbered checklist. Each item has:
- the exact command or tap sequence
- the expected result
- what to do if it fails

It must at least cover:
1. any key or tool that was missing
2. **real Android phone:** start `TUNNEL=1 pnpm start`, scan the QR, log in, Add to Home screen, record the demo ramble outdoors on 4G, check the cards on phone and laptop
3. one tap of **Create issue** to the sandbox repo from the phone
4. opening the email and calendar deep links on the phone
5. switching the default repo from the sandbox to a real repo in Settings, if wanted
6. pushing the branch: `git push -u origin v1`, and opening a PR, since the run never pushes

Keep it short. If something could be automated, it should not be on this list.

After writing both files and the final commit, print a 10-line summary and stop.
