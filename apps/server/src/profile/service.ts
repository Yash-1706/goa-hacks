import { z } from "zod";
import { ProfileSchema, type LearnedFact, type Profile, type ProfilePerson, type ProfileRepo } from "@synapse/shared";
import type { Config, TeamMember } from "../config";
import type { DeepLlm } from "../llm/deep";
import { log } from "../log";
import type { Db } from "../memory/db";
import type { Vault } from "../memory/crypto";
import { parseContacts, type ParsedContact } from "./parse";

/* ============================================================================
 * The context profile (V1 phase 3a): name, timezone, repos, people and everything learned from answered questions.
 * Sealed with the long-term key in one settings row. USER_TEAM, TIMEZONE, USER_FIRST_NAME and GITHUB_SANDBOX_REPO (or
 * GITHUB_REPO) only seed it the first time; after that the profile is the source the resolver and the cortex read people from.
 * ========================================================================== */

const SETTING = "profile_enc";
const AAD = "settings|profile";
const MAX_LEARNED = 2000;

export class ProfileService {
  private cache: Profile | null = null;
  /** called after every change (the app re-pins people as entities, re-renders cards) */
  onChange: (p: Profile) => void = () => undefined;

  constructor(
    private d: { db: Db; vault: Vault; cfg: Config; deep?: DeepLlm },
  ) {}

  /** the model for "paste anything" free text (created after the profile, which the engine needs first) */
  attachLlm(deep: DeepLlm): void {
    this.d.deep = deep;
  }

  get(): Profile {
    if (this.cache) return this.cache;
    const raw = this.d.db.getSetting(SETTING);
    if (raw) {
      try {
        this.cache = ProfileSchema.parse(this.d.vault.openJson("ltm", AAD, Buffer.from(raw, "base64")));
        return this.cache;
      } catch (err) {
        log.warn("profile", "stored profile unreadable: starting from the seed", { error: (err as Error).name });
      }
    }
    this.cache = this.seed();
    return this.cache;
  }

  /** Back to the seed from .env (wipe-all). */
  reset(): void {
    this.save(this.seed());
  }

  /** Replace the profile (validated). Exactly one default repo is kept when any repo is marked default. */
  put(next: Profile): Profile {
    const p = ProfileSchema.parse(next);
    const defaults = p.repos.filter((r) => r.isDefault);
    if (defaults.length > 1) p.repos = p.repos.map((r) => ({ ...r, isDefault: r === defaults[0] }));
    this.save(p);
    return p;
  }

  /** Remember answers; the newest fact per (kind, key) wins. */
  learn(facts: LearnedFact[]): void {
    if (!facts.length) return;
    const p = this.get();
    const keyOf = (f: LearnedFact) => `${f.kind}|${f.key}`;
    const fresh = new Set(facts.map(keyOf));
    const learned = [...p.learned.filter((f) => !fresh.has(keyOf(f))), ...facts].slice(-MAX_LEARNED);
    // an answered address also fills in the person it belongs to
    const people = p.people.map((person) => {
      if (person.email) return person;
      const hit = facts.find((f) => f.kind === "person_email" && [person.name.toLowerCase(), person.name.split(/\s+/)[0]!.toLowerCase(), ...person.aliases].includes(f.key));
      return hit ? { ...person, email: hit.value.split(",")[0] } : person;
    });
    this.save({ ...p, learned, people });
  }

  /** Merge imported repos and people (by repo name / email or name); the import's default replaces the old one. */
  merge(o: { repos?: ProfileRepo[]; people?: ProfilePerson[] }): Profile {
    const p = this.get();
    let repos = p.repos;
    if (o.repos?.length) {
      const incoming = new Map(o.repos.map((r) => [r.fullName.toLowerCase(), r]));
      const hasDefault = o.repos.some((r) => r.isDefault);
      repos = [
        ...p.repos.filter((r) => !incoming.has(r.fullName.toLowerCase())).map((r) => (hasDefault ? { ...r, isDefault: false } : r)),
        ...o.repos,
      ];
    }
    let people = p.people;
    if (o.people?.length) {
      const key = (x: ProfilePerson) => (x.email ?? x.name).toLowerCase();
      const byKey = new Map(p.people.map((x) => [key(x), x]));
      for (const x of o.people) {
        const sameName = !x.email ? undefined : p.people.find((y) => !y.email && y.name.toLowerCase() === x.name.toLowerCase());
        if (sameName) byKey.delete(key(sameName));
        const old = byKey.get(key(x)) ?? sameName;
        byKey.set(key(x), { ...old, ...x, aliases: [...new Set([...(old?.aliases ?? []), ...x.aliases])] });
      }
      people = [...byKey.values()];
    }
    return this.put({ ...p, repos, people });
  }

  /** People for the cortex and the resolver (name + role, like USER_TEAM was). */
  team(): TeamMember[] {
    return this.get().people.map((x) => ({ name: x.name.split(/\s+/)[0] as string, role: "" }));
  }

  /** "Paste anything": parsed directly, or by the configured model when the text is not a list it can read. */
  async parse(text: string): Promise<ParsedContact[]> {
    const direct = parseContacts(text);
    if (direct.length || !this.d.deep || text.trim().length < 8) return direct;
    const Out = z.object({ people: z.array(z.object({ name: z.string(), email: z.string().nullable(), phone: z.string().nullable() })) });
    const res = await this.d.deep
      .json({
        system: "Extract the people in the user's text. Return {\"people\":[{\"name\",\"email\"|null,\"phone\"|null}]}. Only people actually named; never invent an address.",
        user: text.slice(0, 6000),
        schema: Out,
        maxTokens: 800,
      })
      .catch(() => null);
    return (res?.people ?? []).filter((x) => x.name.trim()).map((x) => ({ name: x.name.trim(), ...(x.email ? { email: x.email } : {}), ...(x.phone ? { phone: x.phone } : {}) }));
  }

  private save(p: Profile): void {
    this.d.db.setSetting(SETTING, this.d.vault.sealJson("ltm", AAD, p).toString("base64"));
    this.cache = p;
    this.onChange(p);
  }

  private seed(): Profile {
    const { cfg } = this.d;
    const sandbox = [cfg.integrations.github.sandboxRepo, cfg.integrations.github.repo].find((r) => /^[\w.-]+\/[\w.-]+$/.test(r)) ?? "";
    return {
      name: cfg.user.firstName,
      timezone: cfg.timezone,
      repos: sandbox ? [{ fullName: sandbox, aliases: [sandbox.split("/")[1]!.toLowerCase().split(/[-_.]+/).join(" ")], isDefault: true }] : [],
      people: cfg.user.team.map((m) => ({ name: m.name, aliases: [] })),
      learned: [],
      emailApp: "gmail",
      onboarded: false,
    };
  }
}
