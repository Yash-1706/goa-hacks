// The test suite's recording fake of the GitHub REST API, as a standalone server for end-to-end runs: issues are "created"
// here and never on GitHub. GET /__issues lists what was filed (no auth, local only).
// usage: FAKE_GITHUB_TOKEN=... FAKE_GITHUB_REPO=owner/name pnpm --filter @synapse/server exec tsx ../../scripts/e2e/fake-github-server.ts
import http from "node:http";
import { startFakeGithub } from "../../apps/server/test/fake-github";

const token = process.env.FAKE_GITHUB_TOKEN ?? "ghp_fake_e2e_token";
const repo = process.env.FAKE_GITHUB_REPO ?? "rio-dev/synapse-sandbox";
const fake = await startFakeGithub({ token, login: repo.split("/")[0] as string, repos: [{ full_name: repo, pushed_at: new Date().toISOString() }] });
// a tiny side door so a check can see what was filed
const peek = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ issues: fake.issues, writes: fake.requests.filter((r) => r.method !== "GET").length }));
});
await new Promise<void>((r) => peek.listen(0, "127.0.0.1", r));
const port = (peek.address() as { port: number }).port;
console.log(`FAKE_GITHUB_URL=${fake.url}`);
console.log(`FAKE_GITHUB_PEEK=http://127.0.0.1:${port}`);
process.on("SIGTERM", () => void fake.close().then(() => process.exit(0)));
await new Promise(() => undefined);
