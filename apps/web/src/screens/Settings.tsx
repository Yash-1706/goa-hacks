import { Suspense, lazy, useEffect, useState } from "react";
import { tunnelHeaders } from "@/net/tunnel";
import { NavLink, useParams } from "react-router-dom";
import { GithubConnect, GithubImport, PeopleSources, ProfileEditor } from "@/components/settings/ProfileParts";
import { api } from "@/net/api";
import { useAuth } from "@/state/auth";
import { toast } from "@/state/notices";
import { useProfile } from "@/state/profile";
import { useSettings } from "@/state/settings";

/* ============================================================================
 * Settings (V1): everything that used to be a top-level screen lives here, so the main navigation stays Inbox · Ask.
 * ========================================================================== */

const Privacy = lazy(() => import("@/screens/Privacy"));
const Graph = lazy(() => import("@/screens/Graph"));
const Outbox = lazy(() => import("@/screens/Outbox"));
const Lab = lazy(() => import("@/screens/Lab"));

export const SETTINGS_TABS = [
  { id: "profile", label: "Profile & connections" },
  { id: "voice", label: "Voice engine" },
  { id: "model", label: "AI model" },
  { id: "privacy", label: "Privacy" },
  { id: "memory", label: "Memory map" },
  { id: "outbox", label: "Outbox history" },
  { id: "developer", label: "Developer" },
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];

function Card({ title, children, hint }: { title: string; children?: React.ReactNode; hint?: string }) {
  return (
    <section className="set-card">
      <h3 className="set-card__title">{title}</h3>
      {hint ? <p className="set-dim">{hint}</p> : null}
      {children}
    </section>
  );
}

function LocalOnlyToggle() {
  const localOnly = useSettings((s) => s.config?.localOnly ?? false);
  const toggle = async (on: boolean): Promise<void> => {
    try {
      const r = await api.setLocalOnly(on);
      const cur = useSettings.getState().config;
      if (cur) useSettings.getState().setConfig({ ...cur, localOnly: r.localOnly });
    } catch (err) {
      toast.warn((err as Error).message);
    }
  };
  return (
    <label className="set-check">
      <input type="checkbox" checked={localOnly} onChange={(e) => void toggle(e.target.checked)} />
      <span>Local-only: nothing leaves this Mac (speech on the Mac, the offline cortex)</span>
    </label>
  );
}

/** The capture-only token (for an iPhone Shortcut or the Mac app later): POST /api/capture and nothing else. */
function CaptureToken() {
  const [token, setToken] = useState<string | null>(null);
  const call = async (rotate: boolean): Promise<void> => {
    try {
      const r = await fetch(rotate ? "/api/auth/capture-token/rotate" : "/api/auth/capture-token", { method: rotate ? "POST" : "GET", credentials: "same-origin", headers: tunnelHeaders() });
      const j = (await r.json()) as { token?: string; error?: string };
      if (!r.ok || !j.token) throw new Error(j.error ?? `HTTP ${r.status}`);
      setToken(j.token);
    } catch (e) {
      toast.warn((e as Error).message);
    }
  };
  return token ? (
    <div className="set-stack">
      <input className="input" readOnly value={token} aria-label="Capture token" onFocus={(e) => e.target.select()} />
      <div className="set-row">
        <button type="button" className="btn btn-sm" onClick={() => void navigator.clipboard?.writeText(token).then(() => toast.success("Copied"))}>
          Copy
        </button>
        <button type="button" className="btn btn-sm" onClick={() => void call(true)}>
          Replace it (the old one stops working)
        </button>
      </div>
    </div>
  ) : (
    <button type="button" className="btn btn-sm" onClick={() => void call(false)}>
      Show the capture token
    </button>
  );
}

