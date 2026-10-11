import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A recording fake of the GitHub REST API subset Synapse uses: GET /user, GET /user/repos, GET /repos/{o}/{r}/commits,
 * POST /repos/{o}/{r}/issues, PATCH /repos/{o}/{r}/issues/{n}. Bearer auth like the real one (401 "Bad credentials").
 * Every request is recorded so a test can say exactly what would have reached GitHub. Never talks to the network.
 */

export interface FakeRepo {
  full_name: string;
  description?: string | null;
  topics?: string[];
  pushed_at: string;
  private?: boolean;
  /** commits returned for this repo */
  commits?: Array<{ name: string; email: string; login?: string | null }>;
}

export interface FakeGithubRequest {
  method: string;
  path: string;
  auth: string | undefined;
  body: unknown;
}

export interface FakeGithub {
  url: string;
  requests: FakeGithubRequest[];
  issues: Array<{ repo: string; number: number; title: string; body: string; labels: string[]; state: string }>;
  close(): Promise<void>;
}

export async function startFakeGithub(o: { token: string; login: string; email?: string; name?: string; repos: FakeRepo[] }): Promise<FakeGithub> {
  const requests: FakeGithubRequest[] = [];
  const issues: FakeGithub["issues"] = [];
  const json = (res: http.ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const auth = req.headers.authorization;
      requests.push({ method: req.method ?? "GET", path: url.pathname + url.search, auth, body });
      if (auth !== `Bearer ${o.token}`) return json(res, 401, { message: "Bad credentials" });
      const m = url.pathname;
      if (req.method === "GET" && m === "/user") return json(res, 200, { login: o.login, name: o.name ?? o.login, email: o.email ?? null });
      if (req.method === "GET" && m === "/user/repos") {
        const sorted = [...o.repos].sort((a, b) => b.pushed_at.localeCompare(a.pushed_at));
        const per = Number(url.searchParams.get("per_page") ?? 30);
        return json(res, 200, sorted.slice(0, per).map((r) => ({ full_name: r.full_name, name: r.full_name.split("/")[1], description: r.description ?? null, topics: r.topics ?? [], pushed_at: r.pushed_at, private: r.private ?? true })));
      }
      const commits = m.match(/^\/repos\/([^/]+\/[^/]+)\/commits$/);
      if (req.method === "GET" && commits) {
        const repo = o.repos.find((r) => r.full_name === commits[1]);
        if (!repo) return json(res, 404, { message: "Not Found" });
        return json(res, 200, (repo.commits ?? []).map((c, i) => ({ sha: `s${i}`, commit: { author: { name: c.name, email: c.email } }, author: c.login ? { login: c.login } : null })));
      }
      const create = m.match(/^\/repos\/([^/]+\/[^/]+)\/issues$/);
      if (req.method === "POST" && create) {
        const b = body as { title?: string; body?: string; labels?: string[] };
        if (!b?.title) return json(res, 422, { message: "Validation Failed" });
        const issue = { repo: create[1] as string, number: issues.length + 1, title: b.title, body: b.body ?? "", labels: b.labels ?? [], state: "open" };
        issues.push(issue);
        return json(res, 201, { number: issue.number, html_url: `https://github.com/${issue.repo}/issues/${issue.number}` });
      }
      const patch = m.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/);
      if (req.method === "PATCH" && patch) {
        const issue = issues.find((x) => x.repo === patch[1] && x.number === Number(patch[2]));
        if (!issue) return json(res, 404, { message: "Not Found" });
        issue.state = (body as { state?: string })?.state ?? issue.state;
        return json(res, 200, { number: issue.number, state: issue.state });
      }
      return json(res, 404, { message: "Not Found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    issues,
    close: () => new Promise((r) => (server.close(() => r()), server.closeAllConnections?.())),
  };
}
