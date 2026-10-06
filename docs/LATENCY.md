# Latency benchmark

Generated 2026-10-06T19:18:27.234Z · cortex: **offline mock (heuristics + local triage)** · 298 fragments over 2 run(s) · AMD Ryzen 5 6600H with Radeon Graphics          · Node v25.2.1

> **Offline run.** The cortex stage here is the local heuristic cortex, so the end-to-end numbers show the pipeline overhead, not model latency. Run `pnpm bench --live` with `ANTHROPIC_API_KEY` (or `GROQ_API_KEY`) for the real fragment→artifact numbers.

## What each stage measures

| stage | from → to | measured here |
|---|---|---|
| `wispr` | commit sent → Wispr final text | needs a Wispr key (see *Real sessions*) |
| `triage` | fragment received → first card on the wire (embed 384-d + kNN triage + persist) | ✔ server-side |
| `firstPaint` | = triage here (no device clock in the benchmark) | ✔ server-side |
| `llmFirstField` | model call start → first parsed field (streamed) | n/a offline |
| `cortex` | model call start → complete result | ✔ |
| `artifact` | fragment received → complete artifact emitted | ✔ server-side |

## Results (milliseconds)

| stage | n | p50 | p95 | max |
|---|---:|---:|---:|---:|
| triage | 290 | 10.0 | 15.0 | 21.0 |
| firstPaint | 290 | 10.0 | 15.0 | 21.0 |
| cortex | 264 | 4.0 | 6.0 | 9.0 |
| artifact | 264 | 22.0 | 31.0 | 114 |

**First paint:** p50 10.0 ms, p95 15.0 ms (budget ≤ 80 ms p50). **Fragment → complete artifact:** p50 22.0 ms, p95 31.0 ms (budget ≤ 1000 ms p50 for "incoherent vocalization → structured ticket in under a second", measured from Wispr's final text).


## The honest end-to-end budget (voice → action)

| segment | typical | notes |
|---|---:|---|
| VAD end-of-speech redemption | 480 ms | tunable 300–900 ms; shorter = more fragments (the stitcher merges them) |
| Wispr commit → final text | *unmeasured* | pre-authenticated standby socket removes connect+auth from the path; needs a live key |
| Wispr → server (WebSocket hop) | ~10–40 ms LAN | clock-offset corrected per device |
| Server: embed + triage → first card | **10.0 ms** | measured above |
| Server: complete artifact | **22.0 ms** | offline cortex; the live number is dominated by model generation |

## Pause path ("pause memory")

Client-side phrase matcher: p50 1123 µs, p95 4002 µs per utterance (2000 samples). The microphone is released the moment Wispr returns the phrase's text; the browser pipeline reports the end-of-phrase → mic-released latency (`pause` stage) when run with a live key. The server backstop (semantic match) adds one embedding (~5 ms).

## Method

Items: 127 threads (both intent corpora), each spoken as 1–3 fragments with realistic gaps, one thread at a time; `2` run(s); a warm-up thread is excluded (JIT, ONNX graph init, schema compile, cache write). Timestamps are taken inside the pipeline: `serverRecv` → `firstPaintEmit` → `llmStart/llmDone` → `artifactEmit`. Reproduce with `pnpm bench`.
