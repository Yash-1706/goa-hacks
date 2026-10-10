# Audio pipeline ("Ear")

Browser microphone → on-device VAD → Wispr Flow (straight from the browser) → `fragment.final` for the UI.
Contract with the UI: [`types.ts`](./types.ts) (`AudioEngine`, `AudioEngineOptions`). The UI owns the Synapse WebSocket; this
code never talks to it. The mic engine is `engine.ts` → `createMicEngine` (loaded lazily by `index.ts`); the typed-input engine is
`text-engine.ts`. Sensors live in `../sensors/` (`startActivityClassifier`, `watchBattery`, `holdWakeLock`).

```
getUserMedia (inside the tap) ─▶ AudioContext ─▶ Silero v5 (vad-driver.ts, 16 kHz / 512-sample frames)
   every frame ─▶ CaptureCore (capture.ts): RMS · orb level · noise floor · 16-frame ring · eco energy gate · packetizer
   VAD start   ─▶ claim the pre-authenticated STANDBY socket, flush the pre-roll, stream 4 (eco: 8) packets per append
   VAD end     ─▶ commit(total_packets)           VAD misfire ─▶ close WITHOUT commit
   Wispr final ─▶ matchPauseIntent? ─yes─▶ KILL SWITCH (tracks stop → VAD destroy → sockets closed → buffers zeroed → onPause)
                                      └no──▶ FragmentFinal (fragment.ts) ─▶ onFragment
   failure     ─▶ error | close before final | no final in 4 s ─▶ REST fallback (44-byte-header WAV) ─▶ else onFailed
```

| file | role |
|---|---|
| `engine.ts` | lifecycle, state machine, token handling, kill switch, `injectText`; `createMicEngineFactory(deps)` for DI |
| `capture.ts` | frame/VAD event handling, utterance bookkeeping, whisper flag, pause guard (no browser APIs) |
| `wispr.ts` | `WisprStreamer`: standby pool, one session per utterance, REST fallback, wire builders |
| `vad-driver.ts` | the only file that touches `@ricky0123/vad-web` (dynamic import) |
| `pcm.ts` `levels.ts` `stats.ts` `fragment.ts` `clock.ts` | float→int16/base64/WAV, noise floor/whisper/orb level/energy gate, Battery-Lab counters, fragment builder, injectable time |
| `test-*.ts`, `*.test.ts` | doubles (fake clock/socket/mic, a VAD double that runs the REAL vad-web `FrameProcessor`) and tests |

## The on-device engine: same streamer, different address

When the server says `mode: "local"` in the `wispr.token` message (WISPR_MODE=local, local-only mode, or the opt-in STT_FALLBACK), the streamer is unchanged: it is simply handed `/local-stt/client_ws` and `/local-stt/client_api`, which speak Wispr's own client protocol (server side: `apps/server/src/wispr/local-ws.ts`, Whisper behind it). Three small things differ:

- **Relative endpoints.** The server cannot know which address the browser reached it by, so `toTokenState(info, now, origin)` resolves a path against the page origin (`ws:`/`wss:` for `http:`/`https:`); the engine passes `origin` from the controller (`location.origin`). Wispr's absolute URLs pass through. Vite proxies `/local-stt` (WebSocket upgrade included) so phones and HTTPS tunnels work.
- **Labelling.** Transcripts from those sockets and that REST route carry `transport: "local_stt"` (the Lab says "on-device", the Trail "local STT").
- **`reconnect()`.** When local-only is switched on or off the server broadcasts `config.update`; the controller calls `engine.reconnectSpeech()` → `WisprStreamer.reconnect()`: the utterance being streamed is aborted (not one more packet to the engine just turned off, no "failed" tick), every socket closes, the token is dropped (the next request is `force`), and the standby reconnects to whichever engine the server now hands out. The mic and VAD are untouched.

The egress audit (`egress.test.ts`) still holds: this module is the only one that opens connections, and only to what the server handed out.

## Behaviour worth knowing (and where it differs from a naive reading of the contract)

