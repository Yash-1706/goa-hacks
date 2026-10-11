import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { ShipCard } from "@/components/ship/ShipCard";
import { GithubConnect, GithubImport, PeopleSources } from "@/components/settings/ProfileParts";
import { api } from "@/net/api";
import { toast } from "@/state/notices";
import { useProfile } from "@/state/profile";
import { useSettings } from "@/state/settings";
import { useThoughts } from "@/state/thoughts";

/* ============================================================================
 * First-run setup (V1): shown once, every step skippable. Welcome · GitHub · People · Phone · Try it.
 * ========================================================================== */

const STEPS = ["Welcome", "GitHub", "People", "Your phone", "Try it"] as const;
const TRY = "Remind me to drink water at 4";

function PhoneStep() {
  const url = useSettings((s) => s.config?.publicUrl);
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    void QRCode.toString(`${url}/capture`, { type: "svg", margin: 1, color: { dark: "#0c0c0d", light: "#ffffff" } /* dark on white: some phone scanners cannot read an inverted code */ }).then(setSvg, () => setSvg(null));
  }, [url]);
  if (!url)
    return (
      <div className="onb-body">
        <p>Your phone needs a URL it can reach from anywhere. Restart Synapse with the tunnel:</p>
        <pre className="onb-code">TUNNEL=1 pnpm start</pre>
        <p className="set-dim">It needs SYNAPSE_PASSCODE in .env and cloudflared (brew install cloudflared). The QR code appears here and in the terminal.</p>
      </div>
    );
  return (
    <div className="onb-body onb-phone">
      {svg ? <div className="onb-qr" aria-label={`QR code for ${url}/capture`} role="img" dangerouslySetInnerHTML={{ __html: svg }} /> : null}
      <ol className="onb-steps">
        <li>Scan this with your Android phone's camera.</li>
        <li>Sign in with your passcode (once: it lasts 90 days).</li>
        <li>In Chrome's ⋮ menu, tap “Add to Home screen”.</li>
        <li>Tap the Synapse icon, tap the big button, talk, tap again.</li>
      </ol>
      <p className="set-dim onb-url">{url}/capture</p>
    </div>
  );
}

function TryStep() {
  const [text, setText] = useState(TRY);
  const [sent, setSent] = useState<number | null>(null);
  const byId = useThoughts((s) => s.byId);
  const made = useMemo(() => (sent ? Object.values(byId).filter((t) => t.createdAt >= sent - 2000 && t.artifact?.kind === "reminder").sort((a, b) => b.createdAt - a.createdAt)[0] : undefined), [byId, sent]);
  return (
    <div className="onb-body">
      <p>
        Say or type: <i>“{TRY}”</i> and watch the card appear.
      </p>
      <form
        className="set-row"
        onSubmit={(e) => {
          e.preventDefault();
          setSent(Date.now());
          void api.capture(text).catch((err: Error) => toast.warn(err.message));
        }}
      >
        <input className="input set-grow" value={text} onChange={(e) => setText(e.target.value)} aria-label="Try a capture" />
        <button type="submit" className="btn btn-primary">
          Send
        </button>
      </form>
      {made ? <ShipCard thought={made} /> : sent ? <p className="set-dim">Listening to it…</p> : null}
    </div>
  );
}

export function Onboarding() {
  const profile = useProfile((s) => s.profile);
  const [step, setStep] = useState(0);
  if (!profile || profile.onboarded) return null;
  const finish = (): void => void useProfile.getState().save({ ...profile, onboarded: true }).catch((e: Error) => toast.warn(e.message));
  const last = step === STEPS.length - 1;
  return (
    <div className="onb" role="dialog" aria-modal="true" aria-labelledby="onb-title">
      <div className="onb__card">
        <div className="onb__progress" aria-hidden>
          {STEPS.map((s, i) => (
            <span key={s} className={i <= step ? "is-on" : ""} />
          ))}
        </div>
        <p className="onb__eyebrow">
          Step {step + 1} of {STEPS.length}
        </p>
        <h2 id="onb-title" className="onb__title">
          {step === 0 ? "Ramble. Synapse ships it." : step === 1 ? "Connect GitHub" : step === 2 ? "Who do you work with?" : step === 3 ? "Put it on your phone" : "Try it"}
        </h2>
        {step === 0 ? (
          <div className="onb-body">
            <p>Talk the way you think. Synapse turns one ramble into finished things: a GitHub issue, an email draft, a reminder, a note. It skips the asides and remembers the rest.</p>
            <p className="onb-quote">“That bug from yesterday in the cart service… oh, and email the team that the launch moves to Friday. Remind me to call the landlord tomorrow at 6.”</p>
            <p className="set-dim">Nothing is sent to anyone without your tap.</p>
          </div>
        ) : step === 1 ? (
          <div className="onb-body">
            <GithubConnect />
            <GithubImport />
          </div>
        ) : step === 2 ? (
          <div className="onb-body">
            <p className="set-dim">Teammates from GitHub are already in. Add anyone else, or skip: Synapse asks for an address the first time it needs one.</p>
            <PeopleSources />
          </div>
        ) : step === 3 ? (
          <PhoneStep />
        ) : (
          <TryStep />
        )}
        <footer className="onb__foot">
          <button type="button" className="btn btn-ghost" onClick={finish}>
            Skip setup
          </button>
          <span className="onb__spacer" />
          {step > 0 ? (
            <button type="button" className="btn" onClick={() => setStep(step - 1)}>
              Back
            </button>
          ) : null}
          <button type="button" className="btn btn-primary" onClick={() => (last ? finish() : setStep(step + 1))}>
            {last ? "Done" : step === 0 ? "Get started" : "Next"}
          </button>
        </footer>
      </div>
    </div>
  );
}
