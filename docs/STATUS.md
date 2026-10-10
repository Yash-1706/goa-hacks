# Status and traceability

*What is built, what is proven, and what only a key or a device can prove. Written to be read by a judge who wants to know which claims to trust.*

**Legend** · ✅ the acceptance criterion is verified in this repo (automated test or a generated report, named in the last column) · 🔶 built and unit-tested, but the criterion itself needs a live key, a real voice or a real phone · ⬜ designed, not built

**Test inventory** (`pnpm test`): `@synapse/server` 241 tests in 21 files · `@synapse/web` 669 tests in 42 files · typecheck clean on all three packages (`pnpm typecheck`). The tests that guard the claims most likely to be doubted were checked the hard way: the local-only test fails when the local-only router is removed, the GitHub test fails when an API header is changed, and the audio tests run against a fake Wispr that is itself proven to reject protocol violations (`fake-wispr.integration.test.ts`).

## What a human has to add (nothing below can be done from inside this repository)

| # | Do this | Unlocks | How you will know |
|---|---|---|---|
| 1 | Put `ANTHROPIC_API_KEY=…` in `.env` (gitignored) | live Claude cortex + DEEP (Opus) recall answers, briefs, consolidation | top-bar chip changes from `mock · wispr + llm` to `live`; Lab → latency shows `llm` stages |
| 2 | Put `WISPR_API_KEY=…` and `WISPR_MODE=client` in `.env` (API access is granted by the organisers) | real transcription from the microphone | chip shows `wispr client`; the Lab diagnostics list standby/latency events |
| 3 | `pnpm eval --live` and `pnpm bench --live`, once | the real model's accuracy and latency in `docs/EVAL.md` / `docs/LATENCY.md` (today they describe the **offline** cortex and say so) | the banner "Mock mode" disappears from both reports |
| 4 | Run `pnpm wispr:check` (server in `WISPR_MODE=client`; 15 s, no microphone needed), then do one real spoken run | confirms the Wispr wire details we implemented from the documentation: the check reports items 1-6 of `apps/web/src/audio/README.md` as PASS / FAIL with evidence; the spoken run covers CORS, whispers and phones | every line PASS; Lab diagnostics show `standby ready` without `assumed`, and no `fallback` events |
| 5 | `GITHUB_TOKEN` + `GITHUB_REPO=owner/sandbox` (fine-grained token, Issues: write) | a real issue when you tap Push or when L3 fires | the card shows a real issue link, not `GH-101 (simulated)` |
| 6 | Phone: `HTTPS=1 pnpm dev:web`, open the printed LAN URL, enter the pairing code | Pocket mode on a real device | README → "Phone" has the firewall and certificate steps |

Everything else (the whole pipeline, memory, recall, proactivity, privacy controls, the UI, the replays) runs **today without any key**, with every degraded path labelled on screen.

## Judging criteria → evidence

| Criterion | What to look at | Proof in this repo |
|---|---|---|
| **Fragment Intelligence (30 %)** | S1 mumbled bug → one issue, S2 self-repair (JWT struck out, OAuth2 chosen), S4 half-formed code, S5 asides ignored | `apps/server/test/pipeline.test.ts` (16 scenarios); held-out intent macro-F1 **88.7 %** on 63 phrasings that are not among the classifier exemplars (`docs/EVAL.md`, offline cortex; not a blind test, the note there says why); reference resolution 8/8; 0 spurious artifacts on a 25-fragment nonsense ramble |
| **Proactivity (25 %)** | S6 three clash-mutters → one reschedule suggestion with concrete slots; answers "what did Sarah say?" quietly; repeated pattern → snippet; speaks only at a pause | `proactive.test.ts` (echo, contradiction, snippet, open loops, feedback adaptation, delivery rules), `pipeline.test.ts` (S6, never-during-speech) |
| **Memory Depth (20 %)** | S7 "that idea about caching last Tuesday while I was walking", knowledge graph across sessions, memory echo, contradiction | `recall.test.ts`; Recall@3 10/10 on vague, time/place-constrained queries (small set: 10 queries over 11 thoughts); `consolidation` test; the seeded graph spans 8 sessions |
| **Privacy Architecture (15 %)** | whispered "pause memory" → mic released; audio never on our server or disk; crypto-shredded working memory; redaction; local-only; audit chain | `engine.test.ts` kill-switch tests, `gateway.test.ts`, `foundation.test.ts`, **`no-audio.test.ts`**, **`local-only.test.ts`**, **`no-sensitive-inference.test.ts`**, `audio/egress.test.ts` |
| **Creep Factor (10 %)** | draft-first, "why I kept this", quiet rail, "forget that" | autonomy ladder tests (`modules.test.ts`), `integrations.test.ts` (nothing is sent to another human; tokens never reach a client), forgetting-by-meaning test |

