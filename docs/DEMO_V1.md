# Synapse V1: the 2-minute demo

One person, a phone outside on 4G, a laptop on a table. Rehearsed automatically by `scripts/e2e/rehearse.mjs` (see the end).

## Before you start (5 minutes, once)

- `.env` has `SARVAM_API_KEY`, `GROQ_API_KEY` + `LLM_MODE=live`, `SYNAPSE_PASSCODE`, and `GITHUB_SANDBOX_REPO=<you>/synapse-sandbox`. `pnpm run doctor` is all ✅.
- `TUNNEL=1 pnpm start` on the laptop. The phone has the app on its home screen (scan the QR, sign in, Add to Home screen).
- Settings → Profile & connections on the laptop: GitHub connected, the sandbox repo is the **default**, and Sarah and Dev have email addresses. (Or answer the email card's question live: it is a good beat too.)
- The laptop shows the Inbox, full screen. A browser tab with the sandbox repo's issues is ready behind it.

## The beats

| Time | Where | Do | Say / show |
|---|---|---|---|
| 0:00 | Phone, outside | Tap the Synapse icon, tap the big button. | “I'm walking. No laptop, no app to pick, I just talk.” |
| 0:10 | Phone | Ramble, then tap to stop: *“That bug from yesterday… the null pointer in cart service, probably the discount code. Oh, and email the team that the launch moves to Friday. Remind me to call the landlord tomorrow at 6. Wait, was that my phone? Actually make it 7.”* | Mumbling, an aside and a correction, all in one breath. |
| 0:30 | Phone | Show the result row. | “Made 3 things: GitHub issue · Email · Reminder.” The reminder already says **7:00 pm**. The aside is gone. |
| 0:40 | Laptop | Point at the Inbox. | The same three cards arrived while you were outside. “Captured 3 things · 3 need you.” |
| 0:50 | Laptop | **Create issue** on the bug card. | It flips to **Created #1 ↗**. Click it: the real issue in the sandbox repo, with the summary, what was seen and the suspected cause. |
| 1:10 | Laptop | **Open draft** on the email card. | Gmail opens with the team, the subject and the body filled in. Nothing is sent until you press Send. |
| 1:25 | Laptop | **Add to calendar** on the reminder. | Google Calendar opens a 15-minute event tomorrow at 19:00. |
| 1:40 | Laptop | Ask → type *“what was that cart bug?”* | A cited answer: the cart-service null pointer, with source 1 to click. |
| 1:55 | Laptop | Settings → Privacy (optional). | Everything is encrypted on this Mac; nothing was sent without a tap. |

If the email card asks **“Who is ‘the team’?”**, tap Sarah and Dev (or type the addresses) and say: “It asks once, and remembers. The next ramble won't ask.”

## If something goes wrong

- **No signal outdoors:** the row says “Waiting for network”. Walk back in range: it uploads by itself, once.
- **The phone shows the sign-in screen:** the tunnel URL changed (a quick tunnel gets a new URL each start). Scan the new QR. A named tunnel avoids this.
- **Cards say “Saved” instead of a button:** the model was rate-limited and the offline model answered. It still works; say so.

## Automatic rehearsal

`scripts/e2e/rehearse.mjs` plays the whole demo with no human: an emulated Pixel 7 records the ramble from a synthetic voice, a desktop browser runs the laptop beats, and both are recorded as video (`docs/screenshots/v1/demo-rehearsal*.webm`). It runs against fakes for Sarvam and GitHub when no keys are set, so it never files a real issue or sends anything.
