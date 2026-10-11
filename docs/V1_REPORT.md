# Synapse V1: report

Branch `v1` (7 commits on top of `main` 961283c), not pushed. Plan: [V1_PLAN.md](dev/V1_PLAN.md). Day-by-day log with every decision: [V1_PROGRESS.md](dev/V1_PROGRESS.md). What only you can do: [MANUAL_STEPS.md](dev/MANUAL_STEPS.md).

## 1. Summary

1. On an Android phone you tap, talk and tap. The clip goes to `POST /api/capture` over a cloudflared tunnel, and waits encrypted on the phone if there's no signal.
2. Your Mac transcribes it (Sarvam, or Whisper on the Mac) and splits one ramble into one card per intent. Asides are dropped, and "actually make it 7" corrects the right card.
3. Each card has one button that hands off to an app you already use:
   - **Create issue:** a real GitHub issue in the routed repo, or a prefilled GitHub page.
   - **Open draft:** Gmail or your mail app.
   - **Add to calendar:** Google Calendar, or an `.ics` file with an alarm.
4. When a card needs a fact (which repo, whose address, what time), it asks once with tap-able answers and remembers the answer. Your repos and teammates import from GitHub in one tap.
5. The laptop has an Inbox, Ask and Settings, with a first-run setup that ends with a QR code for your phone. The UI shows no internal IDs or timings, and nothing reaches another person without your tap.

**The caveat that matters most:** every live check (Sarvam, Groq, a real GitHub issue, a real phone) ran against faithful fakes or emulation, because the machine had no `.env` keys and no sandbox repo. The real tunnel, real browsers and the real code paths all ran. Those few live checks are on the manual list.

## 2. Per phase

| Phase | Commit | Tests (web + server) |
|---|---|---|
| baseline (`main`) | 961283c | 969 / 970 (one timing-dependent test) |
| 0 doctor, macOS | 522f703 | 978 / 978 |
| 1 capture, auth, one port, tunnel | afdf10c | 1021 / 1021 |
| 2 phone app | d8034ea | 1041 / 1041 |
| 3 profile, ask-cards, outputs | eb421bd | 1091 / 1091 |
| 4 Inbox, Ask, Settings | 85a874c | 1095 / 1095 |
| 5 README, demo, rehearsal | 356f739 | 1095 / 1095 |
| review fixes | 8386ef6 | **1105 / 1105** (web 715, server 390), typecheck clean |

**Phase 0**
- Ran as-is on macOS arm64; nothing needed fixing.
- `pnpm run doctor` (8 tests). It is `run doctor` because `pnpm doctor` is a pnpm built-in.
- CLAUDE.md now describes the Mac.
- The ramble smoke test found the problems Phases 1 and 3 fixed: one card per block, no reminder kind, internal IDs in issue bodies, a placeholder email body, echoed titles.

**Phase 1**
- `POST /api/capture` takes JSON or multipart. A WAV of any common encoding is converted to 16 kHz mono in memory and zero-filled afterwards.
- A deterministic intent segmenter runs before the engine. The ramble as one block now gives bug, email and reminder cards, with the aside dropped.
- Retries are idempotent by `clientId` (new `captures` table, which stores no transcript). New `GET /api/captures` and a `capture.done` WebSocket event.
- Passcode sessions: a 90-day HttpOnly cookie, plus a capture-only bearer token.
- In tunnel mode, loopback isn't trusted and pairing codes are refused, on `/api`, `/ws` and `/local-stt` alike. The origin guard allows exactly the one public origin.
- `pnpm start` serves the built web app on :8787 with an SPA fallback.
- `TUNNEL=1` runs cloudflared and prints the URL and a QR code; it refuses to start without a passcode.

**Phase 2**
- `/capture`:
  - one big button, a timer, and a wake lock while recording;
  - "Your last captures", with a status per clip;
  - an "Or type it" box.
