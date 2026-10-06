# Synapse — Research Notes (2026-10-06)

Research behind [`PRD.md`](./PRD.md) and [`TRD.md`](./TRD.md). Sources are linked inline. Items marked ⚠️ could not be independently verified.

---

## 1. Wispr Flow API (primary technology)

**Access:** the API is "only available by exclusive access", and an organization must be approved before using the Developer Platform ([quickstart](https://api-docs.wisprflow.ai/quickstart)). Keys come from `https://platform.wisprflow.ai` → API Keys. **Action:** get hackathon keys from the organizers in hour 0. Until then, build against mock and replay modes.

**What it is:** speech → *polished* text in 100+ languages. It applies "auto-edits" (`"6pm, actually let's do 7"` → `"7pm"`), removes fillers and corrects names ([docs](https://api-docs.wisprflow.ai/)).

**Endpoints** (base `https://platform-api.wisprflow.ai/api/v1/dash`):
| Purpose | Endpoint |
|---|---|
| WebSocket, server (API key) | `wss://…/ws?api_key=Bearer%20<KEY>` |
| WebSocket, client (JWT, recommended) | `wss://…/client_ws?client_key=Bearer%20<JWT>` |
| REST, server | `POST …/api` |
| REST, client | `POST …/client_api` |
| Mint client token | `POST …/generate_access_token` `{client_id, duration_secs, metadata?}` → `{access_token, expires_in}` |
| Warm-up | `GET …/warmup_dash` → `{"status":"warmed"}` |
| Revoke | `revoke_token`, `revoke_client_tokens` |

**WS protocol:** `auth` (token + `language[]` + `context`) → `append` (`position`, `audio_packets{packets[], volumes[], packet_duration, audio_encoding:"wav", byte_encoding:"base64"}`) → `commit {total_packets}` → responses `{status:"auth"|"info"|"text"|"error"}`. Text: `{status:"text", position, final, body:{text, detected_language}}`. Partials arrive only at ~30 s intervals. **The connection closes after the final result** (one session per utterance) ([WebSocket API](https://api-docs.wisprflow.ai/websocket_api)).

**Audio:** 16 kHz mono int16 PCM, base64. The quickstart sends **raw PCM without a RIFF header** per packet (despite `audio_encoding:"wav"`). Packet duration must be constant. `volumes` = RMS per packet ([WS quickstart](https://api-docs.wisprflow.ai/websocket_quickstart)). REST takes a base64 16 kHz WAV, max 25 MB / 6 min ([REST](https://api-docs.wisprflow.ai/rest_api_transcribe)).

**Context fields** ([request schema](https://api-docs.wisprflow.ai/request_schema)): `app{name, type: email|ai|other}`, `dictionary_context[]`, `user_identifier`, `user_first_name`, `user_last_name`, `textbox_contents{before_text, selected_text, after_text}`, `screenshot`, `content_text`, `content_html`, `conversation{id, participants[], messages[{role, content}]}`.

**Billing:** usage-based "tokens"; there are no dashboard rate-limit controls ([usage & billing](https://api-docs.wisprflow.ai/usage_billing)).

**Implications for Synapse**
1. Segment speech ourselves (VAD) and keep a pre-authenticated standby socket, because each WS session handles exactly one utterance.
2. Auto-edits erase within-utterance self-repairs. **Short segments** push repairs across fragment boundaries, where Synapse can see them.
3. `dictionary_context` + `conversation` are the hooks for "Context Intelligence": a self-healing dictionary from the knowledge graph, plus recent fragments for continuity.
4. Transcription happens in Wispr's cloud ([data controls](https://wisprflow.ai/data-controls)). Privacy claims must say "local-first *except* transcription". **Never send `screenshot`, `content_text` or `content_html`.** ⚠️ Competitor blogs allege a past Wispr screenshot-upload incident ([ModelPiper](https://modelpiper.com/blog/wispr-flow-privacy-incident)); there is no primary source.

---

## 2. Competitive landscape

Big tech now owns ambient voice memory. Amazon bought Bee in July 2025 ([TechCrunch](https://techcrunch.com/2025/07/22/amazon-acquires-bee-the-ai-wearable-that-records-everything-you-say/)). Meta bought Limitless in December 2025 ([CNBC](https://www.cnbc.com/2025/12/05/meta-limitless-ai-wearable.html)). Apple announced Watch "Audio Intelligence" in September 2026 ([Apple](https://support.apple.com/en-us/148354)). **No product turns fragmented speech into developer artifacts. That is our opening.**

| Product | Capture | Lessons |
|---|---|---|
| Omi (open source) | Always-on pendant | Cloud STT by default. Accidental presses, disconnects, wrong to-do states ([review](https://mikecann.blog/posts/i-tried-the-limitless-ai-and-omi-ai-so-you-dont-have-to)) |
| Limitless / Rewind | Always-on | "Consent mode" off by default drew backlash ([HN](https://news.ycombinator.com/item?id=40055538)). Picks up background audio. |
| Bee (Amazon) | Always on unless muted | Audio deleted after transcription (good). Treated TV and songs as the wearer's speech and invented facts ([Futurism](https://futurism.com/ai-gadget-records-life)) |
| Plaud NotePin | Push-button | Reliable explicit capture. The consent burden falls on the user. |
| Friend | Always-on companion | Public backlash over bystander recording ([CNN](https://www.cnn.com/2025/11/16/tech/friend-ai-device-backlash-ceo-avi-schiffmann)) |
| Granola | Meeting audio, no bot | Class action (Jul 2026) over covert capture and training by default ([B&T](https://btlaw.com/en/insights/alerts/2026/what-the-granola-class-action-means-for-companies-building-and-deploying-conversation-capture-tools)) |
| Otter | Auto-joining bot | Auto-shared private talk after a meeting ended ([WaPo](https://www.washingtonpost.com/business/2024/10/02/ai-assistant-transcription-work-secrets-meetings/)). Class action ([NPR](https://www.npr.org/2025/08/15/g-s1-83087/otter-ai-transcription-class-action-lawsuit)) |
| AudioPen / Voicenotes / Cleft | Push-to-talk | Rambling → clean prose. Cleft transcribes on-device ([Cleft](https://cleftnotes.com/)) |
| Mem 2.0 / Reflect / Tana | In-app voice | Mem "Heads Up" resurfacing ([Mem](https://get.mem.ai/blog/introducing-mem-2-0)). Tana fills structured fields from voice ([Tana](https://outliner.tana.inc/voice-memos)) |
| Apple Watch Audio Intelligence | Ambient, opt-in, schedulable | Secure enclave, no audio stored, 15 s "Live Rewind", summaries auto-delete after 7 days, a chime even on silent, no speaker identification |

---

## 3. Privacy and consent lessons

- **Trusted patterns:** delete audio right after transcription · short rolling buffers · summaries that expire on their own · time and place schedules · indicators that can't be fully disabled · no speaker identification.
- **"Creepy" triggers:** hidden recording · consent off by default · automatic sharing · training on user data by default · undisclosed data flows. Users rarely use mute controls, so privacy must be the default ([Lau 2018](https://dl.acm.org/doi/abs/10.1145/3274371)).
- **Techniques:** Personal VAD labels frames as owner / other / silence with a ~130K-parameter model ([Ding 2019](https://arxiv.org/abs/1908.04284)). On-device whisper detection already ships in Alexa ([Raeesy](https://arxiv.org/pdf/1809.07832)).
- **Law (high level, not legal advice):**
  - US federal law needs one party's consent, but ~11 states require all parties for in-person conversations ([RCFP](https://www.rcfp.org/reporters-recording-sections/in-person-conversations/)).
  - Illinois BIPA treats voiceprints as biometrics. Suits target speaker identification ([Lewis Rice](https://www.lewisrice.com/publications/ai-transcription-tools-give-rise-to-bipa-claims)).
  - GDPR's household exemption is read narrowly ([EDPB](https://edpb.europa.eu/sites/default/files/consultation/edpb_guidelines_201903_videosurveillance.pdf)). The **EU AI Act has banned emotion inference at work and school since February 2025** ([summary](https://www.regulation-ai.eu/en/prohibited-practices/)).
  - HIPAA binds covered entities and their business associates. Consumer health apps fall under the FTC Health Breach Notification Rule ([FTC](https://www.ftc.gov/news-events/news/press-releases/2024/04/ftc-finalizes-changes-health-breach-notification-rule)).
  - India's DPDP Rules were notified in November 2025; most obligations start in May 2027, and personal/domestic use is exempt ([PIB](https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf)).
- **Claude API data handling:** zero data retention (ZDR) is available per organization by agreement, and a BAA is available for the API ([Anthropic privacy center](https://privacy.claude.com/en/articles/8956058-i-have-a-zero-data-retention-agreement-with-anthropic-what-products-does-it-apply-to)). "Covered models" (Fable/Mythos tier) require 30-day retention and are not ZDR-eligible ([BAA covered models](https://support.claude.com/en/articles/15455031-covered-models-under-a-business-associate-agreement-baa)), so Synapse defaults to Haiku 4.5 and Opus 5.5.

**Design consequences:** draft-first · forget-by-default · the pause wipes the recent buffer · a distinct earcon and a persistent indicator · **no emotion, health or relationship inference** · no speaker identification of others · asides and conversations with other people are not stored · "why" is shown for every surfaced item.

---

## 4. Techniques and evidence

**Self-repair / disfluency**
- Reparandum → interruption point → interregnum ("uh", "or no") → repair ([Shriberg](https://www.sri.com/wp-content/uploads/2021/12/disfluencies_in_switchboard.pdf)).
- Corrections and restarts are the hardest class to detect ([Disfl-QA](https://aclanthology.org/2021.findings-acl.293/)).
- Segmenting helps LLMs, and reasoning models over-delete ([DRES](https://arxiv.org/abs/2509.20321)).

**Intent of a thought**
- Dialogue-act tagging reached ~71% accuracy, against ~84% human agreement ([Stolcke 2000](https://aclanthology.org/J00-3003/)). Expect ambiguity and design for abstention.
- Action items emerge across utterances (propose → discuss → commit) ([Purver 2007](https://aclanthology.org/2007.sigdial-1.4/)), which justifies the **thought stitcher**.
- Generating to-dos from stated commitments: [Smart To-Do](https://aclanthology.org/2020.acl-main.767/).

**Long-horizon memory**
- Graphiti/Zep: facts carry validity windows, keep their source, and use hybrid retrieval without an LLM at query time ([repo](https://github.com/getzep/graphiti), [paper](https://arxiv.org/abs/2501.13956)). Basis for our `valid_from/valid_to` + `supersedes` edges.
- Letta sleep-time compute: background consolidation ([blog](https://www.letta.com/blog/sleep-time-compute/)). Basis for our sleep cycle.
- A-Mem: Zettelkasten-like linked notes ([arXiv](https://arxiv.org/abs/2502.12110)).
- LightRAG updates incrementally, whereas GraphRAG must rebuild ([arXiv](https://arxiv.org/abs/2410.05779)).
- **Counter-evidence that shapes the build:**
  - On lifelog data, sophisticated memory systems did **not** beat simple retrieval ([LifeDialBench](https://arxiv.org/abs/2604.11182)).
  - **Verbatim chunks beat LLM-extracted facts** by 16–22 points ([arXiv](https://arxiv.org/abs/2601.00821)).
  - **Design:** hybrid retrieval over verbatim fragments + gists is the core. The graph is used for expansion, linking and visualization.
  - LongMemEval covers temporal reasoning, changing facts and abstention ([arXiv](https://arxiv.org/abs/2410.10813)). Our recall eval mirrors those categories.
- **Kuzu is archived** (October 2025, after an Apple acquisition) ([9to5Mac](https://9to5mac.com/2026/02/11/kuzu-database-company-joins-apples-list-of-recent-acquisitions/)). Use SQLite tables for the graph.

**"That thing" across days**
- In dialogue, discourse deixis ("that") often refers to an earlier idea, not a named thing ([CODI-CRAC](https://aclanthology.org/2021.codi-sharedtask.1/)).
- Resolve time against when the words were spoken (e.g., `chrono-node`).
- Context tagging by place and activity dates back to Forget-me-not, 1994 ([paper](https://www.ee.columbia.edu/~dpwe/papers/LamF94-forgetmenot.pdf)).
- In Memoro, users preferred recall offered without asking ([CHI'24](https://arxiv.org/abs/2403.02135)).

---

## 5. "Magical, not stalker" (proactivity design)

- **Horvitz mixed-initiative:** act only when the expected value beats doing nothing. Use two thresholds (ignore / ask / act), and raise the bar when the user is absorbed ([CHI'99](https://erichorvitz.com/chi99horvitz.pdf)). This maps to our autonomy ladder.
- **Microsoft human-AI guidelines:** "time services based on context", "scope services when in doubt" ([MSR](https://www.microsoft.com/en-us/research/group/customer-insights-research/articles/guidelines-for-human-ai-interaction-eighteen-best-practices-for-human-centered-ai-design/)).
- **Timing:**
  - Someone talking is the strongest single cue that they shouldn't be interrupted ([Fogarty](https://homes.cs.washington.edu/~jfogarty/publications/tochi2005.pdf)).
  - Deferring to natural breakpoints reduces frustration ([Iqbal & Bailey](https://interruptions.net/literature/Iqbal-CHI08.pdf)).
  - Suggestions at task boundaries were accepted 52% of the time, against 31% right after a rejection. Mid-task suggestions felt "like advertisement" ([arXiv 2026](https://arxiv.org/html/2601.10253v1)).
  - **Design:** deliver only at VAD silence, and cool down after a dismissal.
- **Creepiness** peaks when output is accurate but users can't see why ([RecSys'19](https://dl.acm.org/doi/10.1145/3298689.3346982)). Proactive help is accepted when the reason is visible ([ACM'26](https://dl.acm.org/doi/10.1145/3772363.3798894)). **Design:** a "why" line on every card and suggestion.

---

## 6. Tech-stack findings
See **TRD §4.1** (VAD, embeddings, SQLite binding, encryption and keychain, chrono, graph viz, PWA limits, keyword spotting, integrations).
