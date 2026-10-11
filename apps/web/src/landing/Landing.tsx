import { useEffect, useRef, useState } from "react";
import DemoStrip from "./DemoStrip";
import "./landing.css";

export interface LandingProps {
  /** Where "Open app" goes. */
  appUrl: string;
  /** The public repository. */
  repoUrl: string;
  /** A signed-in visitor gets "Open app" as the primary button. */
  loggedIn?: boolean;
}

const STEPS = [
  { n: "1", title: "Talk", body: "A home-screen app on your phone. Tap, talk, tap. It works offline and syncs later." },
  { n: "2", title: "Sorted", body: "One ramble becomes many items. It asks only when it must (which repo? whose email? what time?)." },
  { n: "3", title: "Ship", body: "One tap into GitHub, Gmail or Calendar. Nothing is sent without you." },
];

const EXAMPLES = [
  {
    say: "That bug from yesterday… the null pointer in cart service, probably the discount code.",
    get: "GitHub issue",
    detail: "A summary, what you saw and your suspected cause, filed to the right repo.",
    action: "Create issue",
  },
  {
    say: "Email the team that the launch moves to Friday.",
    get: "Email draft",
    detail: "Written in your voice, addressed from your contacts.",
    action: "Open draft",
  },
  {
    say: "Remind me to call the landlord tomorrow at 6.",
    get: "Reminder",
    detail: "At the time you said: “tomorrow at 6” is 18:00 your time.",
    action: "Add to calendar",
  },
  {
    say: "That caching idea from my walk, an LRU with a size cap would do it.",
    get: "Note",
    detail: "Nothing to ship: ask about it later.",
    action: "Saved & searchable",
  },
];

const COMPARISONS = [
  {
    category: "Task apps",
    them: "Put everything in one list you sort by hand.",
    us: "Routes each item to where it belongs: the repo, the inbox, the calendar.",
  },
  {
    category: "Voice assistants",
    them: "Need a command per thing, one at a time.",
    us: "Takes one ramble, no commands, and splits it into separate drafts.",
  },
  {
    category: "Note apps",
    them: "Give you one blob of text to sort yourself.",
    us: "Sorts it for you: one draft per item, each ready to send.",
  },
  {
    category: "Dictation",
    them: "Needs you to already be in the right app.",
    us: "Talk first, anywhere. It routes each item, and asks one question when a fact is missing.",
  },
];

const PRIVACY = [
  "Runs on your own computer: your Mac is the server.",
  "Audio is held only in memory on its way to speech-to-text (Sarvam), never written to the Mac's disk.",
  "Everything Synapse keeps is encrypted at rest on your Mac (AES-256-GCM).",
  "The drafting model (Groq) sees redacted text: emails, phone numbers and keys are masked first.",
  "On the phone, a recording is stored encrypted only while you're offline, and deleted once it's sent.",
  "Phone to Mac is HTTPS behind your passcode. Through Tailscale Funnel it is decrypted only on your Mac; the ngrok and Cloudflare fallbacks decrypt it at their servers on the way.",
];

const BUILT_WITH = [
  { name: "Wispr Flow", role: "Dictation into the capture box." },
  { name: "Sarvam", role: "Speech to text, strong on Indian English and Hinglish." },
  { name: "Groq", role: "Drafting." },
];

function Mark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="6" cy="12" r="2.5" fill="currentColor" />
      <circle cx="18" cy="6" r="2.5" fill="currentColor" />
      <circle cx="18" cy="18" r="2.5" fill="currentColor" />
      <path d="M8.2 11 15.8 7M8.2 13l7.6 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.71 1.22 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/* The launch video (docs/media, made with /brag): muted, looping, inline. Written as markup because React does not emit the
 * `muted` attribute, which iOS needs before it autoplays; reduced-motion visitors get it paused on its poster. Paths are
 * relative to the page base, so the same markup works on the Mac (/) and on GitHub Pages (/synapse-site/). */
const MEDIA = `${import.meta.env.BASE_URL}media/synapse-launch-landscape`;
const HERO_VIDEO = `<video class="lp-hero__video" autoplay muted loop playsinline preload="metadata" poster="${MEDIA}.jpg" aria-label="Synapse launch video: thoughts said on a treadmill, at the coffee kiosk and over a burger become a GitHub issue, a reminder and an email draft"><source src="${MEDIA}.mp4" type="video/mp4" /><img src="${MEDIA}.jpg" alt="A man running on a treadmill, under the line Best ideas show up anywhere, next to the GitHub issue card his thought became" /></video>`;

function HeroVideo() {
  const ref = useRef<HTMLDivElement>(null);
  const [soundOn, setSoundOn] = useState(false);
  useEffect(() => {
    const v = ref.current?.querySelector("video");
    if (!v) return;
    // the `autoplay` attribute alone does not start when the landing mounts lazily (the app's "/" route); start it here
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) v.pause();
    else void v.play().catch(() => undefined); // blocked (e.g. data saver): the poster stays
  }, []);
  // browsers only autoplay muted video: the music (and the run's footsteps) comes on with the visitor's own tap
  const toggleSound = (): void => {
    const v = ref.current?.querySelector("video");
    if (!v) return;
    v.muted = soundOn;
    if (!soundOn) void v.play().catch(() => undefined);
    setSoundOn(!soundOn);
  };
  return (
    <div className="lp-hero__frame">
      <div ref={ref} className="lp-hero__media" dangerouslySetInnerHTML={{ __html: HERO_VIDEO }} />
      <button type="button" className="lp-hero__sound" aria-pressed={soundOn} aria-label={soundOn ? "Turn sound off" : "Turn sound on"} onClick={toggleSound}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M11 5 6 9H3v6h3l5 4z" />
          {soundOn ? <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" /> : <path d="m22 9-6 6M16 9l6 6" />}
        </svg>
        {soundOn ? "Sound on" : "Tap for sound"}
      </button>
    </div>
  );
}