- **`onLevel(level)` is already normalised 0..1** (0 at the calibrated noise floor, 1 at +36 dB, fast attack / slow release, ~15 Hz), not a raw RMS.
- **`speechEnd` is the end of the last voiced frame**, not the moment the VAD fired (that is ~480 ms later). So `pauseBeforeMs` is the real silence between utterances,
  `commitSent − speechEnd ≈ 480 ms` shows the segmentation wait honestly, and the pause latency is "end of the phrase → mic released" (PRV-1).
- `start()` never rejects: failures arrive as `onState("error", detail)` (permission denied, no HTTPS, VAD failed to load, proxy mode, mic unplugged).
  Token `mode:"mock"` or a token error ⇒ the mic still runs (VAD, orb, hearing/listening) with state `listening` + detail `no Wispr key: using typed input`; **no audio is streamed anywhere**. Token errors are retried quietly (10 s → 60 s).
- `pause("tap"|"remote")` releases everything and reports `paused` without `onPause`; `pause("voice"|"kws")` also calls `onPause`. The pause phrase is never delivered as a fragment.
- Additive contract members: `AudioEngineOptions.onDiagnostic` / `.tuning`, `AudioEngine.recalibrate()`. No existing member changed.
- Wispr wire: auth `context` never carries `screenshot` / `content_text` / `content_html` (typed as `null`, asserted by tests); ≤150 dictionary terms; ≤6 conversation messages;
  `packet_duration` is the constant 0.032; one packet = one 512-sample frame of raw int16 LE, base64.
- Standby: exactly one pre-authenticated socket while listening; claiming opens the next. Recycled make-before-break when older than 45 s, when the token is <20 % from expiry, or (≥10 s old) when the context changed. Speech is never delayed by a recycle.
- Stuck VAD / constant noise: an utterance is force-split at 90 s (`tuning.maxUtteranceMs`).
- Audio exists only in RAM, only until the final text arrives, and is zero-filled afterwards (REST base64 strings are the one thing JS cannot wipe). No Blob / IndexedDB / storage / download / `console` anywhere in these files (a test scans for it).

## Testing without a key or a microphone

1. `pnpm --filter @synapse/web test` — unit tests plus an integration suite that runs the real `WisprStreamer` and `MicEngine` over **real WebSockets** against the fake server below.
2. `node apps/web/scripts/fake-wispr.mjs` — a dependency-free fake Wispr (auth → `{"status":"auth"}`, append → info, commit → text final, REST `client_api`, token minting, warm-up).
   It is strict: protocol violations are answered with `{"status":"error"}` and listed at `/health` (`violations`). Env: `FAKE_WISPR_TEXT="a|b"`, `FAKE_WISPR_LATENCY_MS`, `FAKE_WISPR_FAIL=error|drop|silent|rest-error`, `FAKE_WISPR_PARTIALS=1`.
   Point the Synapse server at it: `WISPR_MODE=client WISPR_API_KEY=fl-fake WISPR_BASE=http://127.0.0.1:8799/api/v1/dash`.
3. `pnpm dev:web`, then open `/scripts/vad-smoke.html` and click start: a synthetic speaker feeds the **real** VAD / worklet / wasm / streamer (no mic). Results in `window.__smoke`.
4. `engine.injectText("…")` works on the mic engine too (and `"pause memory"` triggers the real kill switch).

## Verified so far

