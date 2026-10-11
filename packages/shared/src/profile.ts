import { z } from "zod";

/* ============================================================================
 * The user's context profile (V1): who they are, their repos and their people. It routes cards without asking (which repo,
 * whose email address) and fills in from imports and from answered questions. Stored encrypted on the server.
 * ========================================================================== */

export const ProfileRepoSchema = z.object({
  fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/).max(140),
  aliases: z.array(z.string().max(60)).max(20),
  isDefault: z.boolean(),
  description: z.string().max(400).optional(),
  topics: z.array(z.string().max(60)).max(20).optional(),
});
export type ProfileRepo = z.infer<typeof ProfileRepoSchema>;

export const ProfilePersonSchema = z.object({
  name: z.string().min(1).max(80),
  aliases: z.array(z.string().max(60)).max(20),
  email: z.string().max(200).optional(),
  phone: z.string().max(40).optional(),
  githubLogin: z.string().max(60).optional(),
  preferredChannel: z.enum(["email", "whatsapp"]).optional(),
});
export type ProfilePerson = z.infer<typeof ProfilePersonSchema>;

export const LEARNED_KINDS = ["repo_alias", "person_alias", "person_email", "group_emails"] as const;
export const LearnedFactSchema = z.object({
  kind: z.enum(LEARNED_KINDS),
  /** what was asked about, lowercased ("cart service", "dev", "the team") */
  key: z.string().max(120),
  /** the answer ("acme/shop", "dev@acme.io", "a@x.io,b@y.io") */
  value: z.string().max(1000),
  at: z.number(),
});
export type LearnedFact = z.infer<typeof LearnedFactSchema>;

export const ProfileSchema = z.object({
  name: z.string().max(80),
  timezone: z.string().max(64),
  repos: z.array(ProfileRepoSchema).max(100),
  people: z.array(ProfilePersonSchema).max(500),
  learned: z.array(LearnedFactSchema).max(2000),
  /** desktop email handoff: Gmail in the browser, or the default mail app (mailto:) */
  emailApp: z.enum(["gmail", "mailto"]).default("gmail"),
  /** first-run setup was finished or skipped */
  onboarded: z.boolean().default(false),
});
export type Profile = z.infer<typeof ProfileSchema>;

/** What the GitHub import suggests (the user unticks what they do not want). */
export interface ImportSuggestions {
  login: string;
  repos: Array<ProfileRepo & { pushedAt: string | null; selected: boolean }>;
  people: Array<ProfilePerson & { commits: number; selected: boolean }>;
}

export interface GithubStatus {
  /** where the token comes from: saved in Synapse, GITHUB_TOKEN in .env, or the gh CLI on this Mac (not saved yet) */
  source: "saved" | "env" | "gh" | null;
  login: string | null;
  /** a token exists but GitHub refused it */
  error?: string;
}
