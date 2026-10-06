import { createTextEngine } from "./text-engine";
import type { AudioEngineFactory } from "./types";

export * from "./types";
export { createTextEngine };

/**
 * The microphone engine (VAD + Wispr streaming) lives in ./engine.ts, built separately.
 * It is resolved lazily with import.meta.glob so the UI compiles and runs (typed input) even
 * before that file exists, and so a failure to load the VAD/ONNX bundle degrades gracefully.
 */
const modules = import.meta.glob<{ createMicEngine: AudioEngineFactory }>("./engine.ts");

export async function loadMicEngine(): Promise<AudioEngineFactory | null> {
  const loader = modules["./engine.ts"];
  if (!loader) return null;
  try {
    return (await loader()).createMicEngine;
  } catch (err) {
    console.warn("[audio] mic engine failed to load:", (err as Error).message);
    return null;
  }
}
