# Manual steps

Only what needs your hands, a real phone or your accounts. Everything else was done and verified by the V1.1 run ([V1_REPORT.md](V1_REPORT.md#v11)).

Your app's permanent address: **https://sayeds-macbook-air.tail351c98.ts.net** (Tailscale Funnel). The passcode is `SYNAPSE_PASSCODE` in `.env` (changed in V1.1: every old session is signed out).

0. **Check the Mac is ready.**
   - Run `pnpm run doctor`.
   - **Expect:** ✅ Tunnel (Tailscale Funnel), ✅ Reachable, ✅ Service (running), ✅ Sleep, ✅ Passcode.
   - **If it fails:**
     - ⚠️ Sleep: System Settings → Battery → Options → turn on "Prevent automatic sleeping on power adapter when the display is off".
     - ⚠️ Service: `pnpm run service:install`; if it waits with no URL, click **Allow** on the "node would like to access files in your Desktop folder" prompt.

1. **Install the phone app.**
   - On the Android phone, open `https://sayeds-macbook-air.tail351c98.ts.net/capture` in Chrome.
   - Sign in with the passcode from `.env`, then ⋮ → **Add to Home screen**.
   - **Expect:** a Synapse icon that opens straight to the big record button. The address never changes, so this is a one-time step.
   - **If it fails:** a 502 page means the Mac's server is down: `pnpm run service:status`.

2. **Capture outdoors on 4G.**
   - Go outside on mobile data. Tap the icon, tap the big button and say the demo ramble from `docs/DEMO_V1.md` ("…remind me to call the landlord tomorrow at 6… actually make it 7"). Tap again.
   - **Expect:**
     - Within a few seconds: "Made 3 things: GitHub issue · Email · Reminder", the reminder at 7:00 pm.
     - The laptop (`/app`) shows the same cards.
     - With the Mac asleep or off, the clip says "Saved on your phone. It will sync when your Mac is awake." and goes up once it's back.
   - Optional: tap **Create issue** on the bug card: it files the issue in `SayedZahur786/synapse-sandbox`.
   - **If it fails:** "Microphone blocked": allow it in Chrome's site settings. Cards marked "improving…" are being redrafted after Groq's free-tier limit; wait a minute.

3. **Look at the public website.**
   - Open https://sayedzahur786.github.io/synapse-site/ on the phone and on a laptop, and paste the link into a chat app to see the preview card.
   - **Expect:** the landing page with the moving demo strip; "Open app" goes to your Mac's address; the preview shows the share image.
   - To publish changes: `pnpm run site:deploy`.

4. **Rotate the API keys.** The Sarvam and Groq keys were pasted into a chat during setup. Create new ones (dashboard.sarvam.ai, console.groq.com/keys), put them in `.env`, then `launchctl kickstart -k gui/$(id -u)/com.synapse.server`.

5. **Push the branch and open the PR.** The run never pushes this repo.
   - Run:
     ```bash
     git push -u origin v1
     gh pr create --base main --head v1 --title "Synapse V1 + V1.1" --body-file docs/V1_REPORT.md
     ```
   - **If it fails:** run `gh auth status`. If `main` moved, rebase locally first.
