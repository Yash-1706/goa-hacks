# Synapse — Product Requirements Document (PRD)

> **Problem Statement 4 · Ambient Cognitive Offloading** — *"Your Voice is a Second Brain — Build the Synapse"*
> WhisperFlow Hackathon 2026 · 24-hour build · Primary technology: **Wispr Flow API**
> Status: v1.0 (build-ready) · Date: 2026-10-06 · Companion doc: [`TRD.md`](./TRD.md)

---

## 0. TL;DR

**Synapse** is an always-on, privacy-first "second brain" that listens to you think out loud — mumbles, pauses, false starts, whispers — and quietly turns those fragments into finished work: tickets, GitHub issues, code snippets, calendar holds, email drafts, decisions and notes. It does this **without any commands**. It keeps a personal **knowledge graph** of what you have said and lets you ask vague questions about it (*"that caching idea from Tuesday, when I was walking?"*). It brings up the right memory at the right moment, and it forgets by default. You can whisper *"pause memory"* and the microphone is released within a second.

The product bet is that the gap between a thought and an action should take no effort. A voice assistant waits for commands. A second brain notices what you meant.

**Core loop:** `Speak (fragmented) → Wispr Flow transcribes (context-primed) → Synapse stitches fragments into thoughts → infers the latent intent → drafts the artifact in under 1 s → links it into memory → follows up at the right moment.`

---

## 1. Problem

The most valuable ideas get lost between thought and action. People think out loud in the shower, on walks and while driving, but that speech is:

1. **Fragmented**: *"Uhh, so the auth thing… maybe JWT but shorter expiry? Or no, OAuth2… shit, what did Sarah say?"*
2. **Context-dependent**: "that bug from yesterday", "the thing Sarah said", "that idea".
3. **Ephemeral**: nobody types it up, so it is gone.

Current tools fall short in predictable ways:

| Tool class | What breaks |
|---|---|
| Dictation (incl. Wispr Flow itself) | Turns speech into *text* faithfully, but the output is still just text. You have to know what you want and where it goes. |
| Voice assistants | Command-driven ("Hey X, create a ticket"). They fail on half-formed thoughts and have no long-term memory. |
| Meeting / ambient recorders | Produce transcripts and summaries after the fact. Little real-time action, and often creepy (they store everything, including other people). |
| Note apps / PKM | Capture needs explicit effort. Links between ideas are manual. |

**Insight:** what's missing is an **intelligence layer** that sits between speech and action and does four jobs. It reconstructs intent from fragments. It decides what deserves to exist. It remembers selectively. It speaks up only when it is worth the interruption.

**Market context (see [`RESEARCH.md`](./RESEARCH.md)):** big tech now owns ambient voice memory. Bee went to Amazon (2025), Limitless to Meta (2025), and Apple announced Watch "Audio Intelligence" (Sep 2026). The backlash pattern is consistent: hidden recording, consent off by default, auto-sharing, bystander capture, hallucinated "facts". **No product turns fragmented thinking-out-loud into developer-grade artifacts with a privacy model people can defend.** That is Synapse's lane.

---

## 2. Goals and non-goals

### 2.1 Goals (hackathon scope)
1. **G1. Fragment intelligence:** reconstruct coherent intent from broken, multi-pause, self-correcting speech, and produce structured artifacts with zero explicit commands.
2. **G2. Proactivity:** act before the user asks. Detect recurring concerns, answer open questions from memory, draft messages, generate reusable snippets.
3. **G3. Memory depth:** a cross-session personal knowledge graph with vague, temporal and situational recall, plus resurfacing of related past thoughts.
4. **G4. Defensible privacy:** an ephemeral-by-default, encrypted, local-first design with an instant whispered kill-switch and fully transparent memory.
5. **G5. Live-demo robustness:** survive a judge rambling incoherently for 2 minutes, with accents, whispers and interruptions.
6. **G6. Measured performance:** under 1 s from fragment to artifact, with every stage instrumented and benchmarked.