- Recording uses MediaRecorder, then `decodeAudioData` and OfflineAudioContext to make a 16 kHz WAV.
- Offline queue: clips are sealed with a non-extractable AES-GCM key in IndexedDB, retried with backoff, and deleted once the server acknowledges them.
- Manifest: `start_url /capture`, a "Capture" shortcut, and a Web Share Target. Shared files stay in service-worker memory only.
- Passcode sign-in screen. `/pocket` now redirects to `/capture`.

**Phase 3**
- **Reminder kind,** added to the schema, both prompts, Groq defaults, the offline cortex and the eval. A bare hour from 1 to 7 means pm, and "make it 7" keeps the day.
- **Context profile:** encrypted, seeded from `.env`. The cortex now reads people from it.
- **GitHub account:** a saved token, `.env`, or the `gh` CLI (only after you agree). The import suggests 30 repos (5 preselected, 1 default) and teammates from commits.
- **Paste parser:** vCard, CSV and loose lists, with the model as a fallback.
- **Routing:** decides which repo, whose address and when, and asks only when it must. Answers are encrypted on the artifact and learned in the profile.
- **Handoff links:** GitHub new issue, mailto, Gmail compose, Google Calendar, an `.ics` with VALARM, and WhatsApp.
- **Real issue creation** to the routed repo. Autonomy L3 never auto-files into a team repo.
- **Drafts a person would send:** no internal IDs in issues, emails that state the point, titles that aren't the sentence.
- **Fewer duplicates:** one decision across several threads now updates one card.

**Phase 4**
- **Navigation:** Inbox · Ask · Settings. The old URLs redirect.
- **Inbox:** a capture bar for typing or Wispr Flow dictation, plus a live mic; one suggestion banner; Needs you / Done / Saved; and a line like "Captured 3 things · 3 need you".
- **Cards:** label, destination, one primary action, and a ⋯ menu with Edit · Copy · .ics · Why? · Forget. "Why?" shows *What I heard* and *Why I made this*.
- **Settings has seven tabs:** Profile & connections, Voice engine, AI model, Privacy, Memory map, Outbox history, and Developer (collapsed).
- **First-run setup:** five steps, each skippable: welcome, GitHub, people, a phone QR code, and a "try it" step.
- **Top bar:** one status pill.
- **Ask:** citations are numbered.

**Phase 5**
- The README is now a product page; the old one moved to `docs/ENGINEERING.md`.
- `docs/DEMO_V1.md` has the 2-minute demo script.
- `scripts/e2e/rehearse.mjs` plays the demo automatically and records video.
- The capture-only token appears in Settings.
- Tests use the repo's model cache instead of a leftover `D:/` Windows path.

**Review fixes:** a fresh-context review of the whole branch found one critical issue and several important ones. All are fixed, each with a test that failed first (section 5).

## 3. Verification evidence

**Doctor** at the end (no `.env` on this Mac). Keys are never printed.
```
✅ Node 26.4.0 · ✅ pnpm 10.28.2 · ✅ embedding model cached · ✅ cloudflared 2026.9.3
⚠️ .env missing · ⚠️ no SARVAM_API_KEY · ⚠️ no GROQ_API_KEY · ⚠️ SYNAPSE_PASSCODE not set
GitHub: ✅ @SayedZahur786 via gh auth token (Phase 0); ⚠️ "could not reach api.github.com" in the final run (intermittent network here)
```

