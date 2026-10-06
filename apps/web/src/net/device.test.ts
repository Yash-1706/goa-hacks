import { describe, expect, it } from "vitest";
import { detectKind, getDeviceId, rotateTabDeviceId, socketUrl } from "./device";

const env = (o: Partial<Parameters<typeof detectKind>[0]> = {}) => ({ pathname: "/", search: "", coarse: false, width: 1440, ...o });

describe("detectKind", () => {
  it("a laptop is a desk", () => {
    expect(detectKind(env())).toBe("desk");
  });
  it("the /pocket route is a phone, whatever the device", () => {
    expect(detectKind(env({ pathname: "/pocket" }))).toBe("pocket");
  });
  it("a touch device with a phone-sized viewport is a pocket on any route", () => {
    expect(detectKind(env({ coarse: true, width: 390 }))).toBe("pocket");
    expect(detectKind(env({ coarse: true, width: 1024 }))).toBe("desk"); // a tablet / touch laptop
  });
  it("?kind= overrides everything", () => {
    expect(detectKind(env({ search: "?kind=pocket" }))).toBe("pocket");
    expect(detectKind(env({ pathname: "/pocket", search: "?kind=desk" }))).toBe("desk");
    expect(detectKind(env({ search: "?kind=toaster" }))).toBe("desk");
  });
});

describe("socketUrl", () => {
  it("maps http(s) origins to ws(s)", () => {
    expect(socketUrl({ origin: "http://localhost:5173" })).toBe("ws://localhost:5173/ws");
    expect(socketUrl({ origin: "https://192.168.1.20:5173" })).toBe("wss://192.168.1.20:5173/ws");
  });
});

describe("device identity", () => {
  it("is stable, and a tab that lost the shared id becomes a device of its own (still derived from it)", () => {
    const base = getDeviceId();
    expect(base).toMatch(/^web-/);
    expect(getDeviceId()).toBe(base);
    const own = rotateTabDeviceId();
    expect(own).not.toBe(base);
    expect(own.startsWith(base)).toBe(true);
    expect(own.length).toBeLessThanOrEqual(80);
    expect(getDeviceId()).toBe(own);
  });
});
