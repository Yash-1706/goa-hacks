# Manual steps (draft, finalised at the end of the run)

1. **Create `.env` with your keys.** `cp .env.example .env`, then set `SARVAM_API_KEY`, `GROQ_API_KEY`, `SYNAPSE_PASSCODE`. Run `pnpm run doctor`. Expect ✅ for Sarvam, Groq and Passcode. If Sarvam shows ❌, the key was rejected: copy it again from dashboard.sarvam.ai.
2. **Synthetic-speech check with real Sarvam** (skipped by the run: no key).
