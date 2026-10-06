import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A faithful stand-in for POST /v1/messages (streaming). It speaks the real SSE event sequence
 * (message_start → content_block_start → text deltas → content_block_stop → message_delta →
 * message_stop) so the real @anthropic-ai/sdk parses it. Used to test ClaudeCortex without a key.
 */
export type FakeMode =
  | { kind: "ok"; json: unknown; cacheRead?: number; chunkChars?: number; chunkDelayMs?: number; stopReason?: string }
  | { kind: "status"; status: number; type: string; message: string }
  | { kind: "slow"; delayMs: number }
  | { kind: "garbage"; text: string };

export interface FakeServer {
  url: string;
  requests: Array<{ body: Record<string, unknown>; headers: http.IncomingHttpHeaders }>;
  /** responses are consumed in order; the last one repeats */
  script: FakeMode[];
  /** replace the script and clear recorded requests */
  reset(...script: FakeMode[]): void;
  close(): Promise<void>;
}

export async function startFakeAnthropic(initial: FakeMode[] = []): Promise<FakeServer> {
  let n = 0;
  const state: FakeServer = {
    url: "",
    requests: [],
    script: initial,
    reset(...script) {
      state.script = script;
      state.requests.length = 0;
      n = 0;
    },
    close: async () => {},
  };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      /* ignore */
    }
    state.requests.push({ body, headers: req.headers });
    const mode = state.script[Math.min(n++, state.script.length - 1)] ?? { kind: "garbage", text: "" };

    if (mode.kind === "status") {
      res.writeHead(mode.status, { "content-type": "application/json", "request-id": "req_fake" });
      res.end(JSON.stringify({ type: "error", error: { type: mode.type, message: mode.message } }));
      return;
    }
    if (mode.kind === "slow") {
      await new Promise((r) => setTimeout(r, mode.delayMs));
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "request-id": "req_fake" });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const text = mode.kind === "ok" ? JSON.stringify(mode.json) : mode.kind === "garbage" ? mode.text : "{}";
    const cacheRead = mode.kind === "ok" ? (mode.cacheRead ?? 0) : 0;
    send("message_start", {
      type: "message_start",
      message: {
        id: "msg_fake", type: "message", role: "assistant", model: String(body.model ?? "fake"), content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 40, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead },
      },
    });
    send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    const size = mode.kind === "ok" ? (mode.chunkChars ?? 24) : 24;
    const delay = mode.kind === "ok" ? (mode.chunkDelayMs ?? 12) : 5;
    for (let i = 0; i < text.length; i += size) {
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(i, i + size) } });
      if (delay) await new Promise((r) => setTimeout(r, delay));
    }
    send("content_block_stop", { type: "content_block_stop", index: 0 });
    send("message_delta", { type: "message_delta", delta: { stop_reason: (mode.kind === "ok" && mode.stopReason) || "end_turn", stop_sequence: null }, usage: { output_tokens: Math.ceil(text.length / 4) } });
    send("message_stop", { type: "message_stop" });
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise((r) => server.close(() => r()));
  return state;
}