function ProfileTab() {
  const [, bump] = useState(0);
  const logout = useAuth((s) => s.logout);
  const passcodeSet = useAuth((s) => s.passcodeSet);
  return (
    <div className="set-cards">
      <Card title="GitHub" hint="Issues are created in your repos with one tap. Optional: without it, “Create issue” opens a prefilled GitHub page.">
        <GithubConnect onConnected={() => bump((n) => n + 1)} />
        <GithubImport />
      </Card>
      <Card title="Add people" hint="So “email Dev” knows Dev's address. Synapse also asks the first time and remembers.">
        <PeopleSources />
      </Card>
      <Card title="Your profile">
        <ProfileEditor />
      </Card>
      {passcodeSet ? (
        <>
          <Card title="Shortcuts and other apps" hint="A token that can only send captures (POST /api/capture with Authorization: Bearer …). For an iPhone Shortcut or a script.">
            <CaptureToken />
          </Card>
          <Card title="Devices" hint="Sign this browser out, or every phone and browser at once (also ends the capture token).">
            <div className="set-row">
              <button type="button" className="btn" onClick={() => void logout()}>
                Sign out
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  if (!window.confirm("Log out every device, including this one? Each one signs in again with the passcode.")) return;
                  void api.revokeAll().then(
                    () => useAuth.getState().require(),
                    (e: Error) => toast.warn(e.message),
                  );
                }}
              >
                Log out all devices
              </button>
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function VoiceTab() {
  const c = useSettings((s) => s.config);
  const engine = !c ? "…" : c.wisprMode === "client" || c.wisprMode === "proxy" ? "Wispr Flow" : c.wisprMode === "local" ? (c.sttProvider === "sarvam" ? "Sarvam (cloud)" : "On-device Whisper") : "Typed only (no live microphone engine)";
  return (
    <div className="set-cards">
      <Card title="Live microphone (laptop)" hint="The mic button in the Inbox streams to this engine.">
        <p className="set-big">{engine}</p>
        <p className="set-dim">Change it in .env: WISPR_MODE=sarvam with SARVAM_API_KEY, WISPR_MODE=local for Whisper on this Mac, WISPR_MODE=client with WISPR_API_KEY for Wispr Flow.</p>
      </Card>
      <Card title="Phone recordings" hint="Clips recorded on /capture are transcribed by Sarvam when SARVAM_API_KEY is set, otherwise by Whisper on this Mac.">
        <LocalOnlyToggle />
      </Card>
      <Card title="Typing and Wispr Flow dictation" hint="Anything typed into the Inbox box (or dictated into it with Wispr Flow's hotkey) goes through the same pipeline." />
    </div>
  );
}

function ModelTab() {
  const c = useSettings((s) => s.config);
  const model = !c ? "…" : c.localOnly ? "Offline cortex (local-only is on)" : c.llmMode === "live" ? `${c.llmProvider === "groq" ? "Groq" : "Claude"} · ${c.llmModel ?? ""}` : "Offline cortex (no model key)";
  return (
    <div className="set-cards">
      <Card title="What turns your words into cards" hint="Text is redacted before every cloud call; the offline cortex runs on this Mac.">
        <p className="set-big">{model}</p>
        <p className="set-dim">Set GROQ_API_KEY (free at console.groq.com) or ANTHROPIC_API_KEY and LLM_MODE=live in .env, then restart. pnpm run doctor checks the keys.</p>
        <LocalOnlyToggle />
      </Card>
    </div>
  );
}

function Developer() {
  return (
    <details className="set-card set-dev">
      <summary>Developer tools (latency, energy, dictionary, autonomy)</summary>
      <Suspense fallback={<p className="set-dim">Loading…</p>}>
        <Lab />
      </Suspense>
    </details>
  );
}

export default function Settings() {
  const { tab = "profile" } = useParams<{ tab?: string }>();
  const current = (SETTINGS_TABS.find((t) => t.id === tab)?.id ?? "profile") as SettingsTab;
  useEffect(() => {
    if (!useProfile.getState().profile) void useProfile.getState().load();
  }, []);
  return (
    <div className="settings">
      <h1 className="settings__title">Settings</h1>
      <nav className="settings__tabs" aria-label="Settings">
        {SETTINGS_TABS.map((t) => (
          <NavLink key={t.id} to={`/settings/${t.id}`} className={({ isActive }) => `settings__tab${isActive || (t.id === "profile" && current === "profile") ? " is-active" : ""}`}>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <div className="settings__body">
        <Suspense fallback={<p className="set-dim">Loading…</p>}>
          {current === "profile" ? <ProfileTab /> : null}
          {current === "voice" ? <VoiceTab /> : null}
          {current === "model" ? <ModelTab /> : null}
          {current === "privacy" ? <Privacy /> : null}
          {current === "memory" ? <Graph /> : null}
          {current === "outbox" ? <Outbox /> : null}
          {current === "developer" ? <Developer /> : null}
        </Suspense>
      </div>
    </div>
  );
}
