# Evaluation report

Generated 2026-10-10T15:27:23.209Z · cortex: **offline mock (heuristics + local triage)** · embeddings: MiniLM (local) · node v25.2.1 · AMD Ryzen 5 6600H with Radeon Graphics         

> **Mock mode**: this measures the offline fallback path. Run `pnpm eval --live` with an `ANTHROPIC_API_KEY` (or a `GROQ_API_KEY`) for real model numbers.

## 1a. Intent classification: held-out set (phrasings that are not in the classifier's exemplars)

> Not a blind test: the same people wrote this set and the classifier, and the offline cue patterns were adjusted while an earlier run of it was in view. It is the more meaningful of the two intent numbers here because no sentence is shared with the exemplars, but real speech will be messier. The number that matters is the live model on speech nobody here wrote (`pnpm eval --live`, ideally on a teammate's phrasings).

| class | precision | recall | F1 | support |
|---|---:|---:|---:|---:|
| action | 100.0% | 100.0% | 100.0% | 6 |
| bug | 100.0% | 83.3% | 90.9% | 6 |
| communication | 85.7% | 100.0% | 92.3% | 6 |
| scheduling | 100.0% | 100.0% | 100.0% | 6 |
| code | 85.7% | 100.0% | 92.3% | 6 |
| decision | 100.0% | 50.0% | 66.7% | 6 |
| idea | 50.0% | 50.0% | 50.0% | 6 |
| question | 100.0% | 100.0% | 100.0% | 5 |
| journal | 83.3% | 100.0% | 90.9% | 5 |
| aside | 85.7% | 100.0% | 92.3% | 6 |
| recall_query | 100.0% | 100.0% | 100.0% | 5 |

Confusion matrix (rows = expected, columns = predicted):

| | acti | bug | comm | sche | code | deci | idea | ques | jour | asid | reca |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **action** | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **bug** | 0 | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| **communication** | 0 | 0 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **scheduling** | 0 | 0 | 0 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **code** | 0 | 0 | 0 | 0 | 6 | 0 | 0 | 0 | 0 | 0 | 0 |
| **decision** | 0 | 0 | 0 | 0 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |
| **idea** | 0 | 0 | 1 | 0 | 1 | 0 | 3 | 0 | 1 | 0 | 0 |
| **question** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 5 | 0 | 0 | 0 |
| **journal** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 5 | 0 | 0 |
| **aside** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 6 | 0 |
| **recall_query** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 5 |

Misclassified:
- h-bug03: expected bug, got aside (filtered)
- h-dec03: expected decision, got idea ("Final call, we're not supporting Internet Explorer at all")
- h-dec04: expected decision, got idea ("Spaces, two of them")
- h-dec05: expected decision, got idea ("Let's keep the monolith for one more quarter")
- h-ide01: expected idea, got journal ("Based on what you said this morning")
- h-ide02: expected idea, got communication ("Email the team")
- h-ide06: expected idea, got code ("A heatmap of when the errors happen…")

**63 unseen threads · accuracy 88.9% · macro-F1 88.7% · artifact-kind accuracy 74.6%** (target macro-F1 ≥ 85%)

## 1b. Intent classification: dev set (includes the problem statement's verbatim examples)

> ⚠️ Optimistic by construction: the offline classifier's exemplars contain these exact sentences, and the live model's few-shot examples contain several of them. Shown for transparency and as a regression gate, not as a generalisation claim.

| class | precision | recall | F1 | support |
|---|---:|---:|---:|---:|
| action | 100.0% | 100.0% | 100.0% | 7 |
| bug | 100.0% | 100.0% | 100.0% | 6 |
| communication | 100.0% | 100.0% | 100.0% | 6 |
| scheduling | 100.0% | 100.0% | 100.0% | 6 |
| code | 100.0% | 100.0% | 100.0% | 6 |
| decision | 100.0% | 100.0% | 100.0% | 6 |
| idea | 100.0% | 100.0% | 100.0% | 6 |
| question | 100.0% | 100.0% | 100.0% | 5 |
| journal | 100.0% | 100.0% | 100.0% | 5 |
| aside | 100.0% | 100.0% | 100.0% | 6 |
| recall_query | 100.0% | 100.0% | 100.0% | 5 |

Confusion matrix (rows = expected, columns = predicted):

| | acti | bug | comm | sche | code | deci | idea | ques | jour | asid | reca |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **action** | 7 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **bug** | 0 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **communication** | 0 | 0 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **scheduling** | 0 | 0 | 0 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **code** | 0 | 0 | 0 | 0 | 6 | 0 | 0 | 0 | 0 | 0 | 0 |
| **decision** | 0 | 0 | 0 | 0 | 0 | 6 | 0 | 0 | 0 | 0 | 0 |
| **idea** | 0 | 0 | 0 | 0 | 0 | 0 | 6 | 0 | 0 | 0 | 0 |
| **question** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 5 | 0 | 0 | 0 |
| **journal** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 5 | 0 | 0 |
| **aside** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 6 | 0 |
| **recall_query** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 5 |

64 threads · accuracy 100.0% · macro-F1 100.0%

## 2. Privacy control phrases

- pause recall 100.0% (14/14) · pause precision 100.0% · forget recall 100.0% · false triggers on 10 ordinary sentences: 0

## 3. Reference resolution ("that bug from yesterday", "what did Sarah say?")

- reference resolution: 8/8 = 100.0%

## 4. Recall (vague, time/place-constrained questions)

- Recall@3 on 10 vague queries over 10 remembered thoughts: 10/10 = 100.0%

## 5. Robustness to nonsense (2-minute ramble)

- 25 fragments of mumbling / filler / speech to others: 0 thought(s) stored, 0 spurious artifact(s), 22 filtered as asides

## Summary

| metric | result | target |
|---|---:|---:|
| intent macro-F1 (held-out, 63 unseen threads) | 88.7% | ≥ 85% |
| intent macro-F1 (dev set, seen wording) | 100.0% | regression gate |
| artifact-kind accuracy | 74.6% | |
| pause phrase recall / precision | 100.0% / 100.0% | ≥ 95% / 100% |
| reference resolution | 100.0% | ≥ 80% |
| Recall@3 | 100.0% | ≥ 80% |
| spurious artifacts on nonsense | 0 | ≤ 1 |
