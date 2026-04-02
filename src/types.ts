// src/types.ts
export const GRID_WIDTH = 50;
export const GRID_HEIGHT = 50;

export type ZoneId = 0 | 1 | 2;

export interface CellEnv {
  temperature: number;
  nutrient: number;
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
  predationIndex: number;  // 0=herbívoro puro, 1=carnívoro puro
  speciesId: number;
  founderId: number;
  speciationMarkerTicks?: number;
}

export interface CellStateSpecies {
  env: CellEnv;
  org: OrganismSpecies | null;
}
