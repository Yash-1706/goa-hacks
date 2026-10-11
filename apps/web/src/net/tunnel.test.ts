import { describe, expect, it } from "vitest";
import { tunnelHeaders } from "./tunnel";

describe("tunnel headers", () => {
  it("ngrok hosts get the skip-warning header (else ngrok answers an API call with its HTML warning page)", () => {
    for (const h of ["calm-otter.ngrok-free.app", "calm-otter.ngrok-free.dev", "x.ngrok.app", "x.ngrok.io"]) expect(tunnelHeaders(h)).toEqual({ "ngrok-skip-browser-warning": "1" });
  });
  it("every other host gets nothing extra", () => {
    for (const h of ["localhost", "sayeds-macbook-air.tail0000.ts.net", "a-b.trycloudflare.com", "ngrok.app.evil.com"]) expect(tunnelHeaders(h)).toEqual({});
  });
});
