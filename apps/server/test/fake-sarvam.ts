import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A faithful stand-in for Sarvam's POST /speech-to-text (https://docs.sarvam.ai/api-reference/speech-to-text/transcribe):
 *  - multipart/form-data with `file` (required), `model`, `language_code`, `keyterms` (a JSON array in one field);
 *  - the key travels in the `api-subscription-key` header; a wrong or missing one is a 403 `invalid_api_key_error`;
 *  - 200 → { request_id, transcript, language_code }, errors → { error: { request_id, message, code } };
 *  - the audio is checked as a WAV and its format and length are recorded, so a test can say what was really sent.
 * Used to test SarvamStt and the app's Sarvam mode without a key (and without sending anything anywhere).
 */
export type SarvamMode =
  | { kind: "ok"; transcript: string; language_code?: string }
  | { kind: "status"; status: number; code: string; message?: string }
  | { kind: "garbage"; text: string }
  | { kind: "slow"; delayMs: number; transcript: string };

export interface SarvamRequest {
  key: string | undefined;
  fields: Record<string, string>;
  /** the uploaded file */
  wav: { filename?: string; bytes: number; rate: number; channels: number; bits: number; samples: number; first: number[] } | null;
}

export interface FakeSarvam {
  url: string;
  requests: SarvamRequest[];
  script: SarvamMode[];
  reset(...script: SarvamMode[]): void;
  close(): Promise<void>;
}

function parseMultipart(body: Buffer, boundary: string): Record<string, { filename?: string; data: Buffer }> {
  const out: Record<string, { filename?: string; data: Buffer }> = {};
  const delim = Buffer.from(`--${boundary}`);
  let pos = body.indexOf(delim);
  while (pos !== -1) {
    const start = pos + delim.length;
    if (body.subarray(start, start + 2).toString() === "--") break;
    const next = body.indexOf(delim, start);
    if (next === -1) break;
    const part = body.subarray(start + 2, next - 2);
    const headEnd = part.indexOf("\r\n\r\n");
    const head = part.subarray(0, headEnd).toString("utf8");
    const name = /name="([^"]+)"/.exec(head)?.[1];
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    if (name) out[name] = { ...(filename !== undefined ? { filename } : {}), data: part.subarray(headEnd + 4) };
    pos = next;
  }
  return out;
}

function inspectWav(buf: Buffer, filename?: string): SarvamRequest["wav"] {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  const samples = buf.readUInt32LE(40) / 2;
  const first = Array.from({ length: Math.min(4, samples) }, (_, i) => buf.readInt16LE(44 + i * 2));
  return { ...(filename !== undefined ? { filename } : {}), bytes: buf.length, rate: buf.readUInt32LE(24), channels: buf.readUInt16LE(22), bits: buf.readUInt16LE(34), samples, first };
}

export async function startFakeSarvam(o: { key?: string; initial?: SarvamMode[] } = {}): Promise<FakeSarvam> {
  const KEY = o.key ?? "sk\u005ftest_sarvam_key_not_real";
  const state = { requests: [] as SarvamRequest[], script: o.initial ?? [{ kind: "ok", transcript: "hello from the fake sarvam", language_code: "en-IN" } as SarvamMode] };
  let n = 0;
  const json = (res: http.ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/speech-to-text") return json(res, 404, { error: { request_id: "r", message: "not found", code: "not_found_error" } });
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const key = req.headers["api-subscription-key"];
      const ctype = String(req.headers["content-type"] ?? "");
      const boundary = /boundary=(.+)$/.exec(ctype)?.[1];
      const parts = boundary ? parseMultipart(Buffer.concat(chunks), boundary.replace(/^"|"$/g, "")) : {};
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(parts)) if (k !== "file") fields[k] = v.data.toString("utf8");
      state.requests.push({ key: typeof key === "string" ? key : undefined, fields, wav: parts.file ? inspectWav(parts.file.data, parts.file.filename) : null });
      if (key !== KEY) return json(res, 403, { error: { request_id: "r1", message: "Invalid API key", code: "invalid_api_key_error" } });
      if (!ctype.startsWith("multipart/form-data") || !parts.file) return json(res, 422, { error: { request_id: "r2", message: "file is required", code: "unprocessable_entity_error" } });
      const mode = state.script[Math.min(n++, state.script.length - 1)] as SarvamMode;
      if (mode.kind === "status") return json(res, mode.status, { error: { request_id: "r3", message: mode.message ?? "error", code: mode.code } });
      if (mode.kind === "garbage") {
        res.writeHead(200, { "content-type": "text/plain" });
        return void res.end(mode.text);
      }
      const reply = (): void => json(res, 200, { request_id: `req-${n}`, transcript: mode.kind === "ok" || mode.kind === "slow" ? mode.transcript : "", language_code: mode.kind === "ok" ? (mode.language_code ?? "en-IN") : "en-IN" });
      if (mode.kind === "slow") setTimeout(reply, mode.delayMs);
      else reply();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests: state.requests,
    get script() {
      return state.script;
    },
    reset(...script: SarvamMode[]) {
      state.requests.length = 0;
      n = 0;
      if (script.length) state.script = script;
    },
    close: () => new Promise((r) => (server.close(() => r()), server.closeAllConnections?.())),
  } as FakeSarvam;
}
