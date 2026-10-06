import { ulid } from "ulid";

/** Internal ids: ULIDs (sortable, unique). Display codes (T-12, E-3, A-7) come from DB counters. */
export const newId = (): string => ulid();

export type CodePrefix = "T" | "E" | "A" | "S" | "O" | "G" | "B";