## Deliverables (the hackathon brief's list)

| Deliverable | Where | State |
|---|---|---|
| Live monologue demo | `docs/DEMO_SCRIPT.md` + `pnpm replay scripts/replay/s1_bug.json` (and s2…s9) | ✅ scripted and replayable keyless · 🔶 with a real voice |
| Knowledge-graph visualisation (5+ sessions) | `/graph` screen, `pnpm seed` (8 sessions) | ✅ verified in the browser: 61 nodes, 8 sessions in three clusters (five bridged by the cart-service hub, an OAuth2/PKCE pair, one isolated), session colours, entity hubs, a timeline scrubber that replays how memory grew · 🔶 on your own dogfooded sessions |
| 1-page privacy whitepaper | `docs/PRIVACY_WHITEPAPER.md` | ✅ every claim cross-checked against code and tests |
| Recall demo | `/recall` screen; the recall beat in `docs/DEMO_SCRIPT.md` → "The 3 minutes" | ✅ typed and spoken-question paths · 🔶 spoken answer (TTS) on a real device |
| Architecture diagram | `docs/ARCHITECTURE.md` (mermaid) | ✅ |
| Latency benchmark | `docs/LATENCY.md`, `docs/latency.csv`, `pnpm bench` | ✅ pipeline stages measured (first paint p50 12 ms) · 🔶 Wispr and Claude stages need keys |
| 1-page failure-mode analysis | `docs/FAILURE_MODES.md` (20 modes, each marked ✅/🟡/❌) | ✅ |
| 3-minute pitch | `docs/PITCH.md` | ✅ |

## What was exercised end to end (mock mode, typed input, in a browser)

Everything below was run against the real server and the real UI, not mocks, with the offline cortex and no keys:

