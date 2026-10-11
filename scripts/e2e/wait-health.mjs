// Wait until <base>/api/health answers 200 (a fresh quick tunnel answers 530 for a few seconds). usage: node wait-health.mjs <base> [seconds]
const [base, secs = "60"] = process.argv.slice(2);
const t0 = Date.now();
let last = "";
while (Date.now() - t0 < Number(secs) * 1000) {
  try {
    const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) });
    last = `HTTP ${r.status}`;
    if (r.ok) {
      console.log(`healthy after ${Math.round((Date.now() - t0) / 1000)} s`);
      process.exit(0);
    }
  } catch (e) {
    last = e.cause?.code ?? e.message;
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.error(`not healthy after ${secs} s (last: ${last})`);
process.exitCode = 1;
