/* V1.1: how the phone's connection reaches this Mac, said exactly as strongly as the tunnel allows (Privacy Center, landing). */

export interface Transit {
  kind: "tailscale" | "ngrok" | "cloudflared" | "custom" | "none";
  label: string;
  /** decrypted only on this Mac (no relay can read it) */
  endToEnd: boolean;
  /** the URL survives a restart */
  stable: boolean;
  note: string;
}

export function transitOf(publicUrl: string | undefined): Transit {
  let host = "";
  try {
    host = publicUrl ? new URL(publicUrl).hostname : "";
  } catch {
    /* not a URL: treated as none */
  }
  if (!host) return { kind: "none", label: "No public URL", endToEnd: false, stable: true, note: "Not reachable from the internet: only this Mac (and paired devices on its network) can reach Synapse." };
  if (host.endsWith(".ts.net"))
    return { kind: "tailscale", label: "Tailscale Funnel", endToEnd: true, stable: true, note: "HTTPS from your phone is decrypted only on this Mac: Tailscale's relay passes it through without being able to read it." };
  if (/\.ngrok(-free)?\.(app|dev|io)$/.test(host))
    return { kind: "ngrok", label: "ngrok", endToEnd: false, stable: true, note: "Encrypted on the way, but ngrok's servers decrypt it and re-encrypt it to this Mac (that is how a free ngrok domain works)." };
  if (host.endsWith(".trycloudflare.com"))
    return { kind: "cloudflared", label: "Cloudflare quick tunnel", endToEnd: false, stable: false, note: "Encrypted on the way, but Cloudflare's servers decrypt it and re-encrypt it to this Mac. The address changes every restart." };
  return { kind: "custom", label: host, endToEnd: false, stable: true, note: "HTTPS to the address you configured; whoever terminates TLS for it can read the traffic." };
}
