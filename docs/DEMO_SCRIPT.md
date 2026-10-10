# Live demo runbook (3 minutes)

*Live demo is mandatory: no video. This script is also the spine of the pitch ([PITCH.md](./PITCH.md)). Every line a judge or presenter says below is taken from the problem statement's own examples.*

## Pre-flight (do this an hour before)

| ✓ | Step | Command / where |
|---|---|---|
| ☐ | Keys in `.env`: `ANTHROPIC_API_KEY`, `WISPR_API_KEY`, `WISPR_MODE=client`, `LLM_MODE=live` | copy `.env.example` → `.env` |
| ☐ | Demo pacing: `SUGGESTION_MIN_GAP_S=20`, `AUTONOMY_LEVEL=2`, optional GitHub sandbox (`GITHUB_TOKEN`, `GITHUB_REPO`) | `.env` |
| ☐ | Pre-download the embedding model (offline-safe) | `pnpm --filter @synapse/server warm-models` |
| ☐ | Start everything | `pnpm dev` → open **http://localhost:5173** full screen on the projector |
| ☐ | Phone (Pocket mode): HTTPS dev cert, then install/pair | PowerShell: `$env:HTTPS=1; pnpm dev:web` → `https://<laptop-ip>:5173/pocket` → enter the 6-digit pairing code from the server console |
| ☐ | **Dogfood**: run Pocket mode on a phone while you build, so there is *real* memory from "earlier in the hackathon" (≥5 sessions across desk and walks) | Pocket screen |
| ☐ | Room check: sit quiet 3 s (noise-floor calibration), then whisper a test sentence and confirm a card appears | Desk screen |
| ☐ | Lab screen: Wispr = client, cortex = live, latency p50 visible, battery lab populated from the phone | `/lab` |
| ☐ | **No keys / no mic?** `pnpm seed --reset` (server stopped) writes 8 backdated sessions, restart the server, and everything below works from typed input: press **K** on the Desk, type a line, **Shift+Enter** for the next fragment (it arrives after a natural pause), **Enter** to send. The seeded memory is what beat ① answers from (Sarah's OAuth2 thought) and contradicts (the earlier lean towards JWT). **No key but a microphone?** Put `WISPR_MODE=local` in `.env` for a real voice path with no key and no internet (Whisper runs on the laptop; about 40 MB downloaded once, then it loads in under 2 s): tap the orb and talk. It is a beat slower than Wispr (cards appear 1.5 to 2 s after you stop), and it is English only by default | Desk screen |
| ☐ | Fallbacks ready: phone hotspot; `pnpm replay scripts/replay/s1_bug.json` plays a ramble into the running server | terminal |
| ☐ | Warn bystanders that the demo records audio (recording-consent norms) | in person |

## The 3 minutes

| t | You do / say | The screen shows | Judging criterion |
|---|---|---|---|
| **0:00** | "Ideas die between thought and action. Synapse is the connection. I'm not going to type or command anything." The orb is breathing; the keyboard icon stays collapsed. | Orb listening, empty-state prompt | Voice paradigm |
| **0:20** | **A judge rambles for ~60 s** (or you do, in this order, pausing like a human): <br>① *"Uhh, so the auth thing… maybe JWT but shorter expiry? Or no, OAuth2… what did Sarah say?"* <br>② *"That bug from yesterday… the one with the null pointer… in the cart service…"* (whisper the next bit) *"…probably the discount code."* <br>③ *"I need to email the team about the delay."* <br>④ *"Maybe a recursive… no, iterative approach with memoization."* <br>⑤ *"Wait, was that my phone?"* … *"The sky is nice today."* | Fragments stream in with `⋯ 1.6s` pause gaps, snap into thought bubbles; ① a **decision** card with ~~JWT~~ struck through → OAuth2, a quiet answer from Sarah's earlier thought, and (because an earlier session leaned JWT) a *Decision changed: JWT → OAuth2. Revisit?* prompt; ② a **GitHub issue** that morphs as fragments arrive, "that bug → T-n" reference chip; ③ an **email draft**; ④ a **code snippet**; ⑤ "2 asides filtered", the sky goes to journal | **Fragment intelligence (30 %)**: point at the trail drawer (raw fragments, resolved references, why) and the ⚡ latency badge |
| **1:20** | Say once: *"Ugh, Thursday's standup clashes with the dentist."* … (30 s later) *"The dentist overlaps with the Thursday standup again."* … (30 s later) *"I really need to sort out the standup and dentist clash."* (If time is tight, pre-plant two mentions earlier and say the third live.) | After the pause, a **reschedule suggestion**: "You've mentioned the Thursday conflict 3 times…" with three concrete free slots; tap **Hold** → tentative hold on the calendar | **Proactivity (25 %)** |
| **1:45** | *"What was that idea I had about caching earlier, while I was walking?"* | Constraint chips (time, walking), **sources appear instantly**, then a cited answer streams ("…on your phone, 9 h ago"), the graph pulses; open **/graph** to show ≥5 sessions linked, with fading working-memory nodes and entities bridging sessions | **Memory depth (20 %)** |
| **2:15** | Whisper something you would regret keeping: *"I should tell the landlord about the lease before Friday."* (a card appears) … then, whispered: *"pause memory."* (With a live LLM, also say *"the staging password is hunter two"* once: the Privacy Center's "values masked" counter ticks up because the redactor replaced it before the call. The offline classifier simply drops that sentence as an aside, so it never shows up as a card to purge.) | Orb goes dark, "Paused"; the card **disappears** with the toast "Memory paused. 1 recent thought forgotten."; open **/privacy**: ledger, retention countdowns, destroyed keys, **Verify audit chain ✓**; point out that resuming needs a tap | **Privacy architecture (15 %)** |
| **2:40** | Close: *"Draft-first. Forgets by default. The mic is sacred. Fragment to card in {X} ms; macro-F1 {Y} on unseen phrasings; zero audio stored."* Show Lab: latency table + battery lab. | Lab screen | **Creep factor (10 %)** + credibility |

## When something goes wrong (and it will)

| Failure | What you do | What the audience sees |
|---|---|---|
| Wispr unreachable / key not approved | Switch **Local-only** on in the Privacy Center (speech moves to Whisper on the laptop at once, and the page says so), or start with `STT_FALLBACK=1` (the same, automatically, when the token request fails). Otherwise click the **keyboard icon**, type the same lines, or run `pnpm replay scripts/replay/s1_bug.json` | Voice keeps working, a little slower; the header says "on-device" (or "typed input"); everything downstream still works |
| Claude slow / rate-limited | Nothing: cards come from the local cortex, badged "degraded" | Provisional → local card; the badge is honest |
| Loud room, whisper not detected | Lapel/directional mic; press **Pause** on screen as the always-available fallback | — |
| Judge speaks Hindi/Hinglish | Keep going: Wispr auto-detects (set `WISPR_LANGUAGES=en,hi` for code-switching) | Cards in English from mixed speech |
| Phone loses mic (screen lock) | Wake lock is on; if it drops, tap the orb | Pocket reconnects, the desk keeps the memory |
| Suggestion doesn't fire | Lower `RECURRING_N` or say the clash line once more | — |
| Judge asks "can I break it?" | Yes: have them shout over each other, mumble nonsense (nothing should be created), then say "scratch that" | Asides counter climbs, spurious cards stay at zero |

## After the demo
`pnpm eval --live` → `docs/EVAL.md` · `pnpm bench --live` → `docs/LATENCY.md` · export the audit chain from `/privacy`.
