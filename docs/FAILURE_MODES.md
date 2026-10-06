# Failure-mode analysis: what breaks and why

*One page. Problem Statement 4, deliverable 5. Status legend: ✅ mitigated and tested · 🟡 mitigated, not verifiable without live keys/devices · ❌ known gap.*

| # | What breaks | Why | How we detect it | Mitigation | |
|---|---|---|---|---|---|
| 1 | **Whisper not segmented** | quiet speech sits near the room's noise floor, so the VAD never fires | calibrated noise floor shown; no fragments for obvious speech | VAD threshold 0.35 (v5, ≥0.0.31 context fix), AGC on, 2 s calibration, whisper flag, **always-visible Pause button**; rehearse in the room | 🟡 |
| 2 | **Over-fragmentation** | aggressive 480 ms segmentation splits one thought into many fragments | many 1–2 word fragments | thought stitcher scores pauses as thinking (+ incomplete-clause and connector cues); the model can say `new_thought`/`continue` and the engine splits or merges | ✅ |
| 3 | **Two topics merged** | topics 1 s apart look continuous | model returns `new_thought` | split the last fragment into its own thread and re-analyse both; an "aside" verdict on a multi-fragment thread **peels the aside off instead of deleting the earlier thought** (a real bug we hit and fixed) | ✅ |
| 4 | **"Scratch that" joins the thought it retracts** | repair cues boost continuation | trace in tests | retractions/corrections of a *closed* thread never rejoin it; the model applies them to the target (`lastCard`) | ✅ |
| 5 | **Hallucinated task from a ramble** | an LLM over-completes fragments | eval nonsense set (spurious artifacts) | abstention rule (confidence < 0.55 → tentative note), asides never stored, draft-first, "why" shown on every card | ✅ offline · 🟡 live |
| 6 | **Wrong referent for "that thing"** | sparse history, two similar candidates | top-2 score margin < 0.05 | "Assuming you mean …" chip; "no, the other one" is a correction | ✅ |
| 7 | **Wispr erases the self-repair** | its auto-edit resolves "6pm… no 7pm" inside one utterance | a repair never appears in the transcript | short segments push repairs across fragments; the model also infers repairs from residual cues | 🟡 |
| 8 | **Wispr socket idle-timeout / token expiry** | server closes idle sockets; JWTs live 15 min | close event / 401 | standby socket recycled by max-age, token refreshed at <20 % life, per-utterance **REST fallback**, then a visible "failed" tick | 🟡 |
| 9 | **Wispr key not approved / absent** | API access is by approval | token endpoint error | typed-input mode, scripted replays, mock cortex: the whole product still runs | ✅ |
| 10 | **LLM slow, rate-limited, refused, or returns bad JSON** | network/provider/safety | timeout 6 s, status codes, `stop_reason`, zod validation | provisional card stays; local cortex answers and the card is badged "degraded: …"; auth failure disables the live path for 60 s; strict schema rejected → automatic SDK-schema retry | ✅ (against a faithful SSE fake) · 🟡 (real API) |
| 11 | **"pause memory" mis-transcribed** | whisper + noise, or Wispr rewrites it | semantic backstop on the server; phrase fuzzy match (edit distance) | fuzzy phrase list (EN + Hinglish), server semantic match, big Pause tap; pause latency includes Wispr's round trip (a local keyword spotter that avoids it is **not built**) | ✅ phrases · ❌ KWS |
| 12 | **Phone stops listening when the screen locks** | iOS/Android suspend web audio in the background | `visibilitychange` | foreground-only design: wake lock + black Pocket screen; documented limit | 🟡 |
| 13 | **Mic blocked on a phone** | `getUserMedia` needs a secure context | `NotAllowedError` | `HTTPS=1` self-signed dev cert (or tunnel); clear in-app guidance | 🟡 |
| 14 | **Clock skew corrupts latency numbers** | device vs server clocks differ | negative or huge stages | ping/pong offset (minimum-filter), server-side timings as a backstop, outliers dropped | ✅ |
| 15 | **Embedding model unavailable offline** | first run downloads ~23 MB | boot log, badge "hash fallback" | `pnpm --filter @synapse/server warm-models` before the demo; lexical hash fallback keeps everything running (lower recall quality) | ✅ |
| 16 | **Lost encryption key = unreadable memory** | key lives in the OS credential store | boot error "does not match" | passphrase option (portable), clear error, keyfile fallback; by design there is no recovery | ✅ |
| 17 | **A second process opens the database** | SQLite single writer + in-RAM caches | seed CLI refuses if the server is up | documented; one server owns the DB | ✅ |
| 18 | **Noise / multiple speakers / bystanders** | one mic, no diarization | transcripts about other people | asides and speech to others are never stored; owner-only speaker verification **not built** | ❌ |
| 19 | **Proactive suggestion at a bad moment** | interruption cost | a suggestion during speech (test asserts none) | delivery only after ≥1.2 s of silence on every device, value-ranked, rate-limited, cooldowns, thresholds rise on dismissal | ✅ |
| 20 | **Battery claims overstated** | only a *model* of energy, not a measurement | Battery Lab labels it "model" | VAD-gated radio, eco mode, batching; real battery deltas shown where the Battery API exists (Chromium only) | 🟡 |

**What we would build next:** on-device keyword spotting so the pause phrase never reaches Wispr, local speech-to-text for `LOCAL_ONLY`, owner-only speaker verification, a real calendar integration, and an Android foreground-service wrapper for true background capture.
