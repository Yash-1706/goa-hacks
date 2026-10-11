import type { CaptureResponse, CaptureSource } from "@synapse/shared";
import type { UploadOutcome, UploadRequest } from "./queue";

/* POST /api/capture from this device (same origin: the session cookie rides along). The answer decides what the queue does. */

export function captureSource(userAgent: string): CaptureSource {
  if (/Android/i.test(userAgent)) return "android";
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios";
  return "web";
}

async function errorText(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: unknown };
    if (typeof j.error === "string") return j.error;
  } catch {
    /* not JSON (a proxy's error page) */
  }
  return `HTTP ${res.status}`;
}

export async function uploadCapture(req: UploadRequest, o: { fetch?: typeof fetch; source: CaptureSource }): Promise<UploadOutcome> {
  const form = new FormData();
  if (req.audio) form.append("audio", new Blob([req.audio as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), "capture.wav");
  if (req.text !== undefined) form.append("text", req.text);
  form.append("clientId", req.clientId);
  form.append("capturedAt", String(req.capturedAt));
  form.append("context", JSON.stringify({ source: o.source }));
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)("/api/capture", { method: "POST", body: form, credentials: "same-origin" });
  } catch {
    return { kind: "retry", error: "network" };
  }
  if (res.ok) return { kind: "ok", result: (await res.json()) as CaptureResponse };
  if (res.status === 401) return { kind: "auth" };
  if (res.status === 400 || res.status === 413 || res.status === 415 || res.status === 422) return { kind: "reject", error: await errorText(res) };
  return { kind: "retry", error: await errorText(res) };
}
