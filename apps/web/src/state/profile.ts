import { create } from "zustand";
import type { Profile } from "@synapse/shared";
import { api } from "@/net/api";

/* The context profile as the UI sees it (V1): loaded once, saved through PUT /api/profile. */

export interface ProfileState {
  profile: Profile | null;
  load: () => Promise<Profile | null>;
  save: (p: Profile) => Promise<Profile>;
  set: (p: Profile) => void;
}

export const useProfile = create<ProfileState>()((set) => ({
  profile: null,
  load: async () => {
    try {
      const p = await api.profile();
      set({ profile: p });
      return p;
    } catch {
      return null;
    }
  },
  save: async (p) => {
    const saved = await api.saveProfile(p);
    set({ profile: saved });
    return saved;
  },
  set: (profile) => set({ profile }),
}));
