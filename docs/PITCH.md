# 3-minute pitch

*Spoken over the live demo ([DEMO_SCRIPT.md](./DEMO_SCRIPT.md)). No slides.*

## Script (≈ 400 words)

**[0:00] Hook.** "The most valuable ideas are lost in the gap between thought and action. You mutter *'I should refactor that auth module'* in the shower, and it's gone. Voice assistants don't fix that: they wait for commands. Dictation doesn't either: it gives you text, not work. **Synapse listens to you think, and does the rest.** I'm not going to type or say a single command."

**[0:20] Fragment intelligence.** "Watch. *(judge rambles)* Fragments stream in with their real pauses; Synapse stitches them into one thought and decides what it *is*. A bug becomes a GitHub issue that fills itself in as the model streams. *'Maybe JWT… or no, OAuth2'* keeps the rejected option as memory. *'That bug from yesterday'* resolves to yesterday's actual thought, and when it isn't sure, it says *'assuming you mean…'*. The sky is journal, *'was that my phone'* is filtered. A first card paints in about {first-paint} ms; the full artifact lands in {artifact} ms from Wispr's final text."

**[1:20] Proactivity.** "I've now muttered about the Thursday clash three times. Nobody asked, but at the next *pause*, never mid-sentence, Synapse says: *'You've mentioned this three times in four minutes'* and offers three real free slots. Accept, and it holds one. Dismiss it, and it gets quieter next time."

**[1:45] Memory.** "I'm asking from earlier today, vaguely: *'that caching idea while I was walking.'* Sources appear instantly, then a cited answer: when, where, on which device. This is the graph of five sessions from our hackathon: the entities bridge them, and the faded nodes are working memory that will expire."

**[2:15] Privacy.** "Always-on has to be defensible. *(whisper)* The password is hunter two. *(whisper)* Pause memory. The mic is released, the last thirty seconds are purged, the phrase is never stored, and resuming takes a deliberate tap. Audio goes only to Wispr and is never written anywhere; text is redacted before Claude sees it; everything at rest is encrypted, working memory is crypto-shredded after 72 hours, and this audit chain proves nothing was altered."

**[2:40] Close.** "Draft-first. Forgets by default. The mic is sacred. Macro-F1 {Y}% on phrasings it has never seen, p50 {Z} ms, zero audio stored. **Synapse: your voice is a second brain.**"

## Claim → evidence (have these open)

| Claim | Evidence |
|---|---|
| Reconstructs intent from broken speech | `/` Desk trail drawer · `docs/EVAL.md` held-out set (phrasings outside the classifier exemplars, reported separately from the leaky dev set; not a blind test, see the note in the report) |
| First paint is instant, artifact in about a second | latency badge per card · `/lab` · `docs/LATENCY.md` (run `pnpm bench --live`) |
| Proactive without being creepy | WHY line on every suggestion · only at ≥1.2 s of silence · thresholds adapt on dismiss (`/lab`) |
| Recall by vague, time/place-constrained query | `/recall` constraint chips · `/graph` · recall eval |
| Privacy is architecture, not a promise | `/privacy` ledger, key list, audit verify · `docs/PRIVACY_WHITEPAPER.md` |
| It survives chaos | scripted nonsense ramble creates 0 spurious artifacts · 130+ automated tests · every failure has a fallback (`docs/FAILURE_MODES.md`) |

## Likely judge questions

- **"Isn't this just dictation plus an LLM?"** Dictation returns text. Synapse stitches fragments across pauses, resolves self-repairs and references against days of memory, decides what deserves to exist, and stays silent on the rest. The interaction (think out loud, no commands, forget by default) is impossible without voice.
- **"What happens offline / when Claude is down?"** A local cortex still classifies, drafts and recalls (see EVAL: offline fallback numbers), and cards are honestly badged "degraded".
- **"Where does my audio go?"** Browser → Wispr, directly, short-lived token, held in RAM until the final text returns. Our server never sees it.
- **"Isn't always-on listening creepy?"** That is the design constraint: visible mic, instant pause, nothing stored from asides, 72 h forgetting, draft-first, and a *why* on everything it surfaces.
