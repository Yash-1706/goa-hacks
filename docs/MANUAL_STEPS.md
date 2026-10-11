# Manual steps

Only the things the unattended run couldn't do: keys, a real phone, and real accounts. Each step says what to run, what you should see, and what to do if it fails.

1. **Add your keys.**
   - Run:
     ```bash
     cd ~/Desktop/goa-hacks
     cp .env.example .env
     ```
   - In `.env`, set `SARVAM_API_KEY`, `GROQ_API_KEY`, `LLM_MODE=live`, `SYNAPSE_PASSCODE` (8 characters or more), and `WISPR_MODE=sarvam` (optional: it makes the laptop mic use Sarvam too).
   - Then run `pnpm run doctor`.
   - **Expect:** ✅ for Sarvam, Groq, GitHub, cloudflared and Passcode.
   - **If it fails:**
     - ❌ Sarvam or Groq means the key was rejected: copy it again from dashboard.sarvam.ai or console.groq.com/keys.
     - ⚠️ "could not reach" means the network: run it again.
     - Don't type `pnpm doctor`: that's pnpm's own command.

2. **Create the sandbox repo** (you declined this during pre-flight).
   - Run:
     ```bash
     gh repo create synapse-sandbox --private
     ```
   - Add `GITHUB_SANDBOX_REPO=SayedZahur786/synapse-sandbox` to `.env`.
   - **Expect:** the repo exists. On first start, Settings → Profile & connections shows it as the **default** repo.
   - **If it fails:** run `gh auth status`, and `gh auth login` if needed.

3. **Check real speech on the Mac** (synthetic voice, real Sarvam).
   - Run:
     ```bash
     say -v Samantha "That bug from yesterday, the null pointer in cart service. Remind me to call the landlord tomorrow at 6." -o /tmp/s.aiff
     afconvert -f WAVE -d LEI16@16000 /tmp/s.aiff /tmp/s.wav
     SYNAPSE_PASSCODE=<yours> pnpm start
     ```
   - In a second terminal:
     ```bash
     SYNAPSE_PASSCODE=<yours> node scripts/e2e/phase1.mjs http://localhost:8787 /tmp/s.wav
     ```
   - For a Hinglish check, repeat with `say -v Rishi` and a mixed sentence.
   - **Expect:**
     - `noCookieStatus` is 200 here: localhost is trusted when no tunnel is up (through the tunnel it's 401).
     - `status` is 200, and `transcript` is close to what was said.
     - Cards with `"source": "llm"`, and `liveInSecondTab` true.
   - **If it fails:**
     - A 503 "speech to text failed (sarvam)" means a key or quota problem.
     - Without `SARVAM_API_KEY`, the first clip downloads the Whisper model (about 40 MB) once.

4. **Use a real Android phone over 4G.**
   - Run `TUNNEL=1 pnpm start` on the Mac.
   - Scan the QR code in the terminal (or the one in first-run setup) with the phone, sign in with your passcode, and choose ⋮ → **Add to Home screen**.
   - Go outside on mobile data. Tap the icon, tap the big button and say the demo ramble from `docs/DEMO_V1.md`, ending with "actually make it 7". Tap again.
   - **Expect:**
     - Within a few seconds, "Made 3 things: GitHub issue · Email · Reminder", with the reminder at 7:00 pm.
     - The laptop Inbox shows the same three cards.
     - In airplane mode a recording says "Waiting for network", then "Sent" once you're back online.
   - **If it fails:**
     - A sign-in loop means the tunnel restarted with a new URL: scan the new QR.
     - "Microphone blocked": allow it in Chrome's site settings.
     - If the cards say "Saved", Groq rate-limited you and the offline model answered.

5. **Create a real issue from the phone.**
   - On the phone's bug card, tap **Create issue**.
   - **Expect:** "Created #1 ↗". The link opens the issue in `synapse-sandbox`, and its body ends with "Captured by voice with Synapse".
   - **If it fails:** check Settings → Profile & connections shows GitHub connected. A token from `gh` needs `repo` scope; a fine-grained token needs Issues: read and write.

6. **Open the email and calendar links on the phone.**
   - On the email card, answer "Who is ‘the team’?" if asked, then tap **Open draft**.
   - On the reminder card, tap **Add to calendar**.
   - **Expect:**
     - Your mail app opens with the recipients, subject and body filled in. Nothing is sent until you send it.
     - Google Calendar opens a 15-minute event tomorrow at 19:00.
   - **If it fails:** set a default mail app in Android settings. The ⋯ menu → **Download .ics** is the calendar fallback.

7. **Move the default repo to a real one (optional).**
   - Laptop: Settings → Profile & connections → **Suggest repos and teammates**, tick your repos, choose a default, and **Save**. Or pick the default in the Repos list.
   - **Expect:** new GitHub issue cards show that repo before you tap.
   - **If it fails:** remove the sandbox repo from the list, then pick again.

8. **Push the branch and open the PR.** The run never pushes.
   - Run:
     ```bash
     git push -u origin v1
     gh pr create --base main --head v1 --title "Synapse V1" --body-file docs/V1_REPORT.md
     ```
   - **Expect:** a PR from `v1` with 8 commits.
   - **If it fails:** run `gh auth status`. Also check that `main` hasn't moved; rebase locally if it has.