### 2.2 Non-goals
- Not a meeting recorder or multi-speaker transcriber. Synapse models **one owner's** inner monologue.
- No sending of email or messages on the user's behalf without consent (*draft-first* policy).
- No native iOS or Android apps in 24 h. Mobile is a **PWA** ("Pocket mode").
- No custom ASR. Transcription is **Wispr Flow's** job. Synapse is the intelligence layer around it.
- No multi-tenant SaaS, billing or auth system. This is a single-user prototype with device pairing.

---

## 3. Users and scenarios

**Primary persona (demo domain: Developer Workflow).** Rio, a senior backend engineer. They debug by muttering, design on walks and lose half their good ideas before reaching a keyboard. They want issues, snippets and follow-ups to *just exist*.

**Secondary persona.** Sam, a founder or PM who rambles strategy while driving or walking and needs board-prep material assembled from weeks of scattered thoughts.

**Design-compatible (not demoed).** A clinician thinking aloud on rounds. The architecture (local-first, encrypted, ephemeral, redaction before cloud) is designed to HIPAA principles, but the prototype is not a certified medical device.

### Key scenarios (these drive the demo)
| # | Scenario | What Synapse does |
|---|---|---|
| S1 | Rio rambles about a bug across 4 pauses: *"That bug from yesterday… the null pointer… in the cart service… probably the discount code…"* | Stitches the 4 fragments into one thought. Resolves "that bug from yesterday" to yesterday's NPE note. Drafts a GitHub issue *"NPE in cart-service discount-code path"* with a repro hypothesis. |
| S2 | *"Maybe JWT but shorter expiry? Or no, OAuth2… what did Sarah say?"* | Builds a Decision card: **OAuth2** chosen, ~~JWT with shorter expiry~~ rejected. Detects the open question "what did Sarah say?", finds Monday's thought *"Sarah: use OAuth2 + PKCE for mobile"* and surfaces it quietly. |
| S3 | *"I need to email the team about the delay"* | Drafts an email to the team with context from recent thoughts about the delay. |
| S4 | *"Maybe a recursive… no, iterative approach with memoization"* | Produces a code snippet (iterative + memo) with a short explanation, linked to the topic it was about. |
| S5 | *"The sky is nice today"* / *"Wait, was that my phone?"* | Journal (ephemeral) / filtered out. Nothing is created. |
| S6 | Rio mutters about the Thursday standup clashing with the dentist **3× in 10 min** | Suggests a reschedule with concrete alternative slots, at the next natural pause and never mid-sentence. |
| S7 | *"What was that idea I had about caching last Tuesday while I was walking?"* | Applies temporal ("last Tuesday") and situational ("walking") filters plus a semantic match. Answers with cited source thoughts (time, device, activity). |
| S8 | Rio whispers *"pause memory"* | Mic released and indicator off within 1 s. The pause phrase and the trailing window are never stored. Resuming requires a deliberate tap. |
| S9 | Rio thinks on the phone while walking, then sits at the laptop | The desk view already has the walk's thoughts, cards and graph updates. One memory, many devices. |

---

## 4. Judging criteria → product pillars (traceability)

PS4 criteria, with the universal criteria in parentheses:

| Criterion (weight) | Product pillar | Signature features (judge-visible) |
|---|---|---|
| **Fragment Intelligence (30%)**, *(Technical Sadism 30%)* | Cortex | Thought stitching across pauses · self-repair resolution with a visible "reasoning trail" · latent-intent taxonomy · reference resolution over 72 h · sub-second artifact drafting · morphing live cards |
| **Proactivity (25%)**, *(Autonomy 15%)* | Prefrontal | Recurring-concern detector (3× / 10 min) · open-question answering from memory · person + task → draft · repeated-pattern → snippet · interruption-aware timing (speaks at pauses only) · autonomy ladder |
| **Memory Depth (20%)**, *(Context Intelligence 20%)* | Hippocampus | Personal KG (sessions, thoughts, entities, decisions, artifacts) · vague, temporal and situational recall with citations · memory echo · contradiction detection · self-healing Wispr dictionary |
| **Privacy Architecture (15%)** | Guardian | Whispered "pause memory" kill-switch · audio never stored and never touches our server · 72 h working memory with crypto-shredding · encrypted at rest · redaction before cloud LLM · memory ledger and audit trail |
| **Creep Factor (10%)**, *(Voice Paradigm Innovation 25%)* | Trust UX | Draft-first (never sends for you) · "Why I kept this" explanations · fading ephemeral nodes · gentle rail, no pop-ups · "forget that" retraction |
| *(Demo Robustness 10%)* | Resilience | Aggressive segmentation + stitching · whisper-sensitive VAD · abstention on nonsense · offline/heuristic degradation · Wispr REST fallback |

