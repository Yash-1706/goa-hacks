import { describe, expect, it } from "vitest";

/**
 * Code audit as a test (PRD §8 "audio bytes persisted anywhere: 0", PRV-4): audio leaves the browser through exactly one
 * module (wispr.ts, to Wispr with the short-lived client token) and is never written to any browser storage.
 */

const sources = import.meta.glob("./*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** crude comment stripper: block comments, whole-line comments, trailing " // ..." that is not part of a URL */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/\s.*$/, ""))
    .join("\n");
}

const prod = Object.entries(sources)
  .filter(([name]) => !name.endsWith(".test.ts") && !/test-(utils|vad)/.test(name))
  .map(([name, src]) => [name.replace("./", ""), stripComments(src)] as const);

describe("audio egress and persistence audit", () => {
  it("scans the real audio sources (not an empty glob)", () => {
    const names = prod.map(([n]) => n);
    for (const must of ["engine.ts", "wispr.ts", "capture.ts", "vad-driver.ts", "pcm.ts"]) expect(names).toContain(must);
  });

  it("never writes audio (or anything) to browser storage, files or caches", () => {
    const storage = /\b(localStorage|sessionStorage|indexedDB|IDBDatabase|showSaveFilePicker|showOpenFilePicker|FileSystemFileHandle|navigator\.storage|caches\.(open|put)|CacheStorage|MediaRecorder|URL\.createObjectURL)\b/;
    for (const [name, src] of prod) expect(src, name).not.toMatch(storage);
  });

  it("opens network connections from wispr.ts only (every other module is local-only)", () => {
    const egress = /(new\s+(WebSocket|EventSource|XMLHttpRequest)\b|\bfetch\s*\(|navigator\.sendBeacon|\bsendBeacon\s*\(|importScripts\s*\()/;
    for (const [name, src] of prod) {
      if (name === "wispr.ts") continue;
      expect(src, `${name} must not open its own network connection`).not.toMatch(egress);
    }
  });

  it("wispr.ts talks only to the endpoints the server handed out with the token (no hard-coded hosts)", () => {
    const wispr = prod.find(([n]) => n === "wispr.ts")![1];
    expect(wispr).not.toMatch(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i);
    expect(wispr).not.toMatch(/wss?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i);
  });
});
