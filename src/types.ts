// src/types.ts
export const GRID_WIDTH = 50;
export const GRID_HEIGHT = 50;

export type ZoneId = 0 | 1 | 2;

export interface CellEnv {
  temperature: number;
  o2: number;
  co2: number;
  zone: ZoneId;
  lastEatenTicks: number;  // >0: murió por depredación hace N ticks
  lastDeathTicks: number;  // >0: murió por causa natural hace N ticks
}

export interface OrganismSpecies {
  // estado dinámico
  age: number;
  mass: number;
  energy: number;
  damage: number;
  starvation: number;
  cellCycle: number;

  // fisiología heredable
  tempOpt: number;
  tempBreadth: number;
  uptakeRate: number;
  maintenanceRate: number;
  divisionMass: number;
  mutationRate: number;
  metabolicType: "aerobic" | "anaerobic";

  // ecología trófica
  attack: number;
  defense: number;
  motility: number;

  // genealogía
  speciesId: number;
  founderId: number;
  generation: number;
  speciationMarkerTicks?: number;
}

export interface CellStateSpecies {
  env: CellEnv;
  org: OrganismSpecies | null;
}
