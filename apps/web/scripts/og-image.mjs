// `pnpm --filter @synapse/web og`: renders the 1200×630 share image (public/og.png) in the landing page's own tokens.
import path from "node:path";
import { launch } from "../../../scripts/e2e/lib.mjs";

const out = path.resolve(import.meta.dirname, "../public/og.png");
const card = (label, title, meta) => `<div class="card"><div class="lbl">${label}</div><div class="t">${title}</div><div class="m">${meta}</div></div>`;
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0}
  body{width:1200px;height:630px;background:#0c0c0d;color:#ededed;font-family:Helvetica,"Helvetica Neue",Arial,sans-serif;padding:72px 80px;display:flex;flex-direction:column;justify-content:space-between}
  .brand{display:flex;align-items:center;gap:14px;font-size:28px;font-weight:600;letter-spacing:-.01em}
  .dot{width:16px;height:16px;border-radius:50%;background:#ff6a3d}
  h1{font-size:66px;line-height:1.05;letter-spacing:-.035em;font-weight:700;white-space:nowrap}
  h1 em{font-style:normal;color:#ff6a3d}
  .ramble{font-family:"SF Mono",Menlo,monospace;font-size:21px;color:#a1a1aa;border-left:3px solid #ff6a3d;padding-left:18px;max-width:1000px;line-height:1.45}
  .cards{display:flex;gap:18px}
  .card{flex:1;background:#141416;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:20px 22px}
  .lbl{font-size:15px;text-transform:uppercase;letter-spacing:.12em;color:#ff6a3d;font-weight:600}
  .t{font-size:22px;font-weight:600;margin-top:8px;letter-spacing:-.01em}
  .m{font-size:17px;color:#7c7c85;margin-top:6px}
</style></head><body>
  <div class="brand"><span class="dot"></span>Synapse</div>
  <h1>Think out loud. <em>Synapse files it.</em></h1>
  <div class="ramble">“…the null pointer in cart service, probably the discount code. Oh, and email the team the launch moves to Friday. Remind me to call the landlord tomorrow at 6.”</div>
  <div class="cards">${card("GitHub issue", "Null pointer in cart-service", "ready to file")}${card("Email draft", "The launch moves to Friday", "to the team")}${card("Reminder", "Call the landlord", "tomorrow, 6:00 pm")}</div>
</body></html>`;

const browser = await launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(html);
  await page.screenshot({ path: out, type: "png" });
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
}
