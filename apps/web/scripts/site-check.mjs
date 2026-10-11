// After `site:build`: the static landing page must hold no app code, no API calls and no secrets (it is published on GitHub Pages).
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(import.meta.dirname, "../../../site-dist");
const files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(dir, f)).isFile());
const FORBIDDEN = [/[a-z0-9-]+\.ts\.net/, /\/api\//, /x-synapse-device/, /\/ws\b/, /gsk_[A-Za-z0-9]{10}/, /sk_[a-z0-9]{8}_/, /ghp_[A-Za-z0-9]{10}/, /SYNAPSE_PASSCODE/];
const problems = [];
let bytes = 0;
for (const f of files) {
  const buf = fs.readFileSync(path.join(dir, f));
  bytes += buf.length;
  if (!/\.(js|html|css|txt|json)$/.test(f)) continue;
  const text = buf.toString("utf8");
  for (const re of FORBIDDEN) if (re.test(text)) problems.push(`${f}: matches ${re}`);
}
if (!files.includes("index.html")) problems.push("index.html missing");
if (!files.includes("og.png")) problems.push("og.png missing");
console.log(`site-dist: ${files.length} files, ${(bytes / 1024).toFixed(0)} KB`);
if (problems.length) {
  console.error(`✖ site check failed:\n  ${problems.join("\n  ")}`);
  process.exitCode = 1;
} else console.log("✅ site check: no app code, no API calls, no secrets");
