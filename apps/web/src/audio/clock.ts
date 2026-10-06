/**
 * Injectable time source. Everything in the audio pipeline takes a Clock so the unit tests can drive
 * time deterministically (see test-utils.ts FakeClock).
 *
 * `now()` is epoch milliseconds from Date.now(): it is what the server's clock-sync offset is computed
 * against. (performance.timeOrigin + performance.now() would drift by the sleep time after a laptop resume.)
 * `perf()` is a monotonic high-resolution clock used only for CPU-time accounting.
 */
export type TimerId = unknown;

export interface Clock {
  now(): number;
  perf(): number;
  setTimeout(fn: () => void, ms: number): TimerId;
  clearTimeout(id: TimerId): void;
  setInterval(fn: () => void, ms: number): TimerId;
  clearInterval(id: TimerId): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  perf: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
};
