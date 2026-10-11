import type { GithubStatus, ImportSuggestions } from "@synapse/shared";
import { log } from "../log";
import type { Db } from "../memory/db";
import type { Vault } from "../memory/crypto";

/* ============================================================================
 * GitHub (V1 phase 3b/3d): one tap to connect, repos and teammates suggested from the account, issues created for real.
 *
 * Token sources, in order: one saved in Synapse (sealed with the long-term key, server-side only), GITHUB_TOKEN in .env,
 * and the `gh` CLI on this Mac, which is only OFFERED ("Found your GitHub account @login. Use it?") and saved when the user
 * says yes. The token never reaches the browser and is never logged.
 * ========================================================================== */

const TIMEOUT_MS = 10_000;
const SETTING = "github_token_enc";
const AAD = "settings|github_token";
const BOT = /\[bot\]|^dependabot|^renovate|^github-actions/i;
const NOREPLY = /noreply/i;

export class GithubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GithubError";
  }
}

export class GithubApi {
  constructor(
    private token: string,
    private base: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base.replace(/\/$/, "")}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "synapse",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      let msg = `GitHub ${res.status}`;
      try {
        const j = (await res.json()) as { message?: string };
        if (j.message) msg = `GitHub ${res.status}: ${j.message.slice(0, 120)}`;
      } catch {
        /* not JSON */
      }
      throw new GithubError(msg, res.status);
    }
    return (await res.json()) as T;
  }

  user(): Promise<{ login: string; name: string | null; email: string | null }> {
    return this.call("GET", "/user");
  }

  repos(): Promise<Array<{ full_name: string; name: string; description: string | null; topics?: string[]; pushed_at: string | null }>> {
    return this.call("GET", "/user/repos?sort=pushed&per_page=30&affiliation=owner,collaborator,organization_member");
  }

  commits(repo: string): Promise<Array<{ commit: { author: { name: string; email: string } | null }; author: { login: string } | null }>> {
    return this.call("GET", `/repos/${repo}/commits?per_page=100`);
  }

  createIssue(repo: string, issue: { title: string; body: string; labels: string[] }): Promise<{ number: number; html_url: string }> {
    return this.call("POST", `/repos/${repo}/issues`, issue);
  }

  closeIssue(repo: string, n: number): Promise<unknown> {
    return this.call("PATCH", `/repos/${repo}/issues/${n}`, { state: "closed", state_reason: "not_planned" });
  }
}

export interface GithubAccountDeps {
  db: Db;
  vault: Vault;
  envToken: string;
  apiBase: string;
  /** `gh auth token` (null when the CLI is missing or logged out) */
  ghToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

export class GithubAccount {
  private loginCache: { token: string; login: string; at: number } | null = null;

  constructor(private d: GithubAccountDeps) {}

  /** the token Synapse uses: saved, else GITHUB_TOKEN (never the gh CLI's until the user said yes) */
  token(): string | null {
    const saved = this.d.db.getSetting(SETTING);
    if (saved) {
      try {
        return this.d.vault.open("ltm", AAD, Buffer.from(saved, "base64")).toString("utf8");
      } catch {
        log.warn("github", "the saved token could not be opened");
      }
    }
    return this.d.envToken || null;
  }

  api(): GithubApi | null {
    const t = this.token();
    return t ? new GithubApi(t, this.d.apiBase, this.d.fetchImpl) : null;
  }

  async status(): Promise<GithubStatus> {
    const saved = Boolean(this.d.db.getSetting(SETTING));
    const own = this.token();
    const source: GithubStatus["source"] = own ? (saved ? "saved" : "env") : null;
    const candidate = own ?? (await this.d.ghToken().catch(() => null));
    if (!candidate) return { source: null, login: null };
    try {
      return { source: source ?? "gh", login: await this.loginOf(candidate) };
    } catch (err) {
      return { source: source ?? "gh", login: null, error: (err as Error).message };
    }
  }

