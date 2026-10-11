// Read-only check of the GitHub profile import against the REAL account of `gh auth token`: prints counts only (no names,
// no addresses, no repo names). Writes nothing anywhere (an in-memory database and a throwaway key).
// usage: pnpm --filter @synapse/server exec tsx ../../scripts/e2e/import-check.ts
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Vault } from "../../apps/server/src/memory/crypto";
import { Db } from "../../apps/server/src/memory/db";
import { GithubAccount } from "../../apps/server/src/profile/github";

const gh = (): Promise<string | null> => new Promise((r) => execFile("gh", ["auth", "token"], { timeout: 5000 }, (e, out) => r(e ? null : String(out).trim() || null)));
const db = new Db(":memory:");
const vault = Vault.withKek(db, randomBytes(32));
const token = await gh();
if (!token) {
  console.log(JSON.stringify({ ok: false, reason: "gh is not logged in" }));
  process.exit(0);
}
const account = new GithubAccount({ db, vault, envToken: token, apiBase: "https://api.github.com", ghToken: async () => null });
const t0 = Date.now();
const s = await account.importSuggestions().catch((e: Error) => { console.log("FAILED", e.name, (e.stack ?? "").split("\n").slice(0, 6).join(" / ")); process.exit(1); });
console.log(
  JSON.stringify({
    ok: true,
    ms: Date.now() - t0,
    repos: s.repos.length,
    preselectedRepos: s.repos.filter((r) => r.selected).length,
    defaultRepos: s.repos.filter((r) => r.isDefault).length,
    reposWithAliases: s.repos.filter((r) => r.aliases.length).length,
    teammates: s.people.length,
    preselectedTeammates: s.people.filter((p) => p.selected).length,
    teammatesWithEmail: s.people.filter((p) => p.email).length,
  }),
);
db.close();
