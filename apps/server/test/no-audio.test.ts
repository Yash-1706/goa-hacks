import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ClientMessageSchema } from "@synapse/shared";
import { makeApp } from "./app-helper";

/**
 * PRD §8: "Audio bytes persisted anywhere: 0 — code audit + DB/FS scan test".
 * The browser streams audio straight to Wispr (client mode); the server only ever sees text. These tests make
 * that claim checkable: nothing on disk looks like audio, the server has no audio-shaped endpoint or message,
 * and no server/shared source touches audio capture or encoding APIs.
 */

const here = import.meta.dirname;
const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") walk(p, out);
    } else out.push(p);
  }
  return out;
}

/** crude comment stripper: block comments, whole-line comments, trailing " // ..." */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/\s.*$/, ""))
    .join("\n");
}

/** Container signatures long enough (>= 6 fixed bytes) that they cannot appear by chance in encrypted data. */
const AUDIO_SIGNATURES: Array<[string, RegExp]> = [
  ["RIFF/WAVE", /RIFF[\s\S]{4}WAVE/],
  ["Ogg page", /OggS\x00\x02/],
  ["FLAC", /fLaC\x00\x00\x00\x22/],
  ["MP4/M4A", /ftyp(isom|M4A |mp42|dash)/],
  ["EBML/WebM", /\x1a\x45\xdf\xa3[\s\S]{1,8}webm/],
];

describe("audio never persists", () => {
  it("a whole session on a file-backed database leaves only the encrypted database, with no audio container in any file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-noaudio-"));
    tmpDirs.push(dir);
    const app = await makeApp({ DATA_DIR: dir }, undefined, path.join(dir, "synapse.db"));

    await app.say("That bug from yesterday", { gapMs: 0 });
    await app.say("the null pointer in the cart service", { gapMs: 1400 });
    await app.say("probably the discount code", { gapMs: 1200, whisper: true });
    await app.say("want a coffee?", { gapMs: 4000 });
    await app.say("What was that idea I had about caching?", { gapMs: 3000 });
    await app.say("pause memory", { gapMs: 2500, whisper: true });
    await app.settle();
    await app.stop();

    const files = walk(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(path.basename(f), `unexpected file in the data dir: ${f}`).toMatch(/^synapse\.db(-wal|-shm|-journal)?$/);
      const bytes = fs.readFileSync(f).toString("latin1");
      for (const [name, re] of AUDIO_SIGNATURES) expect(bytes, `${path.basename(f)} contains a ${name} signature`).not.toMatch(re);
    }
    // sanity: the scan really reads something substantial, and transcripts are not in there in the clear either
    const db = fs.readFileSync(path.join(dir, "synapse.db")).toString("latin1");
    expect(db.length).toBeGreaterThan(8 * 1024);
    expect(db).not.toContain("discount code");
  });

  it("the server has no audio, speech-to-text or upload endpoint and the wire protocol has no audio message", async () => {
    const app = await makeApp();
    try {
      const routes = app.ctx.fastify.printRoutes({ commonPrefix: false });
      expect(routes.length).toBeGreaterThan(100);
      expect(routes).not.toMatch(/\b(audio|stt|speech|transcribe|transcription|upload|voice|record|recording|wav|pcm)\b/i);

      for (const url of ["/api/audio", "/api/transcribe", "/api/upload", "/api/stt", "/audio"]) {
        const res = await app.ctx.fastify.inject({ method: "POST", url, payload: Buffer.from("RIFF\0\0\0\0WAVEfmt ") });
        expect(res.statusCode, url).toBe(404);
      }

      for (const type of ["audio", "audio.chunk", "audio.append", "audio.frame", "pcm", "mic.stream"]) {
        expect(ClientMessageSchema.safeParse({ type, data: "AAAA", sessionId: "s", deviceId: "d" }).success, type).toBe(false);
      }
    } finally {
      await app.stop();
    }
  });

  it("no server or shared source touches audio capture or encoding APIs", () => {
    const roots = [path.resolve(here, "../src"), path.resolve(here, "../../../packages/shared/src")];
    const files = roots.flatMap((r) => walk(r)).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));
    expect(files.length).toBeGreaterThan(40);
    const forbidden: Array<[string, RegExp]> = [
      ["audio capture API", /\b(MediaRecorder|getUserMedia|AudioContext|AudioWorklet|MediaStream)\b/],
      ["audio file stream", /\bcreateWriteStream\b/],
      ["audio MIME type", /audio\/(x-)?(wav|webm|ogg|mpeg|mp4|flac|l16)/i],
      ["audio file extension literal", /["'`]\.?(wav|webm|ogg|mp3|flac|m4a|pcm)["'`]/i],
      ["raw PCM / waveform", /\b(pcm|pcm16|waveform)\b/i],
    ];
    for (const f of files) {
      const src = stripComments(fs.readFileSync(f, "utf8"));
      for (const [what, re] of forbidden) expect(src, `${path.relative(path.resolve(here, "../../.."), f)}: ${what}`).not.toMatch(re);
    }
  });
});