**Capture through a real cloudflared tunnel** (`scripts/e2e/phase1.mjs`, which uses `fetch` because this machine's tools blocked curl):
- No cookie: **401**.
- With the session: **200 in 326 ms**. The transcript was the ramble, which made 3 cards.
- All three cards appeared live in a second signed-in tab.

**Phone, Phase 2.** Pixel 7 emulation with a fake microphone playing synthetic speech, through the tunnel:
- Signed in, service worker active.
- Recorded and stopped: **"Made 3 things"** 0.5 s after stop.
- The desktop tab showed the same cards.
- Offline: **"Waiting for network"**, with 0 server captures for that clip. Back online: **exactly 1**.
- Manifest correct: start URL, shortcut and share target.

**Outputs, Phase 3.** Same phone flow, with a fake GitHub standing in for `<owner>/synapse-sandbox`:
- **Create issue** returned "Created #1", filed with the footer and no internal IDs.
- The email asked **"Who is ‘the team’?"** once. The mailto and Gmail links decode to the right recipients, subject and body.
- Reminder at **tomorrow 18:00 IST**, with the calendar `dates` in UTC and an `.ics` containing VALARM.
- A second identical ramble asked nothing.
- "Actually make it 7." moved the reminder to **19:00**.

**Real GitHub import** (read-only, your `gh` token, counts only): 30 repos (5 preselected, 1 default); 16 teammates with email (8 preselected).

**UI, Phase 4.** 34 screenshots in [screenshots/v1/](screenshots/v1): Inbox empty, with cards, and with Why? open; Ask; the seven Settings tabs; the five first-run steps; and `/capture`, each at 1440 and 390 wide. **0 violations:**
- no internal IDs, millisecond timings, autonomy labels or "mock" on the default screens;
- no horizontal overflow;
- no page errors.

I looked at each screenshot and fixed four things:
- an inverted QR code;
- a suggestion banner that duplicated the email card;
- cards from one capture shown in reverse order;
- leftover "Recall"/"Desk" wording on Ask.

**Demo rehearsal** (phone and desktop, video):
- [demo-rehearsal.webm](screenshots/v1/demo-rehearsal.webm) and [demo-rehearsal-phone.webm](screenshots/v1/demo-rehearsal-phone.webm). Both are video only, with no audio track.
- All 8 beats passed in 3 runs, including the run after the review fixes: 3 cards with the reminder at 7 pm, the same cards on the laptop, Created #1, Gmail and Calendar prefilled, 3 cards moved to Done, and a cited answer in Ask.

**Final checks:**
- `pnpm typecheck` and `pnpm test` (1105/1105), `pnpm build` and `pnpm run doctor` all pass.
- **Clean clone** of `v1`: `pnpm install --frozen-lockfile`, 1105/1105 tests and a clean typecheck. The clone has no `.env`, no `data/`, no audio or database files, and no key-shaped strings, and neither your `gh` token nor the e2e passcode appears anywhere in it.

**Offline eval:** dev set 100% (69 threads); held-out 87.3% macro-F1, the **same as `main`** on this machine. The committed `EVAL.md` is older.

## 4. Decisions made

Each has a line in [V1_PROGRESS.md](dev/V1_PROGRESS.md) with its cost if wrong. In short:
- **Setup:**
  - The run created no `.env`; settings came from the process environment, because you declined the `.env` copy.
  - The doctor command is `pnpm run doctor`.
  - Commits carry no AI attribution, per your CLAUDE.md.
- **Auth:**
  - LAN pairing kept for LAN use; the passcode works everywhere; through the tunnel only the passcode counts.
  - The cookie is `Secure` on https only, so plain-http LAN browsers keep it.
- **Capture:**
  - Segments that start a new thought get a 9 s virtual gap, continuations 600 ms.
  - A speech-to-text failure answers 503, because Cloudflare replaces an origin 502 with its own HTML page.
  - New `typed` fragment transport for text captures.
- **Phone storage:** the offline queue keeps clips in IndexedDB only as AES-GCM ciphertext and deletes them once acknowledged. This is the one place audio touches a disk; it squares the plan's IndexedDB queue with the "no audio on disk" rule. Shared audio stays in service-worker memory.
- **Routing and handoffs:**
  - The default repo is used before asking "Which repo?", so the demo files with one tap. With no default, it asks.
  - Routing answers live on the artifact; learned facts live in the profile; both are encrypted.
  - A link handoff marks the card Done when tapped.
  - Autonomy L3 auto-files issues only into the sandbox repo.
  - Teammates come from commits, not the contributors endpoint.
- **Reminders:** a timed reminder is `scheduling`, an untimed one is `action`.
- **Status pill:** "Ready" was added for connected-and-idle.
- **Settings:** the voice and model tabs explain the `.env` choice and offer local-only rather than editing `.env`.
- **Tests:**
  - The "no internal IDs" rule is checked in a real browser.
  - The old test that wanted the thought code in issue bodies now asserts the opposite.
  - A timing-dependent Groq test was fixed in the test, not the product.
  - The audio audit now allows the two capture modules, under its strictest rules.
- **Environment:**
  - The Mac's idle sleep froze two test runs, so the run used `caffeinate` (pre-flight step 4 hadn't been done).
  - E2E browsers used the cached Chromium, because Playwright's own download failed at first.

