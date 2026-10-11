// V1.1 Phase 5: ten spoken rambles (macOS `say`, Indian English + Hinglish voices) uploaded like the phone does, over the
// public URL, against REAL Sarvam + Groq on a throwaway data dir. Logs transcript, cards, source, Groq calls and timing per
// ramble, and checks each against what a person would expect. Budget guard: stops before the run's Groq/Sarvam caps.
// usage: SYNAPSE_PASSCODE=... node scripts/e2e/live-rambles.mjs <base-url> <out.json> [only-ids,comma-separated]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { login, waitFor } from "./lib.mjs";

const [base, outFile, only] = process.argv.slice(2);
const TZ = "Asia/Kolkata";
const MAX_GROQ = Number(process.env.MAX_GROQ ?? 140);
const MAX_SARVAM = Number(process.env.MAX_SARVAM ?? 38);
/** Sarvam calls already spent earlier in this run (each ramble is < 30 s: one Sarvam call per upload) */
let sarvamUsed = Number(process.env.SARVAM_USED ?? 0);

/** the day a phrase like "tomorrow" means, as YYYY-MM-DD in the profile's time zone */
const day = (offset) => new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(Date.now() + offset * 86_400_000);
const nextWeekday = (target) => {
  // 0 = Sunday … 6 = Saturday; strictly after today
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  const delta = ((target - now.getDay() + 7) % 7) || 7;
  return day(delta);
};
const at = (d, hhmm) => `${d}T${hhmm}`;

// expect: one entry per card, in any order: { kind, title?: RegExp, due?: "YYYY-MM-DDTHH:MM" (local), to?: RegExp }
export const RAMBLES = [
  {
    id: "R1-demo", voice: "Rishi",
    text: "That bug from yesterday... the null pointer in cart service, probably the discount code. Oh, and email the team that the launch moves to Friday. Remind me to call the landlord tomorrow at 6. Wait, was that my phone?",
    expect: [{ kind: "github_issue", title: /null|cart/i }, { kind: "email_draft", title: /launch|friday/i }, { kind: "reminder", title: /landlord/i, due: at(day(1), "18:00") }],
  },
  {
    id: "R2-comma", voice: "Tara",
    text: "Email Sarah that the design review moved to Thursday, and also remind me to renew my passport on Monday at 9 in the morning.",
    expect: [{ kind: "email_draft", title: /design review|thursday/i, to: /sarah/i }, { kind: "reminder", title: /passport/i, due: [at(nextWeekday(1), "09:00"), at(day(0), "09:00")] /* said on a Monday: today or next */ }],
  },
  {
    id: "R3-correction", voice: "Aman",
    text: "Remind me to submit the expense report on Friday at 5 pm. No wait, make it Thursday at 5 pm.",
    expect: [{ kind: "reminder", title: /expense/i, due: at(nextWeekday(4), "17:00") }],
  },
  {
    id: "R4-hinglish", voice: "Lekha",
    text: "कल सुबह दस बजे Dev को call करना है, remind me. और एक idea है, checkout page पर guest login add करना चाहिए.",
    expect: [{ kind: "reminder", title: /dev/i, due: at(day(1), "10:00") }, { kind: "note", title: /guest|checkout/i }],
  },
  {
    id: "R5-two-asides", voice: "Rishi",
    text: "Okay so the login API returns a 500 error when the email has a plus sign, I need an issue for that. Hey, can you pass the water? Also, we decided to go with Postgres over Mongo for the analytics service. Sorry, one second, what time is the cab?",
    expect: [{ kind: "github_issue", title: /login|plus|500/i }, { kind: "decision", title: /postgres/i }],
  },
  {
    id: "R6-message-event", voice: "Tara",
    text: "Message Dev that the deploy is done. Then set up a meeting with Sarah next Tuesday at 3 pm about the roadmap.",
    expect: [{ kind: "message_draft", title: /deploy/i }, { kind: "calendar_event", title: /roadmap|sarah/i, due: [at(nextWeekday(2), "15:00"), at(day(Number(nextWeekday(2).slice(8)) - Number(day(0).slice(8)) + 7), "15:00")] /* "next Tuesday" is ambiguous */ }],
  },
  {
    id: "R7-idea", voice: "Aman",
    text: "Idea for later: we could cache the product images on a CDN with a one day expiry, that should cut the page load time in half.",
    expect: [{ kind: "note", title: /cdn|cache|image/i }],
  },
  {
    id: "R8-retract", voice: "Rishi",
    text: "Remind me to buy milk tonight at 8. Actually forget the milk, remind me to buy bread instead.",
    expect: [{ kind: "reminder", title: /bread/i, due: at(day(0), "20:00") }],
  },
  {
    id: "R9-three-comma", voice: "Tara",
    text: "The search page is really slow on mobile, file a bug for that, oh and also email Dev to check the CDN logs, plus remind me to follow up on Wednesday at 11 am.",
    expect: [{ kind: "github_issue", title: /search|slow/i }, { kind: "email_draft", title: /cdn|logs/i, to: /dev/i }, { kind: "reminder", title: /follow/i, due: at(nextWeekday(3), "11:00") }],
  },
  {
    id: "R10-short", voice: "Aman",
    text: "Remind me to call mom at 9 tonight.",
    expect: [{ kind: "reminder", title: /mom/i, due: at(day(0), "21:00") }],
  },
];

const localDue = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
};

function synth(r, dir) {
  const aiff = path.join(dir, `${r.id}.aiff`);
  const wav = path.join(dir, `${r.id}.wav`);
  execFileSync("say", ["-v", r.voice, "-o", aiff, r.text]);
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
  return wav;
}

