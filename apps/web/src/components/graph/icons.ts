import { Box, Building2, Bug, CalendarDays, Cpu, FolderKanban, Hash, MapPin, User, type LucideIcon } from "lucide-react";
import type { EntityType } from "@synapse/shared";

/** Icon per entity type (the card chips keep their own private copy of this table). */
export const ENTITY_ICON: Record<EntityType, LucideIcon> = {
  person: User,
  component: Box,
  technology: Cpu,
  project: FolderKanban,
  bug: Bug,
  event: CalendarDays,
  place: MapPin,
  topic: Hash,
  org: Building2,
};
