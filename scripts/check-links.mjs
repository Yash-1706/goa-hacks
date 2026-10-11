// Checks every relative link and image in the given Markdown files against `git ls-files`, case-sensitively
// (GitHub is case-sensitive; macOS is not). Also checks in-page anchors against the headings. Exit 1 on any miss.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const tracked = new Set(execSync("git ls-files", { encoding: "utf8" }).trim().split("\n"));
const dirs = new Set([...tracked].flatMap((f) => f.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"))));
const slug = (h) => h.trim().toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\p{L}\p{N} _-]/gu, "").replace(/ /g, "-");
let misses = 0;
for (const file of process.argv.slice(2)) {
  const md = fs.readFileSync(file, "utf8");
  const anchors = new Set([...md.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1])));
  const refs = [...md.matchAll(/\]\(([^)\s]+)\)/g), ...md.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  for (const ref of refs) {
    if (/^(https?:|mailto:)/.test(ref)) continue;
    const [p, hash] = ref.split("#");
    if (!p) {
      if (!anchors.has(hash)) { console.log(`${file}: missing anchor #${hash}`); misses++; }
      continue;
    }
    const target = path.normalize(path.join(path.dirname(file), decodeURIComponent(p))).replace(/\/$/, "");
    if (!tracked.has(target) && !dirs.has(target)) { console.log(`${file}: not tracked (case-sensitive): ${ref} -> ${target}`); misses++; }
  }
}
console.log(misses ? `${misses} broken link(s)` : "all links and images resolve (case-sensitive)");
process.exitCode = misses ? 1 : 0;