## 5. Blocked, skipped and flaky

- **No `V1-BLOCKED` tests.** Nothing was skipped.
- **On-device Whisper wasn't exercised end to end.** The model download failed from the run's sandbox (`fetch failed` to Hugging Face). Phone audio in the e2e runs went to the fake Sarvam instead. Whisper is still the default for captures when there's no Sarvam key, and it downloads once on a normal shell (manual step 3).
- **Network flakiness on this machine:**
  - `cdn.playwright.dev` was unreachable at first and fine later.
  - GitHub API calls timed out twice, then worked.
  - The doctor's final GitHub check said "could not reach".
  - A fresh quick tunnel answers 530 for up to 30 s, so `scripts/e2e/wait-health.mjs` waits for it.
- **The Mac's idle sleep** froze two full test runs for about 4 minutes (pmset shows Sleep 10:41 → DarkWake 10:56). The rest ran under `caffeinate -i -s`.
- **Visual flicker:** while a correction ("make it 7") is applied, a phone capture row can label the reminder "Note" for under a second. The final state is right.
- **Review findings, all fixed with a test that failed first:**
  - **Critical:** a percent-encoded path (`/%61pi/state`) skipped the auth hook and exposed data through the tunnel.
  - The login limit could be dodged with a spoofed `x-forwarded-for`.
  - Routing answers were loaded into the wrong table and lost on restart.
  - A retry during processing got an empty "duplicate" result.
  - "tonight" became 9 am, and a stated time already past was accepted.
  - Wipe-all and export ignored the profile and the GitHub token.
  - One undecryptable phone clip blocked the whole queue.
  - A tunnel started by hand, without `PUBLIC_URL`, would have trusted loopback.

## 6. Known gaps vs. the plan

- **Live checks:** none of the plan's live checks ran (real Sarvam, real Groq, a real sandbox issue, a real phone on 4G). No keys or sandbox repo existed. They are manual steps 1–6.
- **Contact Picker:** built and feature-detected, but only testable on a real Android phone.
- **Share Target:** needs the installed PWA, because the service worker handles the POST. Without the service worker, `POST /capture/share` returns 404.
- **Typed-text handoff:** `/capture` text and Inbox text go through the same segmenter. Dictation that arrives as one unpunctuated stream splits only on "and <action>" boundaries.
- **Hinglish:** not checked. That needs Sarvam.
- **Deferred minors from the review:**
  - `mergeInto` can count moved fragments twice in the thread's centroid.
  - `/shipped` and `/answer` don't check the card's status.
  - Migrations v2 and v3 aren't wrapped in a transaction.
  - `whenOptions` picks the wrong weekday in UTC+13/+14 and is off by an hour on DST days.
  - "remind me at noon to eat" is titled "At to eat".
  - `contextFor` runs an unindexed scan twice per view.
  - Sessions can't be revoked server-side, and open WebSockets aren't re-checked on logout.
- **Crash mid-capture:** a crash in the middle of a capture leaves a row whose retry returns an empty duplicate.
- **`pnpm start` doesn't set `NODE_ENV=production`:** dev routes are registered, though refused unless the request is genuinely local and not through a tunnel.
- **Noticed, didn't touch:**
  - The old Desk, Pocket, rail and stream components are now unrouted dead code (kept, per "hide, don't delete").
  - A stray 23 MB model cache at `apps/server/D:/goa-hack/data`, left by the old Windows test path. It's git-ignored; delete it if you like.

## 7. Recommended next steps (V2)

