import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerWeb } from "../src/gateway/static";
import { parseTunnelUrl, startTunnel, type SpawnFn } from "../src/tunnel";

/** One port for pages, API and WebSocket (1c), and the cloudflared quick tunnel that makes it reachable from a phone on 4G (1d). */

describe("serving the built web app", () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-dist-"));
  const app = Fastify();
  beforeAll(async () => {
    fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>Synapse</title>");
    fs.mkdirSync(path.join(dist, "assets"));
    fs.writeFileSync(path.join(dist, "assets", "index-abc123.js"), "console.log(1)");
    fs.writeFileSync(path.join(dist, "sw.js"), "self.x=1");
    fs.writeFileSync(path.join(dist, "manifest.webmanifest"), "{}");
    app.get("/api/health", async () => ({ ok: true }));
    await registerWeb(app, dist);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    fs.rmSync(dist, { recursive: true, force: true });
  });

  it("serves index.html at / and for every client-side route (SPA fallback)", async () => {
    for (const url of ["/", "/capture", "/ask", "/settings/privacy", "/capture?autostart=1"]) {
      const r = await app.inject({ url });
      expect(r.statusCode, url).toBe(200);
      expect(r.body).toContain("<title>Synapse</title>");
      expect(r.headers["cache-control"]).toMatch(/no-cache/);
    }
  });

  it("serves hashed assets with a long cache, the service worker without one", async () => {
    const js = await app.inject({ url: "/assets/index-abc123.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["cache-control"]).toMatch(/immutable/);
    const sw = await app.inject({ url: "/sw.js" });
    expect(sw.statusCode).toBe(200);
    expect(sw.headers["cache-control"]).toMatch(/no-cache/);
  });

  it("an unknown API route, a missing asset or a non-GET is a 404, never the page", async () => {
    const api = await app.inject({ url: "/api/nope" });
    expect(api.statusCode).toBe(404);
    expect(api.body).not.toContain("<title>");
    expect((await app.inject({ url: "/assets/missing-999.js" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/capture", method: "POST" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/health" })).json()).toEqual({ ok: true });
  });
});

describe("cloudflared quick tunnel", () => {
  it("finds the trycloudflare URL in cloudflared's log lines", () => {
    expect(parseTunnelUrl("2026-10-11T10:00:00Z INF |  https://calm-river-1234.trycloudflare.com                                 |")).toBe("https://calm-river-1234.trycloudflare.com");
    expect(parseTunnelUrl("INF Requesting new quick Tunnel on trycloudflare.com...")).toBeNull();
    expect(parseTunnelUrl("see https://www.cloudflare.com/website-terms/")).toBeNull();
  });

  const fakeSpawn = (lines: string[], o: { fail?: NodeJS.ErrnoException } = {}): { spawn: SpawnFn; calls: string[][]; killed: () => boolean } => {
    const calls: string[][] = [];
    let killed = false;
    const spawn: SpawnFn = (cmd, args) => {
      calls.push([cmd, ...args]);
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {
        killed = true;
        return true;
      };
      setTimeout(() => {
        if (o.fail) return void child.emit("error", o.fail);
        for (const l of lines) child.stderr.write(l + "\n");
      }, 5);
      return child as never;
    };
    return { spawn, calls, killed: () => killed };
  };

  it("spawns cloudflared at the local port and resolves with the public URL", async () => {
    const f = fakeSpawn(["INF Requesting new quick Tunnel on trycloudflare.com...", "INF |  https://calm-river-1234.trycloudflare.com  |", "INF Registered tunnel connection"]);
    const t = await startTunnel({ port: 8787, spawn: f.spawn, timeoutMs: 2000 });
    expect(t.url).toBe("https://calm-river-1234.trycloudflare.com");
    expect(f.calls[0]).toEqual(["cloudflared", "tunnel", "--no-autoupdate", "--url", "http://localhost:8787"]);
    t.stop();
    expect(f.killed()).toBe(true);
  });

  it("a missing cloudflared says how to install it; no URL in time is a clear error", async () => {
    const enoent = Object.assign(new Error("spawn cloudflared ENOENT"), { code: "ENOENT" });
    await expect(startTunnel({ port: 8787, spawn: fakeSpawn([], { fail: enoent }).spawn, timeoutMs: 2000 })).rejects.toThrow(/brew install cloudflared/);
    const silent = fakeSpawn(["INF starting"]);
    await expect(startTunnel({ port: 8787, spawn: silent.spawn, timeoutMs: 100 })).rejects.toThrow(/did not report a URL/);
    expect(silent.killed()).toBe(true);
  });
});