- **Demo beats** ①–⑤ on the Desk: a self-repair decision with JWT struck out, the open question answered quietly from the seeded session, the *Decision changed: JWT → OAuth2, revisit?* prompt, a four-fragment bug report whose whispered tail joins the same issue, an email draft, a half-formed code snippet, asides filtered while the journal note is kept.
- **Proactivity:** three clash mentions → one reschedule suggestion with three concrete slots; picking the **third** slot held exactly that slot (this was broken until the pass: the server ignored the choice).
- **Privacy:** "pause memory" released the (typed) mic and purged the trailing thought with the toast "1 recent thought forgotten", the audit chain verified, resume needed a tap; "scratch that" retracted a note; "actually make it Friday" revised the call in place; "forget what I said about …" deleted by meaning.
- **Resilience:** the API was stopped under an open page (the Desk showed "Listening, but offline. Fragments are queued"), a line typed while offline was delivered after the restart.
- **Screens:** Recall (constraint chips, sources in 4 ms, cited answer), Privacy Center, Graph (timeline scrub), Lab, Outbox (edit persisted on the server), Pocket at 375 px; no horizontal overflow on any route; no console errors apart from the browser's own "WebSocket failed" lines while the server was down.
- **Network:** from a LAN address every route except `/api/health` answers 401 until paired; dev routes answer 401/404 off-loopback; a public website origin gets 403; the HTTPS dev mode serves pages, proxies the API and upgrades WebSockets; the production build's service worker is valid and precaches 34 files that all exist.
- **Voice path without a key:** `pnpm wispr:check` ran the real streamer, over a real socket, through the real server token path against the strict fake: PASS on every item that can be tested from Node.
- **Voice path in a real browser (synthetic voice, still no Wispr key):** a Windows-generated voice played into the page as the "microphone" (`apps/web/scripts/voice-smoke/`) and the strict fake Wispr behind the real server. The real Silero VAD (WASM) caught a 3.2 s and a 6.3 s sentence (102 and 198 packets of 32 ms, 1,024 bytes each, one `commit` with the matching total) and the same sentence at −31 dBFS, which the Stream tagged `WHISPER`; silence sent nothing; the fake counted **0 protocol violations**. Cards appeared 203–414 ms after the final text (first paint p50 203 ms, finished card p50 264 ms, speech → card p50 1.06 s with a 300 ms fake Wispr). The problem statement's mumbled bug report, spoken as four bursts with 1.3, 1.1 and 0.9 s pauses (measured by the client's VAD timeline and shown in the Stream), became **one** thought ("Null pointer in cart-service ×4") with a GitHub-issue draft: 4 commits, 4 finals, 0 violations. Restarting the upstream was recovered by the standby socket; with a silent socket the app waited out the 4 s timeout, fell back to REST (a WAV the strict fake accepts) and still produced the card; a spoken "pause memory" released the mic, closed every Wispr socket, paused the server and was never stored (811 ms by the app's own clock). **Not covered:** a physical microphone, room acoustics, real whispers, the real Wispr service.

### Bugs this pass found (each fixed, each with a regression test)

| Bug | How it showed | Fix |
|---|---|---|
| A thought that began like a recall question and became a decision kept the 30-minute recall retention and was deleted by the next TTL sweep | one seeded session vanished from the graph | retention restored on re-categorisation (`store.setRetention`); a fuzz test over a messy day guards the whole class |
| A thought still open when the server stopped stayed "analyzing" forever | found by reasoning about `pnpm dev` restarts | finalised on the next start |
| After `pnpm seed` the demo calendar was last week's, so "Thursday standup vs dentist" had nothing to clash with | Lab: "Nothing ahead" | the demo calendar always covers this week and next |
| "Forget what I said about the pricing service" also deleted an unrelated cart-service bug | live test | forget-by-meaning only deletes what is demonstrably about the topic (named entity or a specific word) |
| The chosen reschedule slot was ignored (always the first) | UI/server contract gap | `suggestion.action` carries `pick` |
| Corrected dictionary terms never showed as "corrected"; the calendar notice printed `cal:<id>` | UI agent's report | fixed in the store and the outbox |
| "Add a retry budget to the webhook sender" was filed as a message to the team | live test after a reconnect | technical-vocabulary cue; the offline classifier's held-out macro-F1 is unchanged at 88.7 % |
| `pnpm replay --local --speed 50` split thoughts that a human-paced run keeps together | replay output differed by speed | no timer-based thread closing in a compressed replay |
| Server tests flaked on a loaded machine (a real 200 ms close timer between utterances) | full-suite runs while browsers were open | deterministic thread closing in the test helper |
| `engine.idle()` reported "quiet" while a merged correction was still being written to its card (the correction's thread had already left the registry) | the "actually make it Friday" test failed now and then in the full suite; reproduced on demand with a slow embedder | `idle()` also waits for every running analysis loop; the regression test fails without it |
| Turning the live model on in `.env` would have made `pnpm seed` and `pnpm replay --local` call Groq as well (dozens of fragments, rate-limited and nondeterministic; replay even printed "mock cortex") | found while switching `LLM_MODE=live` on; the whole suite was then run against a recording stand-in and received 0 requests | the offline tools pin the mock cortex (`ephemeralApp` default, `seed`); 2 tests, mutation-checked |
| One Groq model hitting its daily token cap switched the whole live path off (the 429 pause was client-wide), although the other model still had budget | live Groq smoke test: Qwen's cap took the deep path down with it | the pause is per model (30 min for a daily limit, 2 min for a minute limit) and the hot path fails over to the other model; 11 tests, each mutation-checked |
| A correction spoken while the model was still writing the original card lost to it: the model was shown no card to revise, then the original's late result overwrote the revision | found while tracing the flake above; only reachable with a slow, queued or retried model call, so never in mock mode | a revision waits for the card it revises (never a plain "scratch that", and only for an older thread, so two threads cannot wait for each other); regression test with a slow model, mutation-checked |

## Requirements (PRD §6)

### Capture: "Ear"
| ID | Pri | Status | Evidence, and what is missing |
|---|---|---|---|
| CAP-1 VAD-gated streaming | P0 | 🔶 | ✅ silence → zero network audio and zero radio time; pre-roll flushed at the first packet (`audio/engine.test.ts`); also seen in a real browser with the real VAD (silence sent nothing, speech became 32 ms packets). Onset → first packet ≤ 150 ms needs a real mic |
| CAP-2 whisper-sensitive | P0 | 🔶 | ✅ VAD tuned (threshold 0.35, calibrated noise floor, whisper flag follows the room); the real VAD in a browser also caught a synthetic voice at −31 dBFS and flagged it as a whisper, but only a synthetic voice was available, so "≥ 9/10 real whispers" is unmeasured |
| CAP-3 aggressive segmentation | P0 | 🔶 | ✅ commit at 480 ms of silence, stitcher re-joins (`pipeline.test.ts`); fragment counts on a real 2-minute ramble not measured |
| CAP-4 context-primed Wispr | P0 | ✅ | `audio/wispr.test.ts` (dictionary ≤ 150 terms, last ≤ 6 messages, name, language), `modules.test.ts` (server context redacted) |
| CAP-5 per-fragment features | P0 | ✅ | `FragmentFinal` schema validated on every emitted fragment; activity from motion sensors is 🔶 (real phone) |
| CAP-6 multilingual passthrough | P1 | 🔶 | language list passes through to Wispr; a real Hinglish utterance was not tried |
| CAP-7 injector / replay | P0 | ✅ | typed-input engine, `injectText`, `pnpm replay` (8 scenario scripts) |
| CAP-8 local STT fallback | P1 | ⬜ | designed in TRD; today an unreachable Wispr degrades to REST, then to typed input |
| CAP-9 Wispr context minimisation | P0 | ✅ | `audio/wispr.test.ts` "NEVER sends screenshot / content_text / content_html" |

### Fragment intelligence: "Cortex"
| ID | Pri | Status | Evidence, and what is missing |
|---|---|---|---|
| CTX-1 stitching | P0 | ✅ | `pipeline.test.ts`: 4 fragments → 1 thought; unrelated topics → 2 |
| CTX-2 13-class latent intent | P0 | 🔶 | ✅ offline macro-F1 88.7 % on the held-out set, which the same authors wrote (weak classes: decision 66.7 %, idea 50 % — see the confusion matrix in `docs/EVAL.md`); the live model's number is unmeasured (`pnpm eval --live`) |
| CTX-3 reconstruction | P0 | ✅ / 🔶 | self-repair + open question test (offline); Claude path verified against a faithful SSE fake, not the real API |
| CTX-4 artifact drafting | P0 | ✅ | schema-valid artifacts per class; `.ics`/`mailto` export test; artifact-kind accuracy offline 76.2 % |
| CTX-5 living cards | P0 | ✅ | provisional first-paint card, then the analysed card, over a real socket (`gateway.test.ts`); in the UI the offline cortex answers in the same tick as first paint (~190 ms), so the visible streaming morph needs a live model |
| CTX-6 reference resolution | P0 | ✅ | 8/8 on the coreference set; "assuming you mean…" only when the top-2 margin is small |
| CTX-7 abstention | P0 | ✅ | 25-fragment ramble: 0 stored, 0 spurious artifacts, 22 filtered as asides; asides never stored |
| CTX-8 natural corrections | P1 | ✅ | "make it Friday" revises, "scratch that" retracts, an uninterpretable correction changes nothing |
| CTX-9 reasoning trail | P0 | ✅ | every card has a Trail drawer (browser-verified): the heard fragments with pause gaps, the reconstruction, resolved references with confidence, self-repairs, salience reasons, the model used, per-stage latency |
| CTX-10 session brief | P0 | ✅ / 🔶 | brief test (tasks, decisions, snippets, open loops, asides filtered); ≤ 5 s with Opus unmeasured |

### Memory: "Hippocampus"
| ID | Pri | Status | Evidence |
|---|---|---|---|
| MEM-1 three tiers, 72 h TTL | P0 | ✅ | `foundation.test.ts` (expiry + day-key destruction), `no-audio.test.ts` (nothing audio-shaped on disk) |
| MEM-2 implicit promotion, explained | P0 | ✅ | salience test: "note to self" kept with reasons, a one-off observation is not |
| MEM-3 knowledge graph | P0 | ✅ | `/api/graph`, entity alias resolution test |
| MEM-4 consolidation | P1 | ✅ | merges duplicate entities, links across sessions, labels sessions |
| MEM-5 self-healing dictionary | P0 | ✅ | dictionary seeds (team, learned terms) → Wispr `dictionary_context` |
| MEM-6 memory echo | P0 | ✅ | resurfaces a thought from an *earlier* session with when/where; never from the same session |
| MEM-7 contradiction | P1 | ✅ | flags a disagreeing decision; accepting records "supersedes" |

### Recall
| ID | Pri | Status | Evidence |
|---|---|---|---|
| REC-1 by-meaning recall, typed or spoken | P0 | ✅ | `recall_query` 5/5 held-out; typed search in the UI |
| REC-2 constraint parsing | P0 | ✅ | time, part of day, activity, device, type, person (`recall.test.ts`) |
| REC-3 hybrid retrieval | P0 | ✅ | Recall@3 10/10 (small set) |
| REC-4 cited answer | P0 | ✅ / 🔶 | sources first, then a cited answer (`recall.test.ts`); the streamed Opus answer and spoken answer need a key / a device |
| REC-5 graceful relaxation | P1 | ✅ | wrong constraint relaxed and said so |

### Proactivity: "Prefrontal"
| ID | Pri | Status | Evidence |
|---|---|---|---|
| PRO-1 recurring concern | P0 | ✅ | S6 fires exactly once, with concrete free slots |
| PRO-2 person + task → draft | P0 | ✅ | communication drafts (`pipeline.test.ts`) |
| PRO-3 repeated pattern → snippet | P1 | ✅ | `proactive.test.ts` |
| PRO-4 open-question answering | P0 | ✅ | answered at once from memory, or later when the answer is finally said |
| PRO-5 interruption-aware delivery | P0 | ✅ | nothing while anyone speaks; ≥ 1.2 s silence; minimum gap honoured |
| PRO-6 autonomy ladder | P0 | ✅ | decision table by level; L3 only self-only + confidence ≥ 0.8; never email; outage leaves it staged |
| PRO-7 feedback learning | P1 | ✅ | dismiss raises the bar, accept lowers it, "later" snoozes |

### Privacy: "Guardian"
| ID | Pri | Status | Evidence, and what is missing |
|---|---|---|---|
| PRV-1 whispered kill switch | P0 | 🔶 | ✅ mic released *first*, phrase never stored, airtight afterwards, all devices told (`engine.test.ts`, `gateway.test.ts`); in a real browser a spoken phrase released the mic 811 ms after it ended (fake Wispr, 300 ms); ≤ 1 s p95 on a real device is unmeasured, and it includes Wispr's round trip (an on-device keyword spotter is ⬜) |
| PRV-2 retroactive purge | P0 | ✅ | trailing 30 s purged on pause; "forget the last five minutes"; forgetting by meaning |
| PRV-3 deliberate resume | P0 | ✅ | fragments refused until a tap; no voice path resumes |
| PRV-4 audio never on our server | P0 | ✅ | `no-audio.test.ts`, `audio/egress.test.ts` |
| PRV-5 encryption at rest + crypto-shredding | P0 | ✅ | no plaintext in the DB file; destroyed day key can never decrypt |
| PRV-6 redaction before cloud | P1 | ✅ | emails, cards (Luhn), keys, spoken secrets masked and restored; verified through the Claude path (`claude-cortex.test.ts`) |
| PRV-7 memory ledger | P0 | ✅ | `/privacy` (browser-verified): data-flow diagram, retention and key list (destroyed day keys), controls, export, pairing, a ledger of every stored item with its expiry countdown, delete and why-kept, and the audit chain with a Verify button ("Chain intact. All 11 events re-hashed") |
| PRV-8 hash-chained audit | P1 | ✅ | verifies; detects a rewritten or deleted row; survives restart |
| PRV-9 owner-only speaker verification | P2 | ⬜ | not built (declared in the whitepaper and failure modes) |
| PRV-10 local-only mode | P1 | ✅ | `local-only.test.ts` |
| PRV-11 cascade deletion | P0 | ✅ | no row or index entry references a deleted thought |
| PRV-12 no sensitive inference | P0 | ✅ | `no-sensitive-inference.test.ts` |

### Cross-device and mobile
| ID | Pri | Status | Evidence, and what is missing |
|---|---|---|---|
| DEV-1 installable PWA, Pocket mode | P0 | 🔶 | Pocket verified at 375 px (no horizontal overflow on any of the 7 routes); production build emits a manifest, icons and a service worker (34 precache entries, the VAD model and wasm deliberately excluded), assets are served with the right MIME types, and the HTTPS dev mode used for phones serves pages, the API and the WebSocket upgrade. The embedded browser used here cannot register service workers, so install-to-home-screen is unverified |
| DEV-2 one memory across devices | P0 | ✅ / 🔶 | both devices receive every card and suggestion (`gateway.test.ts`); browser-verified with Desk and Pocket as two devices: a line typed on Pocket was a card on the Desk **211 ms** later (loopback). Over venue Wi-Fi it adds the network round trip, unmeasured |
| DEV-3 activity context | P1 | 🔶 | motion-sensor classifier unit-tested; needs a real phone |
| DEV-4 battery optimisation | P0 | 🔶 | ✅ the energy *model* shows ≥ 70 % saving vs always-on streaming; frame skipping, eco batching, VAD-gated radio tested. It is a model: real battery deltas exist only where the Battery API does (Chromium) |

### Integrations: "Outbox"
| ID | Pri | Status | Evidence, and what is missing |
|---|---|---|---|
| INT-1 outbox: accept, edit, dismiss | P0 | ✅ | `modules.test.ts`, REST + socket paths |
| INT-2 GitHub issues (real) | P0 | 🔶 | ✅ request shape, response mapping, failure handling, undo, token secrecy against a stubbed fetch (`integrations.test.ts`); GitHub accepting it needs a token |
| INT-3 Jira Cloud | P1 | 🔶 | same, with an Atlassian-document body; simulated without credentials |
| INT-4 calendar + `.ics` | P0 | ✅ | local calendar conflicts, slots, `.ics` only with a concrete time |
| INT-5 email draft via `mailto:` | P0 | ✅ | `mailto:` built and tested; Gmail API ⬜ (P2) |

### Observability and deliverables
| ID | Pri | Status | Evidence |
|---|---|---|---|
| OBS-1 latency HUD | P0 | ✅ | per-card badge, top-bar p50 and sparkline, and the Lab's latency-by-stage table against the PRD targets (browser-verified). Numbers from the offline cortex measured in the throttled in-app browser are inflated: first paint p50 388 ms there against 12 ms server-side |
| OBS-2 benchmark export | P0 | ✅ | `pnpm bench` → `docs/LATENCY.md` + CSV (offline cortex; says so) |
| OBS-3 knowledge-graph visualisation | P0 | ✅ | see Deliverables: ≥ 5 sessions linked, entity hubs, working-memory nodes, timeline scrubber (browser-verified) |
| OBS-4 docs | P0 | ✅ | `docs/` |

## Known gaps, stated plainly

- **Never run against the real Wispr or Anthropic services** (no keys were available). The Wispr client was built from the documented wire protocol and checked against a strict fake that rejects protocol violations; Claude was checked against a fake that speaks the real streaming protocol. Item 3 of the table at the top turns this into a measurement.
- Intent accuracy and latency numbers in `docs/` are for the **offline** cortex and say so in their first lines.
- Weak spots in the offline classifier: *decision* vs *idea* (hedged choices), and *idea* itself. The live model's few-shot prompt covers these better; unmeasured.
- Designed but not built: on-device keyword spotting for the pause phrase, local speech-to-text, owner-only speaker verification, Google Calendar and Gmail adapters, Wispr proxy mode.
- Phones can only listen in the foreground (web platform limit; wake lock + black Pocket screen).
- Node 25 (EOL) and `node:sqlite` (experimental) are in use; both work and are pinned by the lockfile.
