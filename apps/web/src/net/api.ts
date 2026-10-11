import type { ArtifactView, CaptureResponse, GithubStatus, ImportSuggestions, Profile, ProfilePerson, ProfileRepo } from "@synapse/shared";
import { getDeviceId, getToken } from "./device";
import { tunnelHeaders } from "./tunnel";
import type {
  AuditResponse,
  AuditVerify,
  BatteryResponse,
  CalendarResponse,
  DictionaryResponse,
  GraphResponse,
  HealthResponse,
  LatencyResponse,
  LedgerResponse,
  OutboxItem,
  PairingResponse,
  SettingsResponse,
  ThoughtResponse,
} from "./api-types";

/* ============================================================================
 * REST client. Every call carries the device id + token headers so a paired phone is trusted exactly
 * like it is on the WebSocket (localhost needs neither).
 * ========================================================================== */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "x-synapse-device": getDeviceId(), ...tunnelHeaders() };
  const token = getToken();
  if (token) h["x-synapse-token"] = token;
  return h;
}

async function errorOf(res: Response): Promise<ApiError> {
  let msg = `${res.status} ${res.statusText}`;
  try {
    const j = (await res.clone().json()) as { error?: unknown; message?: unknown };
    if (typeof j.error === "string") msg = j.error;
    else if (typeof j.message === "string") msg = j.message;
  } catch {
    /* not JSON */
  }
  return new ApiError(msg, res.status);
}

async function request(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = { ...authHeaders() };
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload, signal });
  if (!res.ok) throw await errorOf(res);
  return res;
}

async function json<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  return (await request(path, method, body, signal)).json() as Promise<T>;
}

export const api = {
  health: (signal?: AbortSignal) => json<HealthResponse>("/api/health", "GET", undefined, signal),
  settings: (signal?: AbortSignal) => json<SettingsResponse>("/api/settings", "GET", undefined, signal),
  setAutonomy: (autonomyLevel: number) => json<{ ok: boolean; autonomyLevel: number; localOnly: boolean }>("/api/settings", "POST", { autonomyLevel }),
  graph: (signal?: AbortSignal) => json<GraphResponse>("/api/graph?includeWorking=1", "GET", undefined, signal),
  thought: (id: string, signal?: AbortSignal) => json<ThoughtResponse>(`/api/thoughts/${encodeURIComponent(id)}`, "GET", undefined, signal),
  outbox: (signal?: AbortSignal) => json<OutboxItem[]>("/api/outbox", "GET", undefined, signal),
  artifactAction: (id: string, action: "accept" | "dismiss" | "push" | "undo") => json<ArtifactView>(`/api/artifacts/${encodeURIComponent(id)}/${action}`, "POST"),
  patchArtifact: (id: string, patch: Record<string, unknown>) => json<ArtifactView>(`/api/artifacts/${encodeURIComponent(id)}`, "PATCH", patch),
  mailto: (id: string) => json<{ mailto: string }>(`/api/artifacts/${encodeURIComponent(id)}/export`),
  ics: async (id: string): Promise<Blob> => (await request(`/api/artifacts/${encodeURIComponent(id)}/export?format=ics`, "GET")).blob(),
  ledger: (signal?: AbortSignal) => json<LedgerResponse>("/api/privacy/ledger", "GET", undefined, signal),
  purge: (body: { ids?: string[]; all?: boolean; windowSecs?: number }) => json<{ count: number }>("/api/privacy/purge", "POST", body),
  setLocalOnly: (on: boolean) => json<{ localOnly: boolean }>("/api/privacy/local-only", "POST", { on }),
  exportAll: async (): Promise<Blob> => (await request("/api/privacy/export", "GET")).blob(),
  audit: (signal?: AbortSignal) => json<AuditResponse>("/api/privacy/audit", "GET", undefined, signal),
  verifyAudit: () => json<AuditVerify>("/api/privacy/audit/verify"),
  pairing: (signal?: AbortSignal) => json<PairingResponse>("/api/pairing", "GET", undefined, signal),
  revokePairings: () => json<{ ok: boolean }>("/api/privacy/pairing/rotate", "POST"),
  dictionary: (signal?: AbortSignal) => json<DictionaryResponse>("/api/dictionary", "GET", undefined, signal),
  latency: (signal?: AbortSignal) => json<LatencyResponse>("/api/metrics/latency", "GET", undefined, signal),
  battery: (signal?: AbortSignal) => json<BatteryResponse>("/api/metrics/battery", "GET", undefined, signal),
  calendar: (signal?: AbortSignal) => json<CalendarResponse>("/api/calendar", "GET", undefined, signal),
  // ---- V1: capture, ask-cards, handoffs, profile, GitHub
  capture: (text: string) => json<CaptureResponse>("/api/capture", "POST", { text, context: { source: "web" } }),
  answer: (id: string, field: string, value: string) => json<ArtifactView>(`/api/artifacts/${encodeURIComponent(id)}/answer`, "POST", { field, value }),
  done: (id: string) => json<ArtifactView>(`/api/artifacts/${encodeURIComponent(id)}/done`, "POST"),
  revokeAll: () => json<{ ok: boolean }>("/api/auth/revoke-all", "POST"),
  shipped: (id: string, via: string) => json<ArtifactView>(`/api/artifacts/${encodeURIComponent(id)}/shipped`, "POST", { via }),
  profile: (signal?: AbortSignal) => json<Profile>("/api/profile", "GET", undefined, signal),
  saveProfile: (p: Profile) => json<Profile>("/api/profile", "PUT", p),
  mergeProfile: (m: { repos?: ProfileRepo[]; people?: ProfilePerson[] }) => json<Profile>("/api/profile/merge", "POST", m),
  parseContacts: (text: string) => json<{ people: Array<{ name: string; email?: string; phone?: string }> }>("/api/profile/parse", "POST", { text }),
  githubStatus: (signal?: AbortSignal) => json<GithubStatus>("/api/github/status", "GET", undefined, signal),
  githubUseGh: () => json<{ login: string }>("/api/github/use-gh", "POST"),
  githubToken: (token: string) => json<{ login: string }>("/api/github/token", "POST", { token }),
  githubForget: () => json<{ ok: boolean }>("/api/github/token", "DELETE"),
  githubImport: () => json<ImportSuggestions>("/api/github/import"),
};

export type Api = typeof api;
