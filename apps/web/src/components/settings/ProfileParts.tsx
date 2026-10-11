import { useEffect, useState } from "react";
import { Check, GitBranch as Github, Trash2, Users } from "lucide-react";
import type { GithubStatus, ImportSuggestions, Profile, ProfilePerson } from "@synapse/shared";
import { api } from "@/net/api";
import { toast } from "@/state/notices";
import { useProfile } from "@/state/profile";

/* ============================================================================
 * Profile & connections (V1 phase 3b UI), used by Settings and by the first-run setup. Every step is optional.
 * ========================================================================== */

/** GitHub: one tap when the gh CLI is logged in on the Mac, otherwise a pasted fine-grained token. */
export function GithubConnect({ onConnected }: { onConnected?: (login: string) => void }) {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = async (): Promise<void> => setStatus(await api.githubStatus().catch(() => ({ source: null, login: null })));
  useEffect(() => {
    void refresh();
  }, []);
  const run = async (fn: () => Promise<{ login: string }>): Promise<void> => {
    setBusy(true);
    try {
      const { login } = await fn();
      toast.success(`Connected to GitHub as @${login}`);
      await refresh();
      onConnected?.(login);
    } catch (e) {
      toast.warn((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!status) return <p className="set-dim">Checking GitHub…</p>;
  if (status.login && status.source !== "gh") {
    return (
      <div className="set-row">
        <Github size={16} aria-hidden />
        <span>
          Connected as <b>@{status.login}</b>
          {status.source === "env" ? " (GITHUB_TOKEN in .env)" : ""}
        </span>
        {status.source === "saved" ? (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void api.githubForget().then(refresh)}>
            Disconnect
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="set-stack">
      {status.source === "gh" && status.login ? (
        <div className="set-row">
          <Github size={16} aria-hidden />
          <span>
            Found your GitHub account <b>@{status.login}</b>. Use it?
          </span>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void run(api.githubUseGh)}>
            Yes, use it
          </button>
        </div>
      ) : null}
      <form
        className="set-row set-row--wrap"
        onSubmit={(e) => {
          e.preventDefault();
          if (token.trim()) void run(() => api.githubToken(token.trim())).then(() => setToken(""));
        }}
      >
        <input className="input set-grow" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste a fine-grained token (github_pat_…)" aria-label="GitHub token" />
        <button type="submit" className="btn" disabled={busy || !token.trim()}>
          Connect
        </button>
      </form>
      <p className="set-dim">
        <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">
          Create a token
        </a>{" "}
        with Repository access: your repos · Issues: Read and write · Metadata: Read. It stays on your Mac, encrypted.
      </p>
    </div>
  );
}

/** Repos and teammates suggested from the account (the user unticks what they do not want). */
export function GithubImport({ onSaved }: { onSaved?: (p: Profile) => void }) {
  const [s, setS] = useState<ImportSuggestions | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async (): Promise<void> => {
    setBusy(true);
    try {
      setS(await api.githubImport());
    } catch (e) {
      toast.warn((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = async (): Promise<void> => {
    if (!s) return;
    setBusy(true);
    try {
      const repos = s.repos.filter((r) => r.selected).map(({ pushedAt: _p, selected: _s, ...r }) => r);
      const people = s.people.filter((p) => p.selected).map(({ commits: _c, selected: _s, ...p }) => p);
      const saved = await api.mergeProfile({ repos, people });
      useProfile.getState().set(saved);
      toast.success(`Saved ${repos.length} repos and ${people.length} people`);
      setS(null);
      onSaved?.(saved);
    } catch (e) {
      toast.warn((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!s)
    return (
      <button type="button" className="btn" disabled={busy} onClick={() => void load()}>
        <Github size={15} /> {busy ? "Reading your GitHub…" : "Suggest repos and teammates"}
      </button>
    );
  const def = s.repos.find((r) => r.isDefault)?.fullName;
  return (
    <div className="set-stack">
      <h4 className="set-h">Repos</h4>
      <ul className="set-list">
        {s.repos.map((r, i) => (
          <li key={r.fullName} className="set-item">
            <label className="set-check">
              <input type="checkbox" checked={r.selected} onChange={(e) => setS({ ...s, repos: s.repos.map((x, j) => (j === i ? { ...x, selected: e.target.checked } : x)) })} />
              <span className="set-item__name">{r.fullName}</span>
            </label>
            <label className="set-radio" title="New GitHub issues go here unless you name another repo">
              <input type="radio" name="default-repo" checked={def === r.fullName} disabled={!r.selected} onChange={() => setS({ ...s, repos: s.repos.map((x) => ({ ...x, isDefault: x.fullName === r.fullName })) })} />
              default
            </label>
          </li>
        ))}
      </ul>
      <h4 className="set-h">Teammates (from recent commits)</h4>
      {s.people.length ? (
        <ul className="set-list">
          {s.people.map((p, i) => (
            <li key={p.email ?? p.name} className="set-item">
              <label className="set-check">
                <input type="checkbox" checked={p.selected} onChange={(e) => setS({ ...s, people: s.people.map((x, j) => (j === i ? { ...x, selected: e.target.checked } : x)) })} />
                <span className="set-item__name">{p.name}</span>
                <span className="set-dim">{p.email}</span>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <p className="set-dim">No teammates in the recent commits of the selected repos.</p>
      )}
      <div className="set-row">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
          <Check size={15} /> Save
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => setS(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

type Contact = { name: string; email?: string; phone?: string };
type ContactsApi = { select: (props: string[], o: { multiple: boolean }) => Promise<Array<{ name?: string[]; email?: string[]; tel?: string[] }>> };

/** People from the phone's contacts (Android Chrome's Contact Picker) or from a pasted list; always confirmed first. */
export function PeopleSources({ onSaved }: { onSaved?: (p: Profile) => void }) {
  const [text, setText] = useState("");
  const [found, setFound] = useState<Array<Contact & { keep: boolean }> | null>(null);
  const [busy, setBusy] = useState(false);
  const contacts = (navigator as Navigator & { contacts?: ContactsApi }).contacts;
  const pick = async (): Promise<void> => {
    try {
      const list = await contacts!.select(["name", "email", "tel"], { multiple: true });
      setFound(list.map((c) => ({ name: c.name?.[0] ?? c.email?.[0] ?? "", ...(c.email?.[0] ? { email: c.email[0] } : {}), ...(c.tel?.[0] ? { phone: c.tel[0] } : {}), keep: true })).filter((c) => c.name));
    } catch {
      /* the user closed the picker */
    }
  };
  const parse = async (): Promise<void> => {
    setBusy(true);
    try {
      const { people } = await api.parseContacts(text);
      setFound(people.map((p) => ({ ...p, keep: true })));
      if (!people.length) toast.info("No names with an email or phone number found in that text.");
    } catch (e) {
      toast.warn((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = async (): Promise<void> => {
    if (!found) return;
    const people: ProfilePerson[] = found.filter((c) => c.keep).map((c) => ({ name: c.name, aliases: [c.name.split(/\s+/)[0]!.toLowerCase()], ...(c.email ? { email: c.email } : {}), ...(c.phone ? { phone: c.phone } : {}) }));
    const saved = await api.mergeProfile({ people });
    useProfile.getState().set(saved);
    toast.success(`Saved ${people.length} people`);
    setFound(null);
    setText("");
    onSaved?.(saved);
  };
  if (found)
    return (
      <div className="set-stack">
        <h4 className="set-h">Add these people?</h4>
        <ul className="set-list">
          {found.map((c, i) => (
            <li key={`${c.name}-${i}`} className="set-item">
              <label className="set-check">
                <input type="checkbox" checked={c.keep} onChange={(e) => setFound(found.map((x, j) => (j === i ? { ...x, keep: e.target.checked } : x)))} />
                <span className="set-item__name">{c.name}</span>
                <span className="set-dim">{[c.email, c.phone].filter(Boolean).join(" · ")}</span>
              </label>
            </li>
          ))}
        </ul>
        <div className="set-row">
          <button type="button" className="btn btn-primary" onClick={() => void save()}>
            <Check size={15} /> Save
          </button>
          <button type="button" className="btn" onClick={() => setFound(null)}>
            Cancel
          </button>
        </div>
      </div>
    );
  return (
    <div className="set-stack">
      {contacts?.select ? (
        <button type="button" className="btn" onClick={() => void pick()}>
          <Users size={15} /> Pick from your contacts
        </button>
      ) : null}
      <textarea className="input" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={"Paste a team list, a CSV or vCards\nSarah Chen <sarah@acme.io>"} aria-label="Paste people" />
      <div className="set-row">
        <button type="button" className="btn" disabled={busy || !text.trim()} onClick={() => void parse()}>
          Read the list
        </button>
      </div>
    </div>
  );
}

/** What the profile holds now, editable: people, repos (and the default), the email app, the timezone. */
export function ProfileEditor() {
  const profile = useProfile((s) => s.profile);
  const save = (p: Profile): void => void useProfile.getState().save(p).catch((e: Error) => toast.warn(e.message));
  useEffect(() => {
    if (!profile) void useProfile.getState().load();
  }, [profile]);
  if (!profile) return <p className="set-dim">Loading…</p>;
  return (
    <div className="set-stack">
      <h4 className="set-h">People ({profile.people.length})</h4>
      {profile.people.length ? (
        <ul className="set-list">
          {profile.people.map((p, i) => (
            <li key={`${p.name}-${i}`} className="set-item">
              <span className="set-item__name">{p.name}</span>
              <span className="set-dim">{p.email ?? "no email yet: Synapse asks the first time"}</span>
              <button type="button" className="icon-btn" aria-label={`Remove ${p.name}`} onClick={() => save({ ...profile, people: profile.people.filter((_, j) => j !== i) })}>
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="set-dim">Nobody yet. Import teammates from GitHub, pick contacts, or paste a list.</p>
      )}
      <h4 className="set-h">Repos ({profile.repos.length})</h4>
      {profile.repos.length ? (
        <ul className="set-list">
          {profile.repos.map((r, i) => (
            <li key={r.fullName} className="set-item">
              <label className="set-radio">
                <input type="radio" name="profile-default" checked={r.isDefault} onChange={() => save({ ...profile, repos: profile.repos.map((x) => ({ ...x, isDefault: x.fullName === r.fullName })) })} />
                <span className="set-item__name">{r.fullName}</span>
              </label>
              {r.isDefault ? <span className="set-dim">default</span> : null}
              <button type="button" className="icon-btn" aria-label={`Remove ${r.fullName}`} onClick={() => save({ ...profile, repos: profile.repos.filter((_, j) => j !== i) })}>
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="set-dim">No repos yet. A GitHub issue asks “Which repo?” until there is one.</p>
      )}
      <div className="set-grid2">
        <label className="set-field">
          <span>Open email drafts in</span>
          <select className="input" value={profile.emailApp} onChange={(e) => save({ ...profile, emailApp: e.target.value as Profile["emailApp"] })}>
            <option value="gmail">Gmail in the browser</option>
            <option value="mailto">My default mail app</option>
          </select>
        </label>
        <label className="set-field">
          <span>Timezone</span>
          <input className="input" value={profile.timezone} onChange={(e) => useProfile.getState().set({ ...profile, timezone: e.target.value })} onBlur={() => save(profile)} />
        </label>
      </div>
    </div>
  );
}