  /** "Found your GitHub account @login. Use it?" → yes: the gh CLI's token is checked and saved. */
  async useGh(): Promise<string> {
    const t = await this.d.ghToken().catch(() => null);
    if (!t) throw new GithubError("the gh CLI is not logged in on this Mac (run gh auth login)", 404);
    return this.saveToken(t);
  }

  /** A pasted token: checked against /user first, then sealed. */
  async saveToken(token: string): Promise<string> {
    const t = token.trim();
    let login: string;
    try {
      login = await this.loginOf(t);
    } catch (err) {
      throw new GithubError(`GitHub refused that token (${(err as Error).message})`, 400);
    }
    this.d.db.setSetting(SETTING, this.d.vault.seal("ltm", AAD, t).toString("base64"));
    log.info("github", "account connected", { login });
    return login;
  }

  forget(): void {
    this.d.db.setSetting(SETTING, "");
    this.loginCache = null;
  }

  private async loginOf(token: string): Promise<string> {
    if (this.loginCache?.token === token && Date.now() - this.loginCache.at < 10 * 60_000) return this.loginCache.login;
    const { login } = await new GithubApi(token, this.d.apiBase, this.d.fetchImpl).user();
    this.loginCache = { token, login, at: Date.now() };
    return login;
  }

  /**
   * Repos (30 most recently pushed; the 5 newest preselected, the newest the default; aliases from the name's words and the
   * topics) and teammates (commit authors of the preselected repos, without the user, bots and noreply addresses; the
   * most active preselected). Read-only.
   */
  async importSuggestions(): Promise<ImportSuggestions> {
    const api = this.api();
    if (!api) throw new GithubError("connect GitHub first", 409);
    const me = await api.user();
    const repos = (await api.repos()).sort((a, b) => (b.pushed_at ?? "").localeCompare(a.pushed_at ?? ""));
    const suggestions: ImportSuggestions["repos"] = repos.map((r, i) => {
      const words = r.name.toLowerCase().split(/[-_.\s]+/).filter(Boolean).join(" ");
      return {
        fullName: r.full_name,
        aliases: [...new Set([words, ...(r.topics ?? [])])].filter((a) => a && a !== r.full_name.toLowerCase()).slice(0, 10),
        isDefault: i === 0,
        ...(r.description ? { description: r.description.slice(0, 400) } : {}),
        ...(r.topics?.length ? { topics: r.topics.slice(0, 20) } : {}),
        pushedAt: r.pushed_at,
        selected: i < 5,
      };
    });
    const people = new Map<string, ImportSuggestions["people"][number]>();
    const mine = (name: string, email: string, login: string | undefined): boolean =>
      login === me.login || (me.email ? email.toLowerCase() === me.email.toLowerCase() : false) || (me.name ? name === me.name : false);
    for (const r of suggestions.filter((s) => s.selected)) {
      let commits: Awaited<ReturnType<GithubApi["commits"]>>;
      try {
        commits = await api.commits(r.fullName);
      } catch (err) {
        log.warn("github", "commits could not be read", { status: (err as GithubError).status });
        continue;
      }
      for (const c of commits) {
        const a = c.commit.author;
        if (!a?.email || !a.name) continue;
        const login = c.author?.login ?? undefined;
        if (BOT.test(a.name) || BOT.test(login ?? "") || NOREPLY.test(a.email) || mine(a.name, a.email, login)) continue;
        const key = a.email.toLowerCase();
        const p = people.get(key) ?? { name: a.name, aliases: [a.name.split(/\s+/)[0]!.toLowerCase()], email: key, ...(login ? { githubLogin: login } : {}), commits: 0, selected: false };
        p.commits++;
        people.set(key, p);
      }
    }
    const ranked = [...people.values()].sort((a, b) => b.commits - a.commits);
    ranked.forEach((p, i) => (p.selected = i < 8 && (p.commits >= 2 || i < 3)));
    return { login: me.login, repos: suggestions, people: ranked };
  }
}
