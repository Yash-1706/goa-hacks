# Synapse: build guide for Claude Code

WhisperFlow Hackathon 2026, **Problem Statement 4: Ambient Cognitive Offloading** (see `WHISPERFLOW HACKATHON 2026.pdf`, pages 8–10).
Specs: product → `docs/PRD.md` · technical → `docs/TRD.md` · research → `docs/RESEARCH.md`. **Read the TRD before writing code.**

## How to build
- Follow the milestone order in **TRD §18 (M0 → M11)**. Finish each milestone green (typecheck + tests + a manual check) before starting the next. Ship P0 before P1 before P2 (PRD §6).
- **No API keys exist on this machine yet.** Start with `WISPR_MODE=mock` and `LLM_MODE=mock`. Every feature must work in mock mode. Live modes turn on through `.env`.
- Run `git init` at M0 and commit at the end of each milestone.
- **Before writing any Claude API code, load the `claude-api` skill** and use its TypeScript docs (`@anthropic-ai/sdk`, `messages.parse` + `zodOutputFormat`). Model IDs: `MODEL_FAST=claude-haiku-4-5` (latency-critical hot path), `MODEL_DEEP=claude-opus-5-5`. Both are configurable via env.
- The Wispr Flow API contract is in **TRD §5.5** (verified against api-docs.wisprflow.ai). Verify the listed unknowns empirically once a key is available.

## Non-negotiables
1. Audio is never written to disk, and in `client` mode it never reaches our server.
2. API keys stay on the server. The browser only gets short-lived Wispr client JWTs.
3. Draft-first: nothing is sent to another human without consent. Enforce the autonomy policy (TRD §9.6).
4. All persisted user text and embeddings are AES-256-GCM encrypted. Working memory uses per-day keys that are destroyed at TTL.
5. No emotion, health or relationship inference. No speaker identification of others. Never send `screenshot`, `content_text` or `content_html` to Wispr.
6. No plaintext user content in logs. Log IDs, lengths and hashes only.

## Commands (create these in M0)
`pnpm i` · `pnpm dev` (server + web) · `pnpm test` · `pnpm typecheck` · `pnpm replay scripts/replay/<file>.json` · `pnpm seed` · `pnpm eval` · `pnpm bench`

## Environment
- Windows 11, PowerShell 5.1 (chain commands with `;`, not `&&`), plus Git Bash. Node 25.2.1, pnpm 10.28, Bun 1.4, Python 3.14, Docker, `gh`. No Ollama.
- Phones need HTTPS for microphone access (TRD §11.2).

## Conventions
- TypeScript strict, ESM. The zod schemas in `packages/shared` are the single source of truth for the WS protocol and for LLM structured outputs.
- Module layout follows TRD §3. Brain-metaphor names (Cortex, Hippocampus, …) are for the UI and pitch; code uses plain names.
- Every core algorithm listed in TRD §17 gets vitest coverage.
