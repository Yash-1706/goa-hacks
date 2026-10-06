import { create } from "zustand";
import type { CalendarEventView, DeviceInfo } from "@synapse/shared";

export interface DevicesState {
  devices: DeviceInfo[];
  set: (d: DeviceInfo[]) => void;
}

export const useDevices = create<DevicesState>()((set) => ({
  devices: [],
  set: (devices) => set({ devices }),
}));

export interface CalendarState {
  events: CalendarEventView[];
  set: (e: CalendarEventView[]) => void;
}

export const useCalendar = create<CalendarState>()((set) => ({
  events: [],
  set: (events) => set({ events }),
}));