1. Run [MANUAL_STEPS.md](dev/MANUAL_STEPS.md) with real keys, then tune the segmenter and prompts on your real rambles. The offline cortex is a stand-in.
2. Set up a named Cloudflare tunnel, so the phone URL never changes.
3. Fix the deferred minors above, starting with server-side session revocation and transactional migrations.
4. A Mac quick-capture app (global hotkey and `context.repo` from the frontmost editor), and an iPhone Shortcut using the capture token.
5. Send through Slack and WhatsApp, still behind a tap. Add a webhook output.
6. Gmail and Google Calendar APIs, so drafts and events are created in place rather than opened.

---

## V1.1

Second unattended run, same branch (commits f489d2e → see `git log`). Goal: the Mac as an always-on server with a permanent free HTTPS URL, a public landing page, and card quality that holds up on Groq's free tier. **Cost: $0** (Tailscale Personal, GitHub Pages, Groq free tier, Sarvam credits; nothing paid was enabled).

| | |
|---|---|
| **Your app** | **https://<your-mac>.<tailnet>.ts.net** (Tailscale Funnel: permanent, TLS ends on the Mac; `/app` laptop, `/capture` phone) |
| **Website** | **https://sayedzahur786.github.io/synapse-site/** (GitHub Pages, repo `SayedZahur786/synapse-site`: static landing only) |
| Tunnel used | Tailscale Funnel (approved during the run). Fallbacks built and tested: ngrok static domain, cloudflared quick tunnel |
| Sandbox issue | issue #1 in a private sandbox repo (filed through the live server from the R9 card; summary / observed / suspected cause, "Captured by voice with Synapse", no internal IDs) |

### What changed
1. **One Groq call per capture** with an in-place re-draft queue; a rate-limit pause is waited out once and invalid JSON is asked again once, instead of falling back to one call per thought (both found live).
2. **Review fixes:** revocable sessions ("Log out all devices"), idempotent Create issue / answer / shipped, default-deny auth on canonicalised paths, an "Opened → Done" state for handoffs, transactional migrations, non-extractable phone key (pinned by a test).
3. **Always-on Mac:** `pnpm run serve` (Funnel → ngrok → cloudflared, URL + QR, `data/public-url.txt`, orphan tunnel cleanup), `pnpm run service:install|status|uninstall` (launchd, restart verified in ~1 s after `kill -9`), the phone's "Saved on your phone. It will sync when your Mac is awake.", doctor checks for tunnel, reachability, service and sleep.
4. **Honest transit copy:** the Privacy Center, landing page, README and whitepaper say where TLS ends for each tunnel (Funnel: only on the Mac; ngrok/Cloudflare: at their edge).
5. **Landing page** at `/` (app moved to `/app`, every old URL redirects), OG image, and a static copy on GitHub Pages with a build-time guard against app code, API calls and secrets.

### Verification
**10 live rambles** (`scripts/e2e/live-rambles.mjs`): macOS voices Rishi, Tara, Aman (Indian English) and Lekha (Hinglish, Devanagari + English), uploaded like the phone does over the permanent Funnel URL, real Sarvam (saaras:v4) + real Groq (qwen3.8-27b), throwaway data deleted afterwards, 45 s apart.

