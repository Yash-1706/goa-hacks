# Voice smoke test: the whole browser voice path, no key and no microphone

Plays a synthetic voice into the page as the "microphone", so the **real** Silero VAD (WASM), packetizer, Wispr streamer and
pause guard run in a real browser against the strict fake Wispr (`../fake-wispr.mjs`) and the real Synapse server.
It covers everything except a physical microphone, room acoustics, real whispers and the real Wispr service.

PowerShell, from the repo root, one terminal per step:

```powershell
# 1. a computer voice (Windows SAPI) → apps/web/public/_dev/*.wav (git-ignored)
powershell -File apps/web/scripts/voice-smoke/make-speech.ps1

# 2. the fake Wispr: what it "hears" is the next text of the list, whatever the audio says
$env:FAKE_WISPR_TEXT = "Remind me to email the team about the delay.|That bug from yesterday, the null pointer in the cart service, probably the discount code."
$env:FAKE_WISPR_LATENCY_MS = "300"
node apps/web/scripts/fake-wispr.mjs

# 3. the server, pointed at it (a throw-away data dir keeps your own memory untouched)
$env:WISPR_MODE = "client"; $env:WISPR_API_KEY = "fl-fake"; $env:WISPR_BASE = "http://127.0.0.1:8799/api/v1/dash"
$env:LLM_MODE = "mock"; $env:DATA_DIR = "$env:TEMP\synapse-voice-smoke"
pnpm dev:server

# 4. the web app
pnpm dev:web          # open http://localhost:5173
```

5. In the browser console paste `fake-mic.js`, tap the orb, then run `__fakeMic.say(1)`, `__fakeMic.say(2)` or
   `__fakeMic.say(1, { gain: 0.03 })` (a whisper-level version of the same sentence).
6. Read the result: cards appear; the Stream tags the quiet one `WHISPER`; `http://127.0.0.1:8799/health` must show
   `violations: 0`, `packets` ≈ seconds of speech ÷ 0.032 and one `commit` per sentence; the Lab shows the stage latencies.

**Drills** (restart the fake with a different mode): `$env:FAKE_WISPR_FAIL = "silent"` (no final: the app waits 4 s, then uses REST),
`"drop"` (socket killed), `"error"`, `"rest-error"`. Set `$env:FAKE_WISPR_TEXT = "Pause memory."` and say a sentence to watch the
kill switch release the mic, close the sockets and pause the server (resume needs a tap).

Clean up: `powershell -File apps/web/scripts/voice-smoke/make-speech.ps1 -Clean` (and stop the three processes).

Note: when the browser window is minimised or hidden, animation frames stop, so exit animations such as the paused banner can linger
in the DOM even though the app state is correct.
