import fs from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/* ============================================================================
 * `pnpm start` serves the built web app from the API server (V1 1c): pages, API and WebSocket on one origin and one port,
 * which keeps the session cookie, the service worker and the WebSocket simple behind a tunnel. Client-side routes fall
 * back to index.html; API, WebSocket and speech paths never do.
 * ========================================================================== */

const NOT_PAGES = /^\/(api|ws|local-stt)(\/|$)/;

export function webDistReady(dist: string): boolean {
  return fs.existsSync(path.join(dist, "index.html"));
}

export async function registerWeb(app: FastifyInstance, dist: string): Promise<void> {
  await app.register(fastifyStatic, {
    root: dist,
    index: false, // "/" and client-side routes are answered below, with the no-cache header
    // the default wildcard route looks files up per request: a fresh build is served without a restart
    setHeaders: (reply, file) => {
      const rel = path.relative(dist, file);
      // hashed build output never changes under its name; everything else (index, sw.js, manifest) must be revalidated
      reply.header("cache-control", rel.startsWith(`assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache");
    },
  });
  app.get("/", (_req, reply) => reply.header("cache-control", "no-cache").sendFile("index.html"));
  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split("?")[0] as string;
    const isPage = req.method === "GET" && !NOT_PAGES.test(url) && !path.extname(url);
    if (isPage) return reply.header("cache-control", "no-cache").sendFile("index.html");
    return reply.code(404).send({ error: "not found" });
  });
}
