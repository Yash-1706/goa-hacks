import { create } from "zustand";
import type { ClientConfig } from "@synapse/shared";
import { getJson, setJson } from "@/lib/storage";

/* Server configuration (read-only, from `welcome`) + this browser's own display preferences. */

/** persisted display preferences */
interface Prefs {
  largeType: boolean;
  tts: boolean;
  autoEco: boolean;
}

const KEY = "synapse.prefs";
const defaults: Prefs = { largeType: false, tts: false, autoEco: true };

export interface SettingsState extends Prefs {
  config: ClientConfig | null;
  /** the typed-input box is open (deliberately NOT persisted: the demo starts voice-only every time) */
  typedOpen: boolean;
  setConfig: (c: ClientConfig) => void;
  patch: (p: Partial<Prefs & { typedOpen: boolean }>) => void;
}

export const useSettings = create<SettingsState>()((set, get) => ({
  ...defaults,
  ...getJson<Partial<Prefs>>(KEY, {}),
  config: null,
  typedOpen: false,
  setConfig: (config) => set({ config }),
  patch: (p) => {
    set(p);
    const s = get();
    setJson(KEY, { largeType: s.largeType, tts: s.tts, autoEco: s.autoEco } satisfies Prefs);
  },
}));