- Unit + integration tests (250): wire format, standby/recycle/backoff, REST fallback, kill-switch ordering and airtightness, eco gate, whisper flag, sensors; plus 22 deliberate mutations of the privacy/protocol code, all caught.
- Real-browser smoke (embedded Chromium, synthetic formant "speaker" instead of a mic, `scripts/vad-smoke.html`, dev server AND a production bundle): the real vad-web/ONNX/worklet load from `/vad/`,
  `start()` → `listening` in ~0.8 s cold (~0.1 s warm), Silero v5 segments the clips, the patched `processFrame` sees every frame (~1.9 ms/frame), eco mode skips ~half the quiet frames,
  standby → pre-roll → commit → final over a real WebSocket to the fake gives schema-valid fragments (commit→final = the fake's configured latency), a "Pause memory." transcript releases the track
  and every socket (the phrase is not a fragment), 10 stop-during-start races leave no live track / open AudioContext / console error, and a hidden tab keeps working.
- NOT verified: a real microphone, a real Wispr key, phones, Firefox/Safari.

## Latency budget of the voice kill switch

End of the phrase → mic released = VAD redemption (480 ms) + Wispr commit→final + a few ms. If the measured p95 is above the 1 s target, lower `tuning.redemptionMs` (e.g. 320-360) at the price of more fragments.

## Unverified assumptions (need a real Wispr key and/or real devices)

**Run `pnpm wispr:check` first** (server in `WISPR_MODE=client`, about 15 s). It speaks a synthetic sentence through the real streamer and the real server token path and reports items 1, 3, 4, 5 and 6 below as PASS / FAIL / UNKNOWN with evidence (`--idle 60` also tests item 2, `--rest` the REST fallback, `--packets wav` the per-packet WAV escape hatch, `--wav your.wav` your own recording). It is itself tested against `scripts/fake-wispr.mjs`. Items 7, 10, 11 and 12 need a browser or a device and stay manual.

1. `auth.access_token` must repeat the JWT on `client_ws` (we send it, in addition to `client_key=Bearer%20<JWT>` in the URL).
2. Idle timeout of an authenticated but silent socket. We recycle at 45 s; if Wispr drops idle sockets sooner the diagnostics show `standby down (closed …)` flapping.
3. **Per-packet encoding**: we label packets `audio_encoding:"wav"` but send raw int16 LE without a RIFF header (what the brief says Wispr's quickstart does). If Wispr rejects it, set `tuning.packetFormat: "wav"` (44-byte header per packet).
4. Commit → final latency (measured: `{kind:"latency"}` diagnostics and `t.commitSent` / `t.wisprFinal` on every fragment).
5. That Wispr answers auth with `{"status":"auth"}`. If it never does, a socket is treated as ready 3 s after auth (`standby ready, assumed:true` in the diagnostics).
6. Final-text semantics: one `final:true` after the commit; empty text when nothing was heard (dropped silently); `final:true` before our commit would be ignored; partials ignored.
7. `client_ws` / `client_api` accept browser origins (WebSocket Origin check, CORS preflight for `Authorization` on the REST fallback). The REST fallback from a browser is the most CORS-sensitive piece.
8. Limits: max packets per `append` (we cap at 32), maximum WS session length (we cap utterances at 90 s), whether `volumes` has to be RMS in 0..1.
9. ~~Token re-serving after a rejection~~ (fixed): the server caches a client token for 20 s, and after a Wispr auth rejection the engine asks again with `requestWisprToken({ force: true })`, which the UI forwards as `{type:"wispr.token.request", force:true}` so the server mints a fresh one. What is still unverified is Wispr's actual rejection behaviour (item 1/5).
10. Whisper behaviour: Silero v5 at threshold 0.35 on real whispers, the whisper flag with the browser's AGC on (AGC can lift a whisper above the flag threshold; `tuning.autoGainControl:false` is the knob), and whether Wispr transcribes a whispered "pause memory" reliably. Verified only with a synthetic voice.
11. Real devices: iOS Safari (AudioWorklet + `getUserMedia` inside the tap, background muting), Android Chrome, Firefox (the default-rate AudioContext path is used everywhere; a native 16 kHz context would resample better but breaks Firefox).
12. Frame skipping relies on MicVAD's public `processFrame` being what the worklet calls (true for 0.0.31; the driver falls back to no skipping if it ever is not).

## Tuning (`AudioEngineOptions.tuning`, all optional)

`positiveSpeechThreshold` 0.35 · `negativeSpeechThreshold` 0.20 · `redemptionMs` 480 · `preSpeechPadMs` 320 · `minSpeechMs` 160 · `ecoThresholdBoost` 0.10 ·
`wisprFinalTimeoutMs` 4000 · `wisprStandbyMaxAgeMs` 45000 · `autoGainControl` true · `noiseCalibrationMs` 2000 · `whisperRmsAbs` 0.012 · `packetFormat` "pcm16" · `vadAssetPath` "/vad/" · `maxUtteranceMs` 90000.
