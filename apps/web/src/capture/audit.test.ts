import { describe, expect, it } from "vitest";
import shareTarget from "../../public/share-target.js?raw";

/**
 * Code audit for the phone app's capture path (V1): audio leaves the phone only as a POST to this server's /api/capture, and
 * touches browser storage only inside the queue, which seals it first (queue.test.ts proves the ciphertext). The share
 * target keeps shared files in service-worker memory only.
 */

const sources = import.meta.glob("./*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const strip = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/\s.*$/, ""))
    .join("\n");
const prod = Object.entries(sources)
  .filter(([n]) => !n.endsWith(".test.ts"))
  .map(([n, s]) => [n.replace("./", ""), strip(s)] as const);

describe("capture path audit", () => {
  it("scans the real modules", () => {
    expect(prod.map(([n]) => n)).toEqual(expect.arrayContaining(["queue.ts", "upload.ts", "recorder.ts", "wav.ts", "runtime.ts", "share.ts"]));
  });

  it("only the queue touches IndexedDB, nothing uses other storage or object URLs", () => {
    for (const [name, src] of prod) {
      expect(src, name).not.toMatch(/\b(localStorage|sessionStorage|caches\.(open|put)|CacheStorage|showSaveFilePicker|FileSystemFileHandle|URL\.createObjectURL)\b/);
      if (name !== "queue.ts" && name !== "runtime.ts") expect(src, name).not.toMatch(/\bindexedDB\b/);
    }
    expect(prod.find(([n]) => n === "queue.ts")?.[1]).toMatch(/crypto\.subtle\.encrypt/);
  });

  it("audio is sent only by upload.ts, only to this server's /api/capture", () => {
    for (const [name, src] of prod) {
      if (name === "upload.ts" || name === "runtime.ts") continue;
      expect(src, `${name} must not open its own connection`).not.toMatch(/\bfetch\s*\(|new\s+(WebSocket|XMLHttpRequest|EventSource)\b|sendBeacon/);
    }
    const upload = prod.find(([n]) => n === "upload.ts")![1];
    expect(upload).toMatch(/"\/api\/capture"/);
    expect(upload).not.toMatch(/https?:\/\//);
    expect(prod.find(([n]) => n === "runtime.ts")![1]).not.toMatch(/audio/i);
  });

  it("the share target holds shared files in memory only", () => {
    expect(strip(shareTarget)).not.toMatch(/\b(indexedDB|caches|localStorage|fetch\s*\()/);
  });
});