---

## 5. Product principles
1. **Infer, don't command.** No wake words, no command grammar. The only voice controls are privacy controls (pause, forget), and even those are matched by meaning, not by exact keywords.
2. **Draft-first, consent-to-send.** Synapse can create anything private and reversible. Anything that reaches *another human* needs a yes.
3. **Forget by default, remember by signal.** Memory is earned through rehearsal, actionability, emphasis and relevance, like human consolidation.
4. **Never interrupt a thought.** Suggestions arrive at natural pauses, ranked by expected value, rate-limited and learn from dismissals.
5. **Show the reasoning.** Every card can show its source fragments, what was resolved, what was rejected and why it was kept.
6. **The microphone is sacred.** The listening state is always visible. Pause physically releases the mic. Audio never persists.
7. **Only what you said.** No inference about emotions, health or relationships (the EU AI Act bans emotion inference at work). Other speakers are never identified, and speech addressed to other people is not stored.

---

## 6. Functional requirements

Priority: **P0** = must ship for the demo, **P1** = should ship (big score impact), **P2** = stretch.

### 6.1 Capture: "Ear" (ambient listening)
| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| CAP-1 | Continuous listening in the browser (desk and phone) with on-device voice activity detection (VAD). Audio streams to Wispr Flow **only while speech is detected**. | P0 | Silence produces zero network audio. Speech onset to first packet sent ≤ 150 ms (pre-roll included). |
| CAP-2 | Whisper-sensitive detection: a calibrated noise floor and a lowered VAD threshold catch whispered or muttered speech. | P0 | ≥ 9/10 whispered test phrases segmented in a quiet room. |
| CAP-3 | Aggressive segmentation: commit an utterance after a short pause (~500 ms) so each fragment becomes an independent Wispr transcription. Synapse re-stitches them (see CTX-1). | P0 | A 2-min ramble yields 15–60 fragments, none lost. |
| CAP-4 | Context-primed transcription: every Wispr session sends `dictionary_context` (learned jargon and names), `conversation` (recent fragments) and the user's name. | P0 | Dictionary terms visible in a debug panel. Names like "Sarah" and "cart service" are spelled consistently. |
| CAP-5 | Per-fragment features: start/end time, pause-before, duration, RMS volume, whisper flag, detected language, device, activity (walking/still/driving, mobile only). | P0 | Stored with each fragment and shown on hover. |
| CAP-6 | Multilingual and code-switching passthrough (e.g., `["en","hi"]` Hinglish). Language auto-detect by default. | P1 | Mixed-language fragment produces a correct English artifact. |
| CAP-7 | A dev/test transcript injector (type or replay a scripted ramble with timings) so everything works without a mic or API keys. | P0 | `pnpm replay <script>` drives the full pipeline. |
| CAP-8 | **Local STT fallback** (on the user's own laptop, ONNX ASR) for when Wispr is unreachable or `LOCAL_ONLY` is on. Clearly badged as "local STT". | P1 | Pulling the network keeps the capture → card loop alive (degraded quality). |
| CAP-9 | **Wispr context minimization:** never send `screenshot`, `content_text` or `content_html`. `conversation` is capped at 6 recent fragments and redacted. | P0 | Code audit + unit test on the context builder. |

### 6.2 Fragment intelligence: "Cortex"
| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| CTX-1 | **Thought stitching:** group consecutive fragments into a *thought* using time gap, semantic continuity and incompleteness cues. Split on topic shift. | P0 | Scenario S1 (4 fragments) becomes 1 thought. Two unrelated topics 3 s apart become 2 thoughts. |
| CTX-2 | **Latent-intent detector** with a 13-class taxonomy: `action`, `bug`, `communication`, `scheduling`, `code`, `decision`, `idea`, `question`, `journal`, `aside`, `recall_query`, `privacy`, `correction`. | P0 | Macro-F1 ≥ 0.85 on the golden corpus (≥ 60 labelled thoughts). |
| CTX-3 | **Reconstruction:** a clean, complete restatement of what the user meant, with resolved references, **self-repairs** (rejected → chosen) and **open questions** listed. | P0 | S2 shows OAuth2 chosen, JWT rejected, open question about Sarah. |
| CTX-4 | **Artifact drafting** per class: Jira-style ticket, GitHub issue, email/Slack draft, calendar event (+ `.ics`), code snippet + explanation, code comment, decision record, note, journal entry. | P0 | Each class produces a schema-valid artifact. Fields render in the card. |
| CTX-5 | **Progressive "living" cards:** the card appears on the first fragment and morphs as more fragments arrive. Version history is viewable. | P0 | Visible morph in S1/S2. Card updates within the latency budget. |
| CTX-6 | **Reference resolution** for "that thing / that bug / what Sarah said" against ≤ 72 h of history (working + long-term memory), with an "assuming you mean X" chip when uncertain. | P0 | ≥ 80% correct on the coreference test set. Ambiguous cases show the assumption. |
| CTX-7 | **Abstention / noise robustness:** nonsense, asides, filler and **speech addressed to other people** ("want a coffee?") create *no* artifacts and are not stored. A counter shows how many were filtered. | P0 | On a 2-min nonsense ramble, ≤ 1 spurious artifact. |
| CTX-8 | **Natural corrections:** "no, not that one", "scratch that" or "actually make it Friday" revise or retract the most relevant recent card. | P1 | Correction updates the card. "Scratch that" deletes the thought. |
| CTX-9 | **Reasoning trail UI:** the raw fragments (with pause gaps and whisper styling), the resolved references, struck-through rejected options and "why kept". | P0 | Every card has a "trail" drawer. |
| CTX-10 | **Session Brief:** at session end, or on a natural ask ("what did I just say?"), a structured summary: tasks, decisions, snippets, open loops, and the number of fragments filtered. | P0 | Generated in ≤ 5 s after a 2-min monologue. |

### 6.3 Memory: "Hippocampus"
| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| MEM-1 | **Three-tier memory:** sensory buffer (audio, RAM only, seconds), working memory (fragments + thoughts, **72 h TTL**), long-term memory (promoted thoughts, entities, decisions, artifacts). | P0 | TTL expiry verified by a time-travel test. Audio never written to disk. |
| MEM-2 | **Implicit promotion by speech patterns:** a salience score from rehearsal (repetition), natural emphasis cues ("note to self", "important"), actionability, entity anchoring, prosodic emphasis and later revisits. Every promotion is explained. | P0 | "Why kept" lists the contributing signals. A repeated thought is promoted. A one-off observation is not. |
| MEM-3 | **Personal knowledge graph:** nodes for Session, Thought, Entity (person, project, component, technology, bug, event, place, topic), Decision, Artifact and OpenLoop. Typed edges include mentions, refines, contradicts, answers, follows-up, same-topic and produced. | P0 | Graph API returns nodes and edges. Entities are deduplicated ("auth thing" ≈ "auth module"). |
| MEM-4 | **Consolidation ("sleep") job:** periodically merge entities, link related thoughts across sessions, summarize topics, apply TTL and promotion, and refresh the dictionary. | P1 | Runs every ≤ 10 min and on idle. The graph gains cross-session edges. |
| MEM-5 | **Self-healing dictionary:** learn jargon, names and corrected mis-hearings from memory. Push the top-N to Wispr `dictionary_context`. | P0 | Dictionary grows during the demo. The debug panel shows term sources. |
| MEM-6 | **Memory echo:** when a topic resurfaces, show the most relevant past thought(s) from other sessions. | P0 | S2/S7 show echoes with source time and activity. |
| MEM-7 | **Contradiction and drift detection:** *"On Tuesday you chose OAuth2; today you're leaning JWT. Revisit?"* | P1 | Shown at least once in the demo script. |

### 6.4 Recall
| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| REC-1 | **Natural voice recall.** Questions directed at memory are detected by meaning (no wake word). Typed search is also available. | P0 | S7 works by voice. |
| REC-2 | **Constraint parsing:** time ("last Tuesday", "yesterday afternoon", "earlier in the hackathon"), situation (walking, driving, at desk, on phone), topic, type (idea, bug, decision) and person. | P0 | Parsed constraints are shown as chips on the answer. |
| REC-3 | **Hybrid retrieval:** semantic + lexical + entity + recency/salience scoring, then a 1-hop graph expansion. | P0 | Recall@3 ≥ 80% on the vague-query test set. |
| REC-4 | **Cited answer:** sources appear fast (≤ 500 ms after the transcript), then a streamed synthesized answer cites them. Optional spoken answer (TTS). | P0 | Every claim links to a source thought. |
| REC-5 | **Graceful relaxation:** if constraints over-filter, relax them in order and say so ("Nothing Tuesday; closest is Wednesday morning at your desk…"). | P1 | Demonstrated on a deliberately wrong query. |

### 6.5 Proactivity: "Prefrontal"
| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| PRO-1 | **Recurring-concern detector:** the same concern N times within a window (default 3 in 10 min) triggers a suggestion (e.g., meeting conflict → reschedule with concrete slots from the calendar). | P0 | S6 fires exactly once, with slots. |
| PRO-2 | **Person + task → draft message** (email or Slack) addressed to the resolved person. | P0 | S3-like utterances create drafts. |
| PRO-3 | **Repeated pattern → reusable snippet:** a code or process pattern mentioned in ≥ 2 contexts becomes a snippet in the library. | P1 | Demo: "retry with backoff" twice produces a snippet. |
| PRO-4 | **Open-question answering:** self-directed questions ("what did Sarah say?") are answered quietly from memory when confidence is high. Otherwise they become open loops. | P0 | S2 shows Sarah's earlier input. |
| PRO-5 | **Interruption-aware delivery:** suggestions queue during speech and surface at pauses (≥ 1.2 s silence). Expected-value gating, max 1 per 2 min, cooldown per pattern. | P0 | No suggestion appears while VAD reports speech. |
| PRO-6 | **Autonomy ladder:** L0 observe → L1 draft (auto) → L2 stage (auto, one-tap or "yes" to commit) → L3 execute (auto **only** for private, reversible, self-only actions above the confidence threshold, e.g., an issue in a sandbox repo or a tentative hold on one's own calendar). | P0 | Policy table enforced in code. Nothing reaches another human without consent. |
| PRO-7 | **Feedback learning:** accept or dismiss adjusts per-pattern thresholds (self-tuning proactivity). | P1 | Thresholds visible in settings and change after feedback. |

### 6.6 Privacy: "Guardian"
| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| PRV-1 | **Whispered kill-switch:** "pause memory" (and meaning-equivalents such as "stop listening" or "off the record") stops capture on **all** devices. The mic track is released, the in-flight Wispr session is aborted without commit, and a distinct "closing" earcon plays. | P0 | End of phrase → mic released **≤ 1 s (p95)**. The phrase itself is never stored. |
| PRV-2 | **Retroactive purge:** pausing also purges the trailing window (default 30 s, configurable). "Forget that" or "forget the last five minutes" deletes by meaning or by window. | P0 | Purged items disappear from the UI, DB and indexes. The audit log records counts only. |
| PRV-3 | **Resume is deliberate:** a tap or click is required (the mic is off, so voice resume would be a contradiction). | P0 | No voice path resumes capture. |
| PRV-4 | **Audio never persists and never touches Synapse's server.** The browser streams directly to Wispr with a short-lived client token. Our server sees text only. | P0 | Code audit: no audio write paths. Server has no audio endpoints in client mode. |
| PRV-5 | **Encryption at rest:** all transcript, thought, artifact and embedding payloads use AES-256-GCM. Working memory uses **per-day keys**, destroyed at TTL (crypto-shredding). | P0 | DB file contains no plaintext. The expired day-key is gone and its rows are undecryptable. |
| PRV-6 | **Redaction before cloud:** emails, phone numbers, card, ID, IBAN and key-like secrets are replaced with placeholders before the LLM call and re-hydrated locally. Optional pseudonymization of person names. | P1 | Unit tests on the redactor. LLM request logs show placeholders. |
| PRV-7 | **Memory ledger:** browse everything stored, why it was kept, its expiry countdown, delete anything, and export all data. | P0 | Privacy Center screen. |
| PRV-8 | **Tamper-evident audit trail** (hash-chained) of data lifecycle events (captured, promoted, sent-to-cloud, expired, purged) without content. | P1 | Chain verifies. Demo shows the purge event. |
| PRV-9 | **Owner-only memory (bystander protection):** speaker verification drops speech that isn't the enrolled owner's. Off by default for the judge demo. | P2 | Toggle plus enrolment flow. |
| PRV-10 | **Local-only mode:** a toggle disables all cloud LLM calls (and, with CAP-8, cloud STT), degrading to local heuristics. | P1 | Pipeline still produces classified fragments and notes. |
| PRV-11 | **Cascade deletion:** deleting, purging or expiring a thought removes everything derived from it (fragments, versions, artifacts, edges, embeddings, index entries, dictionary terms learned only from it). | P0 | Test: after deleting T-x, no row or index entry references it. |
| PRV-12 | **No sensitive inference:** no emotion, health, relationship or other-speaker identification features anywhere in the pipeline or schemas. | P0 | Schema review. |

### 6.7 Cross-device and mobile ("Pocket mode")
| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| DEV-1 | Installable PWA. Pocket mode has a minimal screen: big state ring, last card, pause button. | P0 | Runs on an Android or iOS phone over HTTPS. |
| DEV-2 | One memory across devices: sessions are tagged by device, and cards, graph and suggestions sync in real time. | P0 | Speak on the phone and the card appears on the desk in ≤ 1 s. |
| DEV-3 | Activity context on mobile (still, walking, vehicle) from motion sensors, stored as a coarse label only. | P1 | "While I was walking" recall works. |
| DEV-4 | **Battery and thermal optimization:** an energy pre-gate before VAD, VAD-gated radio, packet batching in Eco mode, adaptive frame skipping, battery-aware mode switching, and all heavy compute on the "brain" (laptop/server). | P0 | "Battery Lab" panel shows measured CPU-ms/min, radio-active %, bytes/min, and modeled energy vs naive streaming (target ≥ 70% reduction). |

### 6.8 Integrations ("Outbox")
| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| INT-1 | Outbox of drafted artifacts with accept, edit (voice or text) and dismiss. | P0 | All artifacts land here. |
| INT-2 | **GitHub issues (real)** via a fine-grained token into a configured repo (sandbox by default). | P0 | Accepted bug or action creates a real issue. The link is shown. |
| INT-3 | Jira Cloud issue (real if credentials exist, else simulated). | P1 | Toggle by env. |
| INT-4 | Calendar: local calendar model for conflict detection + `.ics` export. Google Calendar is optional. | P0 / P2 | Reschedule suggestion uses calendar data. |
| INT-5 | Email: draft with `mailto:` and copy. Gmail draft API is optional. | P0 / P2 | Draft opens in a mail client. |

### 6.9 Observability and deliverables support
| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| OBS-1 | **Latency HUD** per fragment: speech-end → Wispr-final → triage → card-first-paint → artifact-complete. | P0 | Visible on every card and in a live sparkline. |
| OBS-2 | **Benchmark export:** p50/p95 per stage across N fragments, exported to `docs/LATENCY.md` + CSV. | P0 | `pnpm bench` generates the report. |
| OBS-3 | **Knowledge-graph visualization:** sessions color-coded, cross-session semantic links, entity hubs, working-memory nodes fading toward expiry, and a timeline scrubber replaying memory growth. | P0 | Shows ≥ 5 sessions connected semantically. |
| OBS-4 | Docs deliverables: architecture diagram, privacy whitepaper (1 page), failure-mode analysis (1 page), latency report, demo script, pitch outline. | P0 | Present in `/docs`. |

---

## 7. Experience design

### 7.1 Desk mode (laptop, primary demo surface)
A three-column layout on a dark, calm theme:
1. **Stream (left):** live fragments as they arrive (gray, italic for whispers, pause gaps as `⋯ 1.4s`) grouped into thought bubbles that "snap" together as the stitcher links them.
2. **Cards (center):** living artifact cards (ticket, issue, email, event, snippet, decision, note) that morph in place. Each has a latency badge, confidence, "why kept" and a trail drawer. Filtered asides collapse into a single counter chip ("7 asides filtered").
3. **Synapse rail (right):** quiet proactive suggestions, memory echoes, answers to open questions and recall results, each with Accept / Not now.

Top bar: listening-state orb (listening / hearing / thinking / paused), device indicators, privacy shield, and a latency sparkline.

Other screens: **Graph** (full-screen knowledge graph + timeline scrubber), **Recall** (ask and answer with sources), **Privacy Center** (ledger, TTL countdowns, purge, export, audit chain, local-only toggle), **Lab** (latency benchmarks, battery lab, dictionary, eval results), **Outbox**.

### 7.2 Pocket mode (phone)
A single large orb that breathes when listening, a big tappable pause control, the last 1–3 cards (read-only), and an activity indicator (🚶 walking). Designed to be glanced at, not used.

### 7.3 Interaction rules
- Sound: an optional soft earcon when a card is created or a suggestion is queued. No speech output unless answering a recall question (TTS can be toggled off).
- Suggestions never appear mid-utterance. Max 1 per 2 minutes unless it answers an open question just asked.
- Every proactive item says *why* ("You've mentioned the Thursday conflict 3 times in 8 minutes").

---

## 8. Success metrics (demo-day targets)

| Metric | Target | How measured |
|---|---|---|
| Fragment → first card paint (Wispr final → card visible) | **p50 ≤ 600 ms, p95 ≤ 1.0 s** | Latency HUD / `pnpm bench` |
| Fragment → complete artifact (Wispr final → all fields) | **p50 ≤ 1.0 s**, p95 ≤ 1.6 s | Same |
| Speech end → complete artifact (includes Wispr) | p50 ≤ 1.6 s (reported honestly) | Same |
| Whispered "pause memory" → mic released | **p95 ≤ 1.0 s** | Privacy test script |
| Intent classification (13 classes) | Macro-F1 ≥ 0.85 | `pnpm eval` on the golden corpus |
| Spurious artifacts on a nonsense ramble | ≤ 1 per 2 min | Nonsense corpus + live test |
| Reference resolution accuracy | ≥ 80% | Coreference test set |
| Recall@3 on vague queries | ≥ 80% | Recall test set |
| Recall: sources visible after transcript | ≤ 500 ms | HUD |
| Mobile modeled energy vs naive streaming | ≥ 70% reduction | Battery Lab |
| Audio bytes persisted anywhere | **0** | Code audit + DB/FS scan test |

---

## 9. Demo plan

### 9.1 Before the demo (hackathon dogfooding)
From roughly hour 8, team members run **Pocket mode** on their phones and think out loud while working, walking and eating. This creates **real** memory across ≥ 5 sessions for the Recall Demo and the graph ("earlier in the hackathon"). A seed script exists for development only. The demo uses real captured sessions.

### 9.2 Live demo runbook (also the 3-minute pitch spine)
1. **Hook (0:00–0:20).** "Ideas die between thought and action. Synapse is the connection." The orb is breathing and listening.
2. **Live monologue (0:20–1:20).** A judge rambles (or the presenter does a deliberately messy ramble). The audience watches fragments snap into thoughts and cards morph: a GitHub issue, an email draft, a code snippet, a Decision with JWT struck through. "11 asides filtered." Open question → *"Sarah said OAuth2 + PKCE on Monday."*
3. **Proactivity (1:20–1:45).** The pre-planted meeting-conflict mutter (3×) produces a reschedule suggestion at the pause.
4. **Recall (1:45–2:15).** A vague voice query about something from earlier in the hackathon gets a cited answer with time, device and activity chips, and the graph lights up.
5. **Privacy (2:15–2:40).** Whisper "pause memory": orb goes dark, mic released (latency shown), trailing 30 s purged (ledger shows it). Resume needs a tap.
6. **Close (2:40–3:00).** Latency p50/p95 numbers, the architecture slide, and "Magical, not stalker: draft-first, forget-by-default, mic-sacred."

### 9.3 Demo safety nets
- Venue noise: a directional or lapel mic plus a calibrated noise floor. The whisper test is rehearsed in the room.
- Wi-Fi failure: a phone hotspot. If Wispr is unreachable, the app shows the degraded state honestly (no fake video). The REST fallback is tried automatically.
- LLM slow or failing: the local triage classifier still produces provisional cards (marked as such).

---

## 10. Deliverables checklist
| Deliverable | Where | Owner |
|---|---|---|
| Working prototype (live) | `apps/` | all |
| Live Monologue Demo | Desk mode + Session Brief | demo lead |
| Knowledge Graph Visualization (≥ 5 sessions) | Graph screen | frontend |
| Privacy Whitepaper (1 page) | `docs/PRIVACY_WHITEPAPER.md` | privacy lead |
| Recall Demo | Recall + voice | backend |
| Architecture Diagram | `docs/ARCHITECTURE.md` (Mermaid) + Lab screen | backend |
| Latency Benchmark | `docs/LATENCY.md` (generated) | backend |
| Failure Mode Analysis (1 page) | `docs/FAILURE_MODES.md` | all |
| 3-minute pitch | `docs/PITCH.md` | demo lead |

---

## 11. Risks and mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| Wispr API access or key not ready at start (access is "exclusive"; orgs must be approved) | Blocks live transcription | Ask the organizers for keys in hour 0. Transcript injector + replay mode (CAP-7) lets all other work proceed. Local STT fallback (CAP-8). Both client-token and server-proxy modes. |
| Wispr finalization latency is variable | Misses the speech-end SLA | Pre-authenticated standby socket, warm-up pings, aggressive segmentation, and reporting both stage timings honestly. |
| Wispr auto-edit "cleans away" self-repairs inside one utterance | Loses the rejected-alternative signal | Short segmentation means repairs usually span fragments, so Synapse sees both sides. The LLM also infers repairs from residual cues. |
| LLM hallucinated tasks from nonsense | Destroys trust in the demo | Abstention class, confidence thresholds, local noise pre-filter, nonsense test corpus, draft-first. |
| Whispers not caught by VAD | Kill-switch fails | Calibrated noise floor, lowered thresholds, energy pre-gate, in-room rehearsal, plus a tap fallback that is always visible. |
| Mobile mic needs HTTPS and the screen on | Pocket mode breaks | HTTPS via tunnel or self-signed certificate. Wake Lock during sessions. Documented limits (a PWA cannot record with the screen off on iOS). |
| Creepiness perception | Lower Creep score | Visible state, draft-first, forget-by-default, fading nodes, "why kept", owner-only option. |
| Scope blow-up in 24 h | Unfinished demo | Strict P0 → P1 → P2 build order (TRD §18). Dogfood from hour 8. |

---

## 12. Open questions for the team
1. Which GitHub repo should accepted issues go to? (Default: a new private sandbox repo.)
2. Do we have Jira Cloud credentials, or should Jira be simulated?
3. Primary demo phone: Android (better PWA capabilities, Battery API) or iOS?
4. Languages to prime: `["en"]` or `["en","hi"]` for Hinglish rambles?
5. Should the presenter or a judge perform the scripted meeting-conflict mutter during the demo?

---

## 13. Glossary
- **Fragment:** one VAD-segmented utterance, transcribed by Wispr Flow as its own session.
- **Thought:** one or more stitched fragments carrying a single intent.
- **Artifact:** the structured output of a thought (ticket, issue, draft, event, snippet, decision, note).
- **Working memory:** ephemeral (72 h) encrypted store of fragments and thoughts.
- **Long-term memory:** promoted thoughts, entities and decisions, i.e. the knowledge graph.
- **Promotion:** moving a thought into long-term memory based on salience signals in speech.
- **Open loop:** an unresolved question or commitment detected in speech.
