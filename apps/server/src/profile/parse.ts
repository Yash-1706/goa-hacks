/* ============================================================================
 * "Paste anything" (V1 phase 3b): a team list, a CSV export, vCards, or a copied member list → { name, email?, phone? }.
 * vCard and CSV are parsed directly; loose text by pattern ("Name <email>", "Name - email - phone", a bare address).
 * The caller shows the result for confirmation before anything is saved. Free text this cannot read goes to the model
 * (when one is configured), see ProfileService.parse.
 * ========================================================================== */

export interface ParsedContact {
  name: string;
  email?: string;
  phone?: string;
}

const EMAIL = /[^\s<>,;:"'()]+@[^\s<>,;:"'()]+\.[a-z]{2,}/i;
const PHONE = /\+?\d[\d\s().-]{6,}\d/;

const clean = (s: string): string => s.replace(/^["'\s]+|["'\s,;]+$/g, "").replace(/\s+/g, " ").trim();

function nameFromEmail(email: string): string {
  const local = email.split("@")[0]!.split("+")[0]!;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

function contact(name: string, email?: string, phone?: string): ParsedContact | null {
  const n = clean(name) || (email ? nameFromEmail(email) : "");
  if (!n || (!email && !phone)) return null;
  return { name: n.slice(0, 80), ...(email ? { email: email.toLowerCase() } : {}), ...(phone ? { phone: clean(phone) } : {}) };
}

function parseVcards(text: string): ParsedContact[] {
  const out: ParsedContact[] = [];
  for (const card of text.split(/BEGIN:VCARD/i).slice(1)) {
    const lines = card.replace(/\r?\n[ \t]/g, "").split(/\r?\n/); // unfold folded lines
    const field = (key: string): string | undefined => lines.find((l) => new RegExp(`^${key}[;:]`, "i").test(l))?.replace(/^[^:]*:/, "").trim();
    let name = field("FN");
    if (!name) {
      const n = field("N")?.split(";");
      name = n ? [n[1], n[0]].filter(Boolean).join(" ") : "";
    }
    const c = contact(name ?? "", field("EMAIL"), field("TEL"));
    if (c) out.push(c);
  }
  return out;
}

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i] as string;
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = !quoted;
      } else if ((ch === "," || ch === "\t" || ch === ";") && !quoted) {
        cells.push(cur);
        cur = "";
      } else cur += ch;
    }
    cells.push(cur);
    rows.push(cells.map((c) => c.trim()));
  }
  return rows;
}

function parseCsv(text: string): ParsedContact[] | null {
  const rows = csvRows(text);
  const head = rows[0]?.map((h) => h.toLowerCase()) ?? [];
  const col = (re: RegExp): number => head.findIndex((h) => re.test(h));
  const iName = col(/^(full ?)?name$|^display name$/);
  const iEmail = col(/e-?mail/);
  if (iName < 0 || iEmail < 0) return null;
  const iPhone = col(/phone|mobile|tel/);
  return rows
    .slice(1)
    .map((r) => contact(r[iName] ?? "", r[iEmail] || undefined, iPhone >= 0 ? r[iPhone] || undefined : undefined))
    .filter((c): c is ParsedContact => c !== null);
}

function parseLoose(text: string): ParsedContact[] {
  const out: ParsedContact[] = [];
  // "Name <email>" anywhere, several per line
  const angled = [...text.matchAll(/([^<>,;\n]*?)\s*<([^<>\s]+@[^<>\s]+)>/g)];
  if (angled.length) {
    for (const m of angled) {
      const c = contact(m[1] ?? "", m[2]);
      if (c) out.push(c);
    }
    text = text.replace(/([^<>,;\n]*?)\s*<([^<>\s]+@[^<>\s]+)>[,;]?/g, "");
  }
  for (const line of text.split(/\r?\n/)) {
    const email = line.match(EMAIL)?.[0];
    const phone = line.replace(email ?? "", " ").match(PHONE)?.[0];
    if (!email && !phone) continue;
    const name = line.replace(email ?? "", " ").replace(phone ?? "", " ").replace(/[-–—|:]+/g, " ");
    const c = contact(name, email, phone);
    if (c) out.push(c);
  }
  return out;
}

export function parseContacts(text: string): ParsedContact[] {
  const t = text.trim();
  if (!t) return [];
  const list = /BEGIN:VCARD/i.test(t) ? parseVcards(t) : (parseCsv(t) ?? parseLoose(t));
  const seen = new Set<string>();
  return list.filter((c) => {
    const key = (c.email ?? c.phone ?? c.name).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
