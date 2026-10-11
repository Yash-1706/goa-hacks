/* Web Share Target (V1): "Share → Synapse" from a voice recorder or any app. Imported into the generated service worker.
 * The shared files are held in THIS worker's memory only (never written to a cache or IndexedDB) until /capture?shared=1
 * asks for them, decodes the audio to a 16 kHz WAV and queues it like a recording. */
const pendingShares = [];

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "POST" || url.pathname !== "/capture/share") return;
  event.respondWith(
    (async () => {
      try {
        const form = await event.request.formData();
        const files = form.getAll("audio").filter((f) => typeof f === "object" && f && "arrayBuffer" in f);
        const text = ["title", "text", "url"].map((k) => form.get(k)).filter((v) => typeof v === "string" && v.trim()).join(" ").trim();
        pendingShares.push({ files, text });
      } catch {
        /* an unreadable share: open the app anyway */
      }
      return Response.redirect("/capture?shared=1", 303);
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "synapse.share.take" && event.ports[0]) event.ports[0].postMessage(pendingShares.splice(0));
});
