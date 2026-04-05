// src/types.ts
export const GRID_WIDTH = 50;
export const GRID_HEIGHT = 50;

export type ZoneId = 0 | 1 | 2;

export interface CellEnv {
  temperature: number;
  o2: number;   // oxígeno disponible (0–1)
  co2: number;  // CO2 disponible (0–1)
  zone: ZoneId;
  lastEatenTicks: number;
}

export interface OrganismSpecies {
  energy: number;
  age: number;
  maxAge: number;
  tempOpt: number;
  mutationRate: number;
  reproThreshold: number;
  reproCooldown: number;
  predationIndex: number;   // 0=herbívoro puro, 1=carnívoro puro
  metabolicType: "aerobic" | "anaerobic";  // aerobic = O2→CO2, anaerobic = CO2→O2
  speciesId: number;
  founderId: number;
  speciationMarkerTicks?: number;
}

export interface CellStateSpecies {
  env: CellEnv;
  org: OrganismSpecies | null;
}
