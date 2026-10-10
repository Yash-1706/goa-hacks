import { describe, expect, it } from "vitest";
import { isOnDevice, speechLabel } from "./speech-engine";

describe("speechLabel", () => {
  it("names each speech engine and says where its audio goes", () => {
    expect(speechLabel("client")).toMatchObject({ long: "Wispr Flow (cloud)", audio: expect.stringContaining("Wispr Flow") });
    expect(speechLabel("local")).toMatchObject({ short: "on-device", long: "on-device Whisper", audio: expect.stringContaining("this machine only") });
    expect(speechLabel("proxy").audio).toMatch(/relays/);
    for (const none of ["mock", undefined, "something-else"]) expect(speechLabel(none).long).toMatch(/typed input/);
  });

  it("only 'local' keeps the audio on the machine that runs the server", () => {
    expect(isOnDevice("local")).toBe(true);
    for (const m of ["client", "proxy", "mock", undefined]) expect(isOnDevice(m)).toBe(false);
  });
});
