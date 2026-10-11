import { describe, expect, it } from "vitest";
import { transitOf } from "./transit";

/** V1.1 privacy copy: where the phone's connection is decrypted, per tunnel, with no claim stronger than the code. */
describe("phone → Mac transit", () => {
  it("Tailscale Funnel: decrypted only on this Mac", () => {
    const t = transitOf("https://mac.tail0000.ts.net");
    expect(t).toMatchObject({ kind: "tailscale", endToEnd: true, stable: true });
    expect(t.note).toMatch(/only on this Mac/);
  });
  it("ngrok and Cloudflare: encrypted in transit, but their edge decrypts it; Cloudflare's quick URL is temporary", () => {
    expect(transitOf("https://calm-otter.ngrok-free.app")).toMatchObject({ kind: "ngrok", endToEnd: false, stable: true });
    expect(transitOf("https://calm-otter.ngrok-free.app").note).toMatch(/ngrok's servers decrypt/);
    const cf = transitOf("https://a-b-c.trycloudflare.com");
    expect(cf).toMatchObject({ kind: "cloudflared", endToEnd: false, stable: false });
    expect(cf.note).toMatch(/Cloudflare's servers decrypt/);
  });
  it("no public URL: nothing is exposed; any other https URL is described without a claim we cannot check", () => {
    expect(transitOf(undefined)).toMatchObject({ kind: "none" });
    expect(transitOf("https://synapse.example.com")).toMatchObject({ kind: "custom", endToEnd: false });
    expect(transitOf("https://synapse.example.com").note).not.toMatch(/end to end|only on this Mac/);
  });
});
