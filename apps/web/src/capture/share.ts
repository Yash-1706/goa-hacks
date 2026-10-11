/* The page side of the Web Share Target: take what the service worker holds in memory (public/share-target.js). */

export interface SharedItem {
  files: File[];
  text: string;
}

export async function takeShared(timeoutMs = 3000): Promise<SharedItem[]> {
  const reg = await navigator.serviceWorker?.ready.catch(() => undefined);
  const worker = navigator.serviceWorker?.controller ?? reg?.active;
  if (!worker) return [];
  return new Promise<SharedItem[]>((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve([]), timeoutMs);
    ch.port1.onmessage = (e: MessageEvent<SharedItem[]>) => {
      clearTimeout(timer);
      resolve(Array.isArray(e.data) ? e.data : []);
    };
    worker.postMessage({ type: "synapse.share.take" }, [ch.port2]);
  });
}
