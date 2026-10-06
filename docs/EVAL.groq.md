# Evaluation report

Generated 2026-10-06T18:55:54.188Z · cortex: **live groq/qwen/qwen3.8-27b** · embeddings: MiniLM (local) · node v25.2.1 · AMD Ryzen 5 6600H with Radeon Graphics         

> Live mode on **Groq's free tier** (qwen/qwen3.8-27b): the compact prompt of `cortex/prompts-lite.ts` (the full Claude prompt cannot fit the 8,000 tokens-per-minute limit), calls paced to the token budget so each item waits for its answer. Sampled run: at most 5 items per section, request budget 55. These are not the numbers of the production Claude cortex.

> **Read this first: a small, diluted run.** Only 21 of the 42 thought answers in this file came from the model; the other 21 are the local cortex's (20 were swallowed by the client's 4 s connection cool-down after a single timeout, which a script that feeds fragments much faster than a model answers races straight through, and 1 was the timeout itself). The live-run helpers now wait out a cool-down instead, and a live run shares one client across its apps, but the free tier's request budget for this session was spent, so the run was not repeated. The sample is 5 threads per intent set (action, bug, communication, scheduling, code); macro-F1 is therefore over those five classes (the generator averaged over all eleven when this file was written, which capped it at 45.5%; the figures here are recomputed over the classes present, all at 100%). Recall memories were seeded by the live cortex in this run. Treat this as proof that the live pipeline runs end to end on Groq, not as an accuracy measurement: the measurement is the 18-input model comparison in `README.md` (Groq notes) and `docs/TRD.md` §6.5 (Qwen3.8-27B 17/18 categories, 18/18 artifact kinds, 18/18 valid JSON, p50 0.95 s).

## 1a. Intent classification: held-out set (phrasings that are not in the classifier's exemplars)

> Not a blind test: the same people wrote this set and the classifier, and the offline cue patterns were adjusted while an earlier run of it was in view. It is the more meaningful of the two intent numbers here because no sentence is shared with the exemplars, but real speech will be messier. The number that matters is the live model on speech nobody here wrote (`pnpm eval --live`, ideally on a teammate's phrasings).

| class | precision | recall | F1 | support |
|---|---:|---:|---:|---:|
| action | 100.0% | 100.0% | 100.0% | 1 |
| bug | 100.0% | 100.0% | 100.0% | 1 |
| communication | 100.0% | 100.0% | 100.0% | 1 |
| scheduling | 100.0% | 100.0% | 100.0% | 1 |
| code | 100.0% | 100.0% | 100.0% | 1 |
| decision | 0.0% | 0.0% | 0.0% | 0 |
| idea | 0.0% | 0.0% | 0.0% | 0 |
| question | 0.0% | 0.0% | 0.0% | 0 |
| journal | 0.0% | 0.0% | 0.0% | 0 |
| aside | 0.0% | 0.0% | 0.0% | 0 |
| recall_query | 0.0% | 0.0% | 0.0% | 0 |

Confusion matrix (rows = expected, columns = predicted):

| | acti | bug | comm | sche | code | deci | idea | ques | jour | asid | reca |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **action** | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **bug** | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **communication** | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **scheduling** | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **code** | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| **decision** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **idea** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **question** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **journal** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **aside** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **recall_query** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

**5 unseen threads · accuracy 100.0% · macro-F1 100.0% · artifact-kind accuracy 100.0%** (target macro-F1 ≥ 85%)

## 1b. Intent classification: dev set (includes the problem statement's verbatim examples)

> ⚠️ Optimistic by construction: the offline classifier's exemplars contain these exact sentences, and the live model's few-shot examples contain several of them. Shown for transparency and as a regression gate, not as a generalisation claim.

| class | precision | recall | F1 | support |
|---|---:|---:|---:|---:|
| action | 100.0% | 100.0% | 100.0% | 1 |
| bug | 100.0% | 100.0% | 100.0% | 1 |
| communication | 100.0% | 100.0% | 100.0% | 1 |
| scheduling | 100.0% | 100.0% | 100.0% | 1 |
| code | 100.0% | 100.0% | 100.0% | 1 |
| decision | 0.0% | 0.0% | 0.0% | 0 |
| idea | 0.0% | 0.0% | 0.0% | 0 |
| question | 0.0% | 0.0% | 0.0% | 0 |
| journal | 0.0% | 0.0% | 0.0% | 0 |
| aside | 0.0% | 0.0% | 0.0% | 0 |
| recall_query | 0.0% | 0.0% | 0.0% | 0 |

Confusion matrix (rows = expected, columns = predicted):

| | acti | bug | comm | sche | code | deci | idea | ques | jour | asid | reca |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **action** | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **bug** | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **communication** | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **scheduling** | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **code** | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| **decision** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **idea** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **question** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **journal** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **aside** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **recall_query** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

5 threads · accuracy 100.0% · macro-F1 100.0%

## 2. Privacy control phrases

- pause recall 100.0% (14/14) · pause precision 100.0% · forget recall 100.0% · false triggers on 10 ordinary sentences: 0

## 3. Reference resolution ("that bug from yesterday", "what did Sarah say?")

- reference resolution: 5/5 = 100.0%

## 4. Recall (vague, time/place-constrained questions)

- Recall@3 on 10 vague queries over 14 remembered thoughts: 10/10 = 100.0%

## 5. Robustness to nonsense (2-minute ramble)

- 5 fragments of mumbling / filler / speech to others: 0 thought(s) stored, 0 spurious artifact(s), 5 filtered as asides

## Summary

| metric | result | target |
|---|---:|---:|
| intent macro-F1 (held-out, 5 unseen threads) | 100.0% | ≥ 85% |
| intent macro-F1 (dev set, seen wording) | 100.0% | regression gate |
| artifact-kind accuracy | 100.0% | |
| pause phrase recall / precision | 100.0% / 100.0% | ≥ 95% / 100% |
| reference resolution | 100.0% | ≥ 80% |
| Recall@3 | 100.0% | ≥ 80% |
| spurious artifacts on nonsense | 0 | ≤ 1 |

Live cortex answers: 21 thought(s) were answered by the model; 21 fell back to the local cortex (network ×20, timeout ×1). Fallback answers are the offline cortex's, so they dilute every number above. Requests sent to Groq in this run: 23, one pacing budget shared by every app the run built (free tier: 1,000 per day).