| Target | Run 1 (before fixes, back-to-back) | Final run |
|---|---|---|
| Fully right (≥ 8/10) | 8/10 | **9/10** by the automated check; **8/10** on review (R9's reminder was titled "Remind Sarah to follow up": no Sarah was mentioned) |
| Groq calls per capture (≤ 2) | max 7 (a 429 sent the capture down the per-thought path) | **≤ 2 on 9/10**; 4 on R3, whose transcript Sarvam returned as gibberish |
| Median upload → final cards (< 8 s) | 13.6 s | **1.6 s** |

| Ramble | Said (voice) | Cards (final run) | |
|---|---|---|---|
| R1 demo | bug + email + reminder + aside (Rishi) | GitHub issue · email to the team · reminder tomorrow 18:00; aside dropped | ✓ |
| R2 comma-joined | email Sarah, and also remind me Monday 9 (Tara) | email to Sarah · reminder Mon 09:00 | ✓ |
| R3 correction | Friday 5 pm, no wait, Thursday (Aman) | Sarvam heard "Dear Chloe, thermal paste hissing…" → one wrong email | ✗ (STT) |
| R4 Hinglish | कल सुबह दस बजे Dev को call… guest login idea (Lekha) | reminder "Call Dev" tomorrow 10:00 · note "guest login on checkout" | ✓ |
| R5 two asides | login 500 bug, Postgres decision, 2 asides (Rishi) | GitHub issue · decision; both asides dropped | ✓ |
| R6 | message Dev; meeting with Sarah next Tuesday 3 pm (Tara) | message to Dev · event Tue 15:00 | ✓ |
| R7 idea | CDN caching idea (Aman) | note | ✓ |
| R8 retraction | milk at 8… forget the milk, bread instead (Rishi) | one reminder: bread tonight 20:00 | ✓ |
| R9 three comma-joined | slow search bug, email Dev, follow-up Wed 11 (Tara) | issue · email to Dev · reminder Wed 11:00 (title wrongly names Sarah) | ✓/✗ |
| R10 short | call mom at 9 tonight (Aman) | reminder tonight 21:00 | ✓ |

Budget used this run: about **55 Groq calls** (cap 150) and **29 Sarvam calls** (cap 40).

| Check | Result |
|---|---|
| Lighthouse, live Pages URL (mobile) | Performance 100 · Accessibility 100 · Best practices 100 · SEO 100 |
| Lighthouse, app-served `/` (localhost) | 94 · 100 · 100 · 100 |
| Lighthouse, app-served `/` via cloudflared | 99 · 100 · 100 · 54 (Cloudflare's quick tunnels add `x-robots-tag: none`; not ours) |
| Routes | `/`, `/app`, `/app/ask`, `/app/settings/privacy`, 6 old URLs, `/login`, `/capture`, unknown → all correct, no page errors |
| Demo rehearsal (Pixel 7 + desktop, fakes, tunnel) | 9/9 beats incl. the new "Opened in Gmail → Done" |
| launchd | `kill -9` → restarted in ~1 s; `service:status` shows state, URL, logs |
| Tunnel process hygiene | orphan cloudflared from a `kill -9` ended on next start; SIGTERM stops it and removes the pidfile |
| Mac asleep (Pixel 7, server stopped behind Funnel) | phone showed "Saved on your phone. It will sync when your Mac is awake."; synced on its own after restart; **exactly 1** copy on the server |
| Restart (`launchctl kickstart -k`, real service) | back in 2.1 s; same session cookie still signed in, profile intact, **same URL**. (Your real database had no thoughts yet, so memory survival rests on the SQLite persistence tests, not this check.) |
| Tests | typecheck clean · web 730 · server 439 · build OK · the same from a clean clone of `v1` |

### Found and fixed during the run
- **Funnel detection:** Tailscale 1.102 reports Funnel as a plain `funnel` capability, not the documented URL key; `serve` would have skipped Funnel forever (seen live, fixed with a test).
- **launchd + ~/Desktop:** a background `node` needs macOS's one-time Desktop-folder consent; the server sat blocked in `open()`. `service:install` now says so up front (you allowed it).
- **Passcode in a test:** the real passcode had been used as a test literal in Phase 2; scrubbed from the two local commits before anything was pushed, history scanned clean, passcode replaced (now 4 random words in `.env`).
- **The demo ramble answered empty:** the prompt's worked example WAS the demo ramble, and the model returned `{"items": []}` for it every time (then the repair call fixed it). The example is now a different ramble; the demo drafts in one call.
- **Groq said wait / invalid JSON:** a 429 or a `json_validate_failed` used to drop the capture to one call per thought (7 calls on R5); now the batch call waits out the pause or asks again once.
- **Contrast:** the landing's primary button had light text on orange (a specificity bug); fixed, Accessibility 95 → 100.

### Limits (honest)
- Sarvam occasionally mis-hears synthetic voices (one ramble came back as gibberish, another as a single dictionary word); the same audio transcribed correctly when sent again. Not reproducible, so not "fixed".
- Groq's free tier allows roughly two capture calls a minute; back-to-back rambles queue for budget (spacing them like real use keeps them fast).
- A 404 on Tailscale's Funnel approval page means the browser is signed into a different Tailscale account than the tailnet owner.
