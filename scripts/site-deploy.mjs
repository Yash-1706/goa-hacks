// `pnpm run site:deploy`: publishes site-dist/ (the static landing page ONLY) to GitHub Pages in <gh user>/synapse-site.
// Creates the public repo and turns Pages on the first time. Nothing else from this repo is ever pushed there: the deploy
// works in a separate clone (site-deploy/, gitignored) and refuses any file that is not part of the built landing page.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "site-dist");
const work = path.join(root, "site-deploy");
const REPO_NAME = process.env.SITE_REPO ?? "synapse-site";

const sh = (cmd, args, o = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...o }).trim();
const tryJson = (cmd, args) => {
  try {
    return JSON.parse(sh(cmd, args));
  } catch {
    return null;
  }
};
// gh's own token for this one command, never written to a config file or printed
const git = (args) => sh("git", ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", ...args], { cwd: work });

// 1. only the built landing page may go out
const ALLOWED = /^(index\.html|favicon\.svg|og\.png|\.nojekyll|assets\/index-[\w-]+\.(js|css)|media\/synapse-launch-landscape\.(mp4|jpg))$/;
const files = fs.readdirSync(dist, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(dist, f)).isFile());
const stray = files.filter((f) => !ALLOWED.test(f.split(path.sep).join("/")));
if (stray.length || !files.includes("index.html")) {
  console.error(`✖ refusing to deploy: unexpected files in site-dist: ${stray.join(", ") || "(no index.html)"}`);
  process.exitCode = 1;
} else {
  const owner = sh("gh", ["api", "user", "--jq", ".login"]);
  const full = `${owner}/${REPO_NAME}`;

  // 2. the repo: created once, public, holding nothing but the site
  if (!tryJson("gh", ["repo", "view", full, "--json", "name"])) {
    sh("gh", ["repo", "create", full, "--public", "--description", "Synapse landing page (static). The app: https://github.com/Yash-1706/goa-hacks", "--homepage", `https://${owner.toLowerCase()}.github.io/${REPO_NAME}/`]);
    console.log(`created ${full} (public)`);
  }

  // 3. a separate clone; its contents are replaced by site-dist
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  git(["init", "-q", "-b", "main"]);
  git(["remote", "add", "origin", `https://github.com/${full}.git`]);
  let hasMain = true;
  try {
    git(["fetch", "-q", "--depth", "1", "origin", "main"]);
    git(["checkout", "-q", "-B", "main", "FETCH_HEAD"]);
  } catch {
    hasMain = false; // a brand-new, empty repo
  }
  for (const f of fs.readdirSync(work)) if (f !== ".git") fs.rmSync(path.join(work, f), { recursive: true, force: true });
  fs.cpSync(dist, work, { recursive: true });
  git(["add", "-A"]);
  const changed = git(["status", "--porcelain"]);
  if (!changed) console.log("site unchanged: nothing to push");
  else {
    git(["commit", "-q", "-m", `Landing page build ${new Date().toISOString().slice(0, 16).replace("T", " ")}`]);
    git(["push", "-q", "origin", "main"]);
    console.log(`pushed ${changed.split("\n").length} changed file(s) to ${full}${hasMain ? "" : " (first deploy)"}`);
  }

  // 4. Pages from main /, turned on once
  let pages = tryJson("gh", ["api", `repos/${full}/pages`]);
  if (!pages) {
    sh("gh", ["api", "-X", "POST", `repos/${full}/pages`, "-f", "source[branch]=main", "-f", "source[path]=/"]);
    pages = tryJson("gh", ["api", `repos/${full}/pages`]);
    console.log("GitHub Pages enabled (main, /)");
  }
  const url = pages?.html_url ?? `https://${owner.toLowerCase()}.github.io/${REPO_NAME}/`;

  // 5. wait for the build to go live (first deploys take a minute or two)
  let live = false;
  for (let i = 0; i < 40 && !live; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000), cache: "no-store" });
      live = r.ok && (await r.text()).includes("Synapse");
    } catch {
      /* not yet */
    }
    if (!live) await new Promise((r) => setTimeout(r, 6000));
  }
  console.log(live ? `✅ live: ${url}` : `⚠ pushed, but ${url} is not serving yet: GitHub Pages can take a few minutes (gh api repos/${full}/pages/builds/latest)`);
  fs.rmSync(work, { recursive: true, force: true });
}
