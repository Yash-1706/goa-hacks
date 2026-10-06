import { describe, expect, it } from "vitest";
import { pickPowerMode, watchBattery, type BatteryReading } from "./battery";

class FakeBattery {
  level = 0.8;
  charging = false;
  private fns = new Map<string, Set<() => void>>();
  addEventListener(type: string, fn: () => void): void {
    let s = this.fns.get(type);
    if (!s) this.fns.set(type, (s = new Set()));
    s.add(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.fns.get(type)?.delete(fn);
  }
  fire(type: string): void {
    for (const f of [...(this.fns.get(type) ?? [])]) f();
  }
  count(): number {
    let n = 0;
    for (const s of this.fns.values()) n += s.size;
    return n;
  }
}

describe("watchBattery", () => {
  it("reports the current reading at once, then on level and charging changes", async () => {
    const bm = new FakeBattery();
    const seen: BatteryReading[] = [];
    const w = await watchBattery((b) => seen.push(b), { navigator: { getBattery: async () => bm } });
    expect(w.supported).toBe(true);
    expect(seen).toEqual([{ level: 0.8, charging: false }]);
    bm.level = 0.29;
    bm.fire("levelchange");
    bm.charging = true;
    bm.fire("chargingchange");
    expect(seen).toEqual([
      { level: 0.8, charging: false },
      { level: 0.29, charging: false },
      { level: 0.29, charging: true },
    ]);
  });

  it("stop() removes the listeners and silences further changes", async () => {
    const bm = new FakeBattery();
    const seen: BatteryReading[] = [];
    const w = await watchBattery((b) => seen.push(b), { navigator: { getBattery: async () => bm } });
    expect(bm.count()).toBe(2);
    w.stop();
    expect(bm.count()).toBe(0);
    bm.fire("levelchange");
    expect(seen).toHaveLength(1);
    w.stop(); // idempotent
  });

  it("is {supported:false} (and silent) where navigator.getBattery does not exist: Safari / iOS / Firefox", async () => {
    const seen: BatteryReading[] = [];
    for (const nav of [{}, null, { getBattery: undefined }]) {
      const w = await watchBattery((b) => seen.push(b), { navigator: nav as never });
      expect(w.supported).toBe(false);
      w.stop();
    }
    expect(seen).toHaveLength(0);
  });

  it("never throws: a rejecting getBattery (permissions policy) or a throwing callback is contained", async () => {
    const w = await watchBattery(() => undefined, {
      navigator: {
        getBattery: async () => {
          throw new Error("NotAllowedError");
        },
      },
    });
    expect(w.supported).toBe(false);
    const bm = new FakeBattery();
    const w2 = await watchBattery(
      () => {
        throw new Error("ui bug");
      },
      { navigator: { getBattery: async () => bm } },
    );
    expect(w2.supported).toBe(true);
    expect(() => bm.fire("levelchange")).not.toThrow();
  });

  it("clamps nonsense levels into 0..1", async () => {
    const bm = new FakeBattery();
    bm.level = 1.4;
    const seen: BatteryReading[] = [];
    await watchBattery((b) => seen.push(b), { navigator: { getBattery: async () => bm } });
    bm.level = Number.NaN;
    bm.fire("levelchange");
    expect(seen.map((s) => s.level)).toEqual([1, 1]);
  });

  it("works with the real globals present (feature detection only)", async () => {
    // in node there is no navigator.getBattery, so this must simply be unsupported
    const w = await watchBattery(() => undefined);
    expect(w.supported).toBe(false);
  });
});

describe("pickPowerMode (TRD §11.4 layer 5)", () => {
  const r = (level: number, charging = false): BatteryReading => ({ level, charging });
  it("eco below 30 % while not charging", () => {
    expect(pickPowerMode(r(0.29))).toBe("eco");
    expect(pickPowerMode(r(0.1))).toBe("eco");
    expect(pickPowerMode(r(0.3))).toBe("normal");
    expect(pickPowerMode(r(0.9))).toBe("normal");
  });
  it("charging always means normal", () => {
    expect(pickPowerMode(r(0.05, true), "eco")).toBe("normal");
  });
  it("hysteresis: once in eco, stay until 35 %", () => {
    expect(pickPowerMode(r(0.32), "eco")).toBe("eco");
    expect(pickPowerMode(r(0.34), "eco")).toBe("eco");
    expect(pickPowerMode(r(0.35), "eco")).toBe("normal");
    expect(pickPowerMode(r(0.32), "normal")).toBe("normal");
  });
});