function Check() {
  return (
    <svg className="lp-check" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The public landing page. Standalone: it brings its own stylesheet (scoped under `.lp`) and imports nothing from the app.
 * Signed in, "Open app" is the primary action; otherwise the repo is (Synapse runs on your own Mac, so a new visitor starts there).
 */
export default function Landing({ appUrl, repoUrl, loggedIn = false }: LandingProps) {
  const openApp = (
    <a key="app" className={`lp-btn${loggedIn ? " lp-btn--primary" : ""}`} href={appUrl}>
      Open app
    </a>
  );
  const github = (
    <a key="repo" className={`lp-btn${loggedIn ? "" : " lp-btn--primary"}`} href={repoUrl}>
      <GitHubIcon />
      View on GitHub
    </a>
  );

  return (
    <div className="lp">
      <header className="lp-top">
        <div className="lp-wrap lp-top__inner">
          <span className="lp-brand">
            <Mark />
            Synapse
          </span>
          <nav aria-label="Primary">
            <a className="lp-top__link" href={appUrl}>
              Open app
            </a>
          </nav>
        </div>
      </header>

      <main>
        <section className="lp-hero" aria-labelledby="lp-hero-title">
          <div className="lp-wrap">
            <h1 id="lp-hero-title" className="lp-hero__title">
              Think out loud. Synapse files it.
            </h1>
            <p className="lp-hero__sub">
              Ramble on a walk. Get the GitHub issue, the email draft and the reminder, ready to send.
            </p>
            <div className="lp-hero__actions">{loggedIn ? [openApp, github] : [github, openApp]}</div>
            <HeroVideo />
          </div>
        </section>

        <section className="lp-section lp-section--demo" aria-labelledby="lp-demo-title">
          <div className="lp-wrap">
            <h2 id="lp-demo-title" className="lp-eyebrow">
              One ramble, three things
            </h2>
            <DemoStrip />
          </div>
        </section>

        <section className="lp-section" aria-labelledby="lp-how-title">
          <div className="lp-wrap">
            <h2 id="lp-how-title" className="lp-h2">
              How it works
            </h2>
            <ol className="lp-steps">
              {STEPS.map((s) => (
                <li key={s.title} className="lp-panel lp-step">
                  <span className="lp-step__n" aria-hidden="true">
                    {s.n}
                  </span>
                  <h3 className="lp-h3">{s.title}</h3>
                  <p className="lp-muted">{s.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="lp-section" aria-labelledby="lp-say-title">
          <div className="lp-wrap">
            <h2 id="lp-say-title" className="lp-h2">
              What you can say, and what you get
            </h2>
            <ul className="lp-examples">
              {EXAMPLES.map((e) => (
                <li key={e.get} className="lp-panel lp-example">
                  <blockquote className="lp-example__say">“{e.say}”</blockquote>
                  <div className="lp-example__get">
                    <span className="lp-arrow" aria-hidden="true">
                      →
                    </span>
                    <div>
                      <h3 className="lp-h3">{e.get}</h3>
                      <p className="lp-muted">{e.detail}</p>
                    </div>
                    <span className={e.get === "Note" ? "lp-chip" : "lp-chip lp-chip--action"}>{e.action}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="lp-section" aria-labelledby="lp-why-title">
          <div className="lp-wrap">
            <h2 id="lp-why-title" className="lp-h2">
              Why not just use…
            </h2>
            <dl className="lp-compare">
              {COMPARISONS.map((c) => (
                <div key={c.category} className="lp-panel lp-compare__row">
                  <dt className="lp-h3">{c.category}</dt>
                  <dd className="lp-compare__them">{c.them}</dd>
                  <dd className="lp-compare__us">
                    <span className="lp-compare__label">Synapse</span> {c.us}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="lp-section" aria-labelledby="lp-privacy-title">
          <div className="lp-wrap">
            <h2 id="lp-privacy-title" className="lp-h2">
              Privacy
            </h2>
            <ul className="lp-panel lp-privacy">
              {PRIVACY.map((p) => (
                <li key={p}>
                  <Check />
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="lp-section" aria-labelledby="lp-built-title">
          <div className="lp-wrap">
            <h2 id="lp-built-title" className="lp-h2">
              Built with
            </h2>
            <ul className="lp-built">
              {BUILT_WITH.map((b) => (
                <li key={b.name} className="lp-panel lp-built__item">
                  <h3 className="lp-h3">{b.name}</h3>
                  <p className="lp-muted">{b.role}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <div className="lp-wrap lp-foot__inner">
          <a className="lp-foot__link" href={repoUrl}>
            <GitHubIcon />
            GitHub
          </a>
          <p className="lp-faint">Built for the WhisperFlow Hackathon 2026 by Sayed Zahur.</p>
        </div>
      </footer>
    </div>
  );
}