/** match each expected card to one actual card (greedy, kind first) */
function judge(expect, cards) {
  const left = [...cards];
  const misses = [];
  for (const e of expect) {
    const i = left.findIndex((c) => c.kind === e.kind && (!e.title || e.title.test(c.title)) && (!e.due || [e.due].flat().includes(c.due)) && (!e.to || e.to.test(c.to ?? "")));
    if (i >= 0) left.splice(i, 1);
    else {
      const sameKind = cards.find((c) => c.kind === e.kind);
      misses.push(`${e.kind}${e.due ? ` @${[e.due].flat().join("|")}` : ""}${sameKind ? ` (got "${sameKind.title}"${sameKind.due ? ` @${sameKind.due}` : ""}${sameKind.to ? ` to ${sameKind.to}` : ""})` : " (missing)"}`);
    }
  }
  return { ok: misses.length === 0 && left.length === 0, misses, extra: left.map((c) => `${c.kind}: ${c.title}`) };
}

const passcode = process.env.SYNAPSE_PASSCODE;
const cookie = await login(base, passcode);
const origin = new URL(base).origin;
const api = async (p, init = {}) => {
  const r = await fetch(base + p, { ...init, headers: { cookie, origin, ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  return r.json();
};
const health = () => api("/api/health");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-rambles-"));
const results = [];
const todo = only ? RAMBLES.filter((r) => only.split(",").includes(r.id)) : RAMBLES;
try {
  for (const r of todo) {
    const h0 = await health();
    const groq0 = h0.groq?.requestsToday ?? 0;
    const groqUsed = Number(process.env.GROQ_USED ?? 0) + groq0;
    if (groqUsed + 3 > MAX_GROQ || sarvamUsed + 1 > MAX_SARVAM) {
      results.push({ id: r.id, skipped: `budget: groq ${groqUsed}/${MAX_GROQ}, sarvam ${sarvamUsed}/${MAX_SARVAM}` });
      break;
    }
    const wav = synth(r, dir);
    const form = new FormData();
    form.append("audio", new Blob([fs.readFileSync(wav)], { type: "audio/wav" }), "capture.wav");
    form.append("clientId", `live-${r.id}-${Date.now().toString(36)}`);
    form.append("capturedAt", String(Date.now()));
    form.append("context", JSON.stringify({ source: "android" }));
    const t0 = Date.now();
    const res = await fetch(base + "/api/capture", { method: "POST", body: form, headers: { cookie, origin } });
    sarvamUsed += 1;
    if (!res.ok) {
      results.push({ id: r.id, error: `upload HTTP ${res.status}` });
      continue;
    }
    const cap = await res.json();
    const tUpload = Date.now() - t0;
    let ids = cap.thoughtIds ?? [];
    if (cap.pending || !ids.length) {
      await waitFor(async () => {
        const list = await api("/api/captures?limit=10");
        const c = list.find((x) => x.captureId === cap.captureId);
        ids = c?.thoughtIds ?? ids;
        return ids.length > 0;
      }, { timeoutMs: 60_000, what: "capture done" }).catch(() => undefined);
    }
    // settled: every card final, nothing analyzing or improving
    let views = [];
    await waitFor(async () => {
      views = await Promise.all(ids.map((id) => api(`/api/thoughts/${id}`)));
      return views.every((v) => v.status === "final" && !v.analyzing && !v.improving && !v.provisional);
    }, { timeoutMs: 90_000, what: "cards settled" }).catch(() => undefined);
    const tCards = Date.now() - t0;
    const h1 = await health();
    const cards = views
      .filter((v) => !v.retracted && v.artifact)
      .map((v) => {
        const a = v.artifact;
        const due = a.route?.dueAt ?? a.payload?.due_iso ?? a.payload?.start_iso ?? null;
        const to = a.route?.to?.join(", ") ?? (Array.isArray(a.payload?.to) ? a.payload.to.join(", ") : a.payload?.to) ?? null;
        return { code: v.code, kind: a.kind, title: v.title, category: v.category, source: v.source, degraded: v.degraded ?? null, due: localDue(due), ...(to ? { to } : {}), needs: (a.needs ?? []).map((n) => n.field) };
      });
    const verdict = judge(r.expect, cards);
    results.push({
      id: r.id,
      voice: r.voice,
      said: r.text,
      transcript: cap.transcript,
      cards,
      ...verdict,
      groqCalls: (h1.groq?.requestsToday ?? 0) - groq0,
      uploadMs: tUpload,
      cardsMs: tCards,
    });
    const last = results.at(-1);
    console.error(`${last.ok ? "✓" : "✗"} ${r.id}: ${cards.length} cards, groq ${last.groqCalls}, ${(tCards / 1000).toFixed(1)} s${last.misses.length ? ` · missed ${last.misses.join("; ")}` : ""}${last.extra.length ? ` · extra ${last.extra.join("; ")}` : ""}`);
    await new Promise((res2) => setTimeout(res2, Number(process.env.GAP_MS ?? 1500))); // GAP_MS: real use is minutes apart
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true }); // the synthetic audio never outlives the run
}
const done = results.filter((r) => r.cards);
const times = done.map((r) => r.cardsMs).sort((a, b) => a - b);
const summary = {
  fullyRight: `${done.filter((r) => r.ok).length}/${done.length}`,
  medianCardsS: times.length ? +(times[Math.floor((times.length - 1) / 2)] / 1000).toFixed(1) : null,
  maxGroqPerCapture: Math.max(0, ...done.map((r) => r.groqCalls)),
  groqTotal: done.reduce((n, r) => n + r.groqCalls, 0),
  sarvamUsedAfter: sarvamUsed,
  health: (await health()).groq,
};
fs.writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), summary, results }, null, 2));
console.log(JSON.stringify(summary));
