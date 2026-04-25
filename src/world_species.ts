// src/world_species.ts
import { GRID_WIDTH, GRID_HEIGHT } from "./types";
import type { CellEnv, CellStateSpecies, OrganismSpecies, ZoneId } from "./types";

// --- Constantes de entorno ---
const GAS_DIFFUSION      = 0.05;
const GAS_PRODUCE_RATIO  = 0.8;
const GAS_BORDER_REGEN   = 0.4;
const GAS_BORDER_WIDTH   = 5;
const GAS_ZONE_REGEN     = 0.009;
const RESOURCE_DIFFUSION = 0.02;
const WASTE_DIFFUSION    = 0.015;
const WASTE_DECAY        = 0.03;   // fracción de residuo que desaparece por tick
const RESOURCE_REGEN_SCALE = 0.5; // multiplica zoneRegen para obtener regen de recurso

// --- Constantes de biología ---
const ATTACK_THRESHOLD  = 0.2;   // ataque mínimo para intentar depredar
const HUNGER_ENERGY     = 0.6;   // energía máxima para intentar depredar
const MIN_PREY_POP      = 7;     // población mínima de una especie para poder ser depredada

// --- Helpers puros ---

function thermalPerformance(temp: number, tempOpt: number, breadth: number): number {
  const z = (temp - tempOpt) / Math.max(0.02, breadth);
  return Math.max(0, Math.exp(-z * z));
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function rnd(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}

// --- Genome type (subconjunto heredable) ---
interface Genome {
  tempOpt: number;
  tempBreadth: number;
  uptakeRate: number;
  maintenanceRate: number;
  divisionMass: number;
  attack: number;
  defense: number;
  motility: number;
  mutationRate: number;
  metabolicType: "aerobic" | "anaerobic";
}

function extractGenome(org: OrganismSpecies): Genome {
  return {
    tempOpt: org.tempOpt,
    tempBreadth: org.tempBreadth,
    uptakeRate: org.uptakeRate,
    maintenanceRate: org.maintenanceRate,
    divisionMass: org.divisionMass,
    attack: org.attack,
    defense: org.defense,
    motility: org.motility,
    mutationRate: org.mutationRate,
    metabolicType: org.metabolicType,
  };
}

function maybeMutateContinuous(
  g: Genome,
  key: keyof Genome,
  mu: number,
  scale: number,
  lo: number,
  hi: number
) {
  if (Math.random() < mu * 2) {
    (g as unknown as Record<string, number>)[key] = clamp(
      (g as unknown as Record<string, number>)[key] + (Math.random() * 2 - 1) * scale,
      lo,
      hi
    );
  }
}


function mutateGenome(parent: OrganismSpecies): Genome {
  const g = extractGenome(parent);
  const mu = g.mutationRate;

  maybeMutateContinuous(g, "tempOpt",        mu,       0.025, 0,     1);
  maybeMutateContinuous(g, "tempBreadth",    mu,       0.012, 0.03,  0.35);
  maybeMutateContinuous(g, "uptakeRate",     mu,       0.04,  0.05,  2.0);
  maybeMutateContinuous(g, "maintenanceRate",mu,       0.025, 0.005, 1.5);
  maybeMutateContinuous(g, "divisionMass",   mu,       0.05,  0.3,   4.0);
  maybeMutateContinuous(g, "attack",         mu,       0.04,  0,     1);
  maybeMutateContinuous(g, "defense",        mu,       0.04,  0,     1);
  maybeMutateContinuous(g, "motility",       mu,       0.04,  0,     1);
  maybeMutateContinuous(g, "mutationRate",   mu * 0.3, 0.006, 0.001, 0.25);

  if (Math.random() < mu * 0.05) {
    g.metabolicType = g.metabolicType === "aerobic" ? "anaerobic" : "aerobic";
  }

  return g;
}

function expressPhenotype(g: Genome, parent: OrganismSpecies): OrganismSpecies {
  return {
    age: 0,
    mass: 0,
    energy: 0,
    damage: 0,
    starvation: 0,
    cellCycle: 0,
    generation: parent.generation + 1,
    speciesId: parent.speciesId,
    founderId: parent.founderId,
    ...g,
  };
}

// ============================================================
export class WorldSpecies {
  readonly worldType = "AEROBIC_WORLD_V2";

  grid: CellStateSpecies[][];
  tickCount = 0;
  zoneBaseTemps: number[] = [0.2, 0.5, 0.7];
  zoneRegen: number[] = [0.018, 0.030, 0.008]; // mantenido por la UI

  tempStressIntensity = 0.09; // mantenido por la UI (no afecta al nuevo modelo directamente)

  baseMutationRate = 0.02;
  seasonPeriod     = 1000;
  seasonAmplitude  = 0.06;

  predatorThreshold = ATTACK_THRESHOLD; // usado por la UI para el marcador rojo

  private speciesPopulation = new Map<number, number>();

  // Especies
  speciesCounter = 1;
  speciesMap = new Map<number, {
    color: string;
    tempOpt: number;
    attack: number;
    divisionMass: number;
    mutationRate: number;
    parentSpeciesId: number | null;
  }>();

  onNewSpecies?: (event: {
    speciesId: number; parentSpeciesId: number | null;
    founderTraits: { tempOpt: number; divisionMass: number; attack: number; mutationRate: number };
    zone: number; x: number; y: number;
  }) => void;

  constructor() {
    this.grid = [];
    this.initGrid();
  }

  private resetGridEmpty() {
    this.grid = [];
    this.initGrid();
    this.tickCount = 0;
  }

  seedSingleAncestor(initialMutationRate: number) {
    this.resetGridEmpty();

    const x = Math.floor(GRID_WIDTH / 4);   // zona O2, lejos del borde
    const y = Math.floor(GRID_HEIGHT / 2);
    const cell = this.grid[y][x];
    const tempOpt = this.baseTempForZone(cell.env.zone);

    const baseSpecies = this.createSpecies({
      tempOpt,
      attack: 0.5,
      divisionMass: 1.0,
      mutationRate: initialMutationRate,
      parentSpeciesId: null,
    });

    cell.org = {
      age: 0,
      mass: 0.5,
      energy: 0.8,
      damage: 0,
      starvation: 0,
      cellCycle: 0,
      tempOpt,
      tempBreadth: 0.12,
      uptakeRate: 0.8,
      maintenanceRate: 0.02,
      divisionMass: 1.0,
      mutationRate: initialMutationRate,
      metabolicType: "aerobic",
      attack: 0.5,
      defense: 0.3,
      motility: 0.2,
      speciesId: baseSpecies,
      founderId: baseSpecies,
      generation: 0,
    };
  }

  // ---- Tick principal ----

  step() {
    this.tickCount++;
    this.updateEnvironment();
    this.updateOrganisms();
  }

  private updateOrganisms() {
    // Conteo de población por especie (para proteger minorías de depredación)
    this.speciesPopulation.clear();
    for (let y = 0; y < GRID_HEIGHT; y++)
      for (let x = 0; x < GRID_WIDTH; x++) {
        const id = this.grid[y][x].org?.speciesId;
        if (id !== undefined) this.speciesPopulation.set(id, (this.speciesPopulation.get(id) ?? 0) + 1);
      }

    const nextGrid = this.grid.map(row =>
      row.map(cell => ({
        ...cell,
        env: { ...cell.env },
        org: cell.org ? { ...cell.org } : null,
      }))
    );

    for (let y = 0; y < GRID_HEIGHT; y++) {
      for (let x = 0; x < GRID_WIDTH; x++) {
        const current = this.grid[y][x].org;
        if (!current) continue;

        let org = { ...current };
        const env = nextGrid[y][x].env;

        // 1. envejecer
        org.age += 1;
        if (org.speciationMarkerTicks && org.speciationMarkerTicks > 0) {
          org.speciationMarkerTicks -= 1;
        }

        // 2. metabolismo
        this.processMetabolism(org, env);

        // 3. movimiento
        let tx = x, ty = y;
        const moved = this.maybeMove(x, y, org, nextGrid);
        if (moved) {
          [tx, ty] = moved;
          nextGrid[y][x].org = null;
          nextGrid[ty][tx].org = org;
        } else {
          nextGrid[y][x].org = org;
        }

        // 4. depredación
        this.maybePredate(tx, ty, org, nextGrid);

        // 5. ciclo celular
        this.advanceCellCycle(org, nextGrid[ty][tx].env);

        // 6. muerte
        if (this.shouldDie(org, nextGrid[ty][tx].env)) {
          this.onDeath(org, nextGrid[ty][tx].env);
          nextGrid[ty][tx].org = null;
          continue;
        }

        // 7. división
        if (org.cellCycle >= 1) {
          const divided = this.divideIfReady(tx, ty, nextGrid, org);
          if (!divided) {
            nextGrid[ty][tx].org = org;
          }
          // si divided=true, las hijas ya están en nextGrid (madre borrada dentro)
        } else {
          nextGrid[ty][tx].org = org;
        }
      }
    }

    this.grid = nextGrid;
  }

  // ---- Metabolismo ----

  private processMetabolism(org: OrganismSpecies, env: CellEnv) {
    const thermal  = thermalPerformance(env.temperature, org.tempOpt, org.tempBreadth);
    const toxicity = Math.max(0, 1 - env.waste);  // residuo reduce eficiencia de captación

    // Recurso como sustrato primario
    const isAerobic   = org.metabolicType === "aerobic";
    const grossUptake = org.uptakeRate * thermal * toxicity * 0.08;
    const resourceTaken = Math.min(env.resource, grossUptake);
    env.resource = Math.max(0, env.resource - resourceTaken);

    // Gas como catalizador: determina la eficiencia real de la asimilación
    let gasFactor: number;
    if (isAerobic) {
      const o2Needed = resourceTaken * 0.8;
      const o2Taken  = Math.min(env.o2, o2Needed);
      env.o2  = Math.max(0, env.o2  - o2Taken);
      env.co2 = Math.min(1, env.co2 + o2Taken * GAS_PRODUCE_RATIO);
      gasFactor = o2Taken / Math.max(0.0001, o2Needed);
    } else {
      const co2Needed = resourceTaken * 0.8;
      const co2Taken  = Math.min(env.co2, co2Needed);
      env.co2 = Math.max(0, env.co2 - co2Taken);
      env.o2  = Math.min(1, env.o2  + co2Taken * GAS_PRODUCE_RATIO);
      gasFactor = co2Taken / Math.max(0.0001, co2Needed);
    }

    const pathwayEff   = isAerobic ? 1.0 : 0.65;
    const assimilation = resourceTaken * gasFactor * pathwayEff * thermal;

    const maintenance =
      org.maintenanceRate +
      0.015 * org.attack  +
      0.008 * org.motility +
      0.02  * org.damage;

    const net = assimilation - maintenance;

    if (net >= 0) {
      org.energy    += net * 0.55;
      org.mass      += net * 0.45;
      org.starvation = Math.max(0, org.starvation - 0.04);
    } else {
      const deficit    = -net;
      const fromEnergy = Math.min(org.energy, deficit * 0.7);
      org.energy -= fromEnergy;
      const remaining = deficit - fromEnergy;
      if (remaining > 0) {
        org.mass      -= remaining * 0.5;
        org.starvation += remaining;
      }
    }

    // Producción de residuo metabólico
    env.waste = Math.min(1, env.waste + assimilation * 0.12);

    // Daño por temperatura extrema y residuo
    const thermalDmg = Math.max(0, 1 - thermal) * 0.004;
    org.damage = Math.max(0, org.damage + thermalDmg + env.waste * 0.002 - 0.0005);
  }

  // ---- Ciclo celular ----

  private advanceCellCycle(org: OrganismSpecies, env: CellEnv) {
    if (
      org.mass >= org.divisionMass * 0.7 &&
      org.energy >= 0.2 * org.divisionMass &&
      org.damage < 0.8
    ) {
      const thermal = thermalPerformance(env.temperature, org.tempOpt, org.tempBreadth);
      org.cellCycle += 0.07 * thermal;
    }
  }

  // ---- División binaria ----

  private divideIfReady(
    x: number, y: number,
    grid: CellStateSpecies[][],
    org: OrganismSpecies
  ): boolean {
    if (org.cellCycle < 1) return false;

    const pos = this.findEmptyNeighbor(x, y, grid);
    if (!pos) {
      // sin espacio: penaliza y retrasa
      org.energy   -= 0.08;
      org.damage   += 0.04;
      org.cellCycle = 0.6;
      return false;
    }

    const [nx, ny] = pos;
    const [childA, childB] = this.makeDaughters(org, x, y);

    grid[y][x].org   = childA;
    grid[ny][nx].org = childB;
    return true;
  }

  private makeDaughters(
    parent: OrganismSpecies,
    x: number, y: number
  ): [OrganismSpecies, OrganismSpecies] {
    const gA = mutateGenome(parent);
    const gB = mutateGenome(parent);

    const splitM = rnd(0.47, 0.53);
    const splitE = rnd(0.47, 0.53);

    const baseA = expressPhenotype(gA, parent);
    const baseB = expressPhenotype(gB, parent);

    const childA: OrganismSpecies = {
      ...baseA,
      mass:       parent.mass   * splitM,
      energy:     parent.energy * splitE,
      damage:     parent.damage * 0.5,
      starvation: 0,
      cellCycle:  0,
    };

    const childB: OrganismSpecies = {
      ...baseB,
      mass:       parent.mass   * (1 - splitM),
      energy:     parent.energy * (1 - splitE),
      damage:     parent.damage * 0.5,
      starvation: 0,
      cellCycle:  0,
    };

    this.maybeSpeciate(parent, childA, gA, x, y);
    this.maybeSpeciate(parent, childB, gB, x, y);

    return [childA, childB];
  }

  // ---- Especiación (sin cambio de lógica respecto a Fase 0) ----

  private maybeSpeciate(
    parent: OrganismSpecies,
    child: OrganismSpecies,
    g: Genome,
    x: number, y: number
  ) {
    const metabolicFlip = g.metabolicType !== parent.metabolicType;
    if (metabolicFlip || this.shouldSpeciate(parent, g)) {
      const newId = this.createSpecies({
        tempOpt: g.tempOpt,
        attack: g.attack,
        divisionMass: g.divisionMass,
        mutationRate: g.mutationRate,
        parentSpeciesId: parent.speciesId,
      });
      child.speciesId = newId;
      child.founderId = newId;
      child.speciationMarkerTicks = 10;
      const zone = this.zoneForY(y);
      this.onNewSpecies?.({
        speciesId: newId,
        parentSpeciesId: parent.speciesId,
        founderTraits: {
          tempOpt: g.tempOpt,
          divisionMass: g.divisionMass,
          attack: g.attack,
          mutationRate: g.mutationRate,
        },
        zone, x, y,
      });
    }
  }

  private shouldSpeciate(parent: OrganismSpecies, g: Genome): boolean {
    let diff = 0;
    const mu = parent.mutationRate + this.baseMutationRate;

    // Umbrales al ~60% de la escala de mutación de cada rasgo
    if (Math.abs(g.tempOpt      - parent.tempOpt)      > 0.015) diff++;  // scale 0.025
    if (Math.abs(g.mutationRate - parent.mutationRate)  > 0.003) diff++;  // scale 0.006
    if (Math.abs(g.divisionMass - parent.divisionMass)  > 0.030) diff++;  // scale 0.05
    if (Math.abs(g.attack       - parent.attack)        > 0.025) diff++;  // scale 0.04

    if (diff === 0) return false;
    let baseP = diff === 1 ? 0.01 : diff === 2 ? 0.02 : 0.05;
    const mFactor = Math.min(2, 0.2 + mu * 10);
    return Math.random() < Math.min(0.9, baseP * mFactor);
  }

  // ---- Muerte ----

  private computeDeathHazard(org: OrganismSpecies, env: CellEnv): number {
    const expectedLon = 150;
    // Función sigmoide: hazard ≈ 0 en juventud, sube a partir de expectedLon
    const ageTerm     = 1 / (1 + Math.exp(-(org.age - expectedLon) / 30));
    const thermalPerf = thermalPerformance(env.temperature, org.tempOpt, org.tempBreadth);
    const thermalTerm = Math.max(0, 0.5 - thermalPerf);  // 0 si thermal≥0.5
    const toxTerm     = Math.min(1, env.waste * 0.2);
    return Math.min(0.4, 0.001 + ageTerm * 0.04 + thermalTerm * 0.03 + toxTerm * 0.1);
  }

  private shouldDie(org: OrganismSpecies, env: CellEnv): boolean {
    if (org.mass      <= 0.05) return true;
    if (org.energy    <  -0.3) return true;
    if (org.damage    >= 1.5)  return true;
    if (org.starvation > 2)    return true;
    return Math.random() < this.computeDeathHazard(org, env);
  }

  private onDeath(org: OrganismSpecies, env: CellEnv) {
    env.lastDeathTicks = 4;
    env.resource = Math.min(1, env.resource + org.mass * 0.35);
    env.waste    = Math.min(1, env.waste    + org.mass * 0.15);
  }

  // ---- Depredación ----

  private maybePredate(
    x: number, y: number,
    predator: OrganismSpecies,
    grid: CellStateSpecies[][]
  ) {
    if (predator.attack < ATTACK_THRESHOLD) return;
    if (predator.age < 15) return;
    if (predator.energy > predator.divisionMass * HUNGER_ENERGY) return;

    predator.energy -= 0.02; // coste de búsqueda

    const preyPos = this.choosePreyCandidate(x, y, predator, grid);
    if (!preyPos) return;

    const [px, py] = preyPos;
    const prey = grid[py][px].org;
    if (!prey) return;

    const successProb = clamp(
      0.15 + 0.45 * predator.attack - 0.30 * prey.defense
          + 0.10 * predator.motility - 0.10 * prey.motility,
      0, 1
    );

    if (Math.random() < successProb) {
      const gain = prey.mass * 0.7 * (0.35 + 0.35 * predator.attack);
      predator.energy += gain * 0.6;
      predator.mass   += gain * 0.2;
      grid[py][px].org = null;
      grid[py][px].env.lastEatenTicks = 5;
      grid[py][px].env.resource = Math.min(1, grid[py][px].env.resource + prey.mass * 0.15);
      grid[py][px].env.waste    = Math.min(1, grid[py][px].env.waste    + prey.mass * 0.10);
    } else {
      predator.damage += 0.03;
      prey.damage     += 0.01;
    }
  }

  private choosePreyCandidate(
    x: number, y: number,
    predator: OrganismSpecies,
    grid: CellStateSpecies[][]
  ): [number, number] | null {
    const candidates: Array<[number, number, number]> = [];

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= GRID_WIDTH || ny >= GRID_HEIGHT) continue;
        const prey = grid[ny][nx].org;
        if (!prey) continue;
        if (prey.speciesId === predator.speciesId) continue;  // sin canibalismo
        if ((this.speciesPopulation.get(prey.speciesId) ?? 0) < MIN_PREY_POP) continue;

        const score = (prey.mass * 0.6 + prey.energy * 0.4) / Math.max(0.1, prey.defense);
        if (score > 0.15) candidates.push([nx, ny, score]);
      }
    }

    if (candidates.length === 0) return null;
    const total = candidates.reduce((s, c) => s + c[2], 0);
    let r = Math.random() * total;
    for (const [cx, cy, sc] of candidates) {
      r -= sc;
      if (r <= 0) return [cx, cy];
    }
    return [candidates[0][0], candidates[0][1]];
  }

  // ---- Movimiento ----

  private maybeMove(
    x: number, y: number,
    org: OrganismSpecies,
    grid: CellStateSpecies[][]
  ): [number, number] | null {
    if (Math.random() > org.motility * 0.25) return null;

    const candidates: Array<[number, number]> = [];
    let bestScore = -Infinity;
    let best: [number, number] | null = null;

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= GRID_WIDTH || ny >= GRID_HEIGHT) continue;
        if (grid[ny][nx].org) continue;
        const env = grid[ny][nx].env;
        const thermal = thermalPerformance(env.temperature, org.tempOpt, org.tempBreadth);
        const score = env.resource * 0.5 + thermal * 0.4 - env.waste * 0.3;
        candidates.push([nx, ny]);
        if (score > bestScore) { bestScore = score; best = [nx, ny]; }
      }
    }

    if (!best || candidates.length === 0) return null;
    org.energy -= 0.005 + 0.015 * org.motility;
    return best;
  }

  // ---- Entorno ----

  step_env() { this.updateEnvironment(); }

  private updateEnvironment() {
    const dO2   = Array.from({ length: GRID_HEIGHT }, () => new Float32Array(GRID_WIDTH));
    const dCO2  = Array.from({ length: GRID_HEIGHT }, () => new Float32Array(GRID_WIDTH));
    const dRes  = Array.from({ length: GRID_HEIGHT }, () => new Float32Array(GRID_WIDTH));
    const dWaste= Array.from({ length: GRID_HEIGHT }, () => new Float32Array(GRID_WIDTH));

    for (let y = 0; y < GRID_HEIGHT; y++) {
      for (let x = 0; x < GRID_WIDTH; x++) {
        const cell = this.grid[y][x];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= GRID_WIDTH || ny >= GRID_HEIGHT) continue;
            const n = this.grid[ny][nx];
            dO2[y][x]   += GAS_DIFFUSION      * (n.env.o2       - cell.env.o2);
            dCO2[y][x]  += GAS_DIFFUSION      * (n.env.co2      - cell.env.co2);
            dRes[y][x]  += RESOURCE_DIFFUSION * (n.env.resource - cell.env.resource);
            dWaste[y][x]+= WASTE_DIFFUSION    * (n.env.waste    - cell.env.waste);
          }
        }
      }
    }

    for (let y = 0; y < GRID_HEIGHT; y++) {
      for (let x = 0; x < GRID_WIDTH; x++) {
        const env  = this.grid[y][x].env;
        const zone = env.zone as number;

        env.o2  = Math.max(0, Math.min(1, env.o2  + dO2[y][x]));
        env.co2 = Math.max(0, Math.min(1, env.co2 + dCO2[y][x]));

        if (x < GAS_BORDER_WIDTH) {
          env.o2 = Math.min(1, env.o2 + GAS_BORDER_REGEN);
        } else if (x < GRID_WIDTH / 2) {
          env.o2 = Math.min(1, env.o2 + GAS_ZONE_REGEN);
        }
        if (x >= GRID_WIDTH - GAS_BORDER_WIDTH) {
          env.co2 = Math.min(1, env.co2 + GAS_BORDER_REGEN);
        } else if (x >= GRID_WIDTH / 2) {
          env.co2 = Math.min(1, env.co2 + GAS_ZONE_REGEN);
        }

        // Recurso: difusión + regeneración por zona
        env.resource = Math.max(0, Math.min(1,
          env.resource + dRes[y][x] + this.zoneRegen[zone] * RESOURCE_REGEN_SCALE
        ));

        // Residuo: difusión + decaimiento natural
        env.waste = Math.max(0, Math.min(1,
          env.waste + dWaste[y][x] - env.waste * WASTE_DECAY
        ));

        env.temperature = this.getActualZoneTemp(env.zone);
        if (env.lastEatenTicks > 0) env.lastEatenTicks -= 1;
        if (env.lastDeathTicks > 0) env.lastDeathTicks -= 1;
      }
    }
  }

  // ---- Helpers de grid ----

  private initGrid() {
    const leftBound  = Math.floor(GRID_WIDTH / 3);
    const rightBound = Math.floor(2 * GRID_WIDTH / 3);

    for (let y = 0; y < GRID_HEIGHT; y++) {
      const row: CellStateSpecies[] = [];
      const zone    = this.zoneForY(y);
      const baseTemp = this.baseTempForZone(zone);

      for (let x = 0; x < GRID_WIDTH; x++) {
        let o2: number, co2: number;
        if (x < leftBound) {
          o2 = 0.9 + Math.random() * 0.1; co2 = 0;
        } else if (x < rightBound) {
          o2 = 0.4 + Math.random() * 0.4; co2 = 0.4 + Math.random() * 0.4;
        } else {
          o2 = 0; co2 = 0.9 + Math.random() * 0.1;
        }
        row.push({
          env: { temperature: baseTemp, o2, co2, resource: 0.8, waste: 0, zone, lastEatenTicks: 0, lastDeathTicks: 0 },
          org: null,
        });
      }
      this.grid.push(row);
    }
  }

  private findEmptyNeighbor(x: number, y: number, grid: CellStateSpecies[][]): [number, number] | null {
    const candidates: [number, number][] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= GRID_WIDTH || ny >= GRID_HEIGHT) continue;
        if (!grid[ny][nx].org) candidates.push([nx, ny]);
      }
    }
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  private zoneForY(y: number): ZoneId {
    if (y < GRID_HEIGHT / 3) return 0;
    if (y < (2 * GRID_HEIGHT) / 3) return 1;
    return 2;
  }

  private baseTempForZone(zone: ZoneId): number {
    return this.zoneBaseTemps[zone];
  }

  private createSpecies(traits: {
    tempOpt: number; attack: number; divisionMass: number;
    mutationRate: number; parentSpeciesId: number | null;
  }): number {
    const id  = this.speciesCounter++;
    const hue = (id * 157) % 360;
    this.speciesMap.set(id, { color: `hsl(${hue}, 90%, 50%)`, ...traits });
    return id;
  }

  // ---- API pública ----

  getActualZoneTemp(zone: ZoneId): number {
    const seasonal = this.seasonAmplitude * Math.sin(2 * Math.PI * this.tickCount / this.seasonPeriod);
    return this.zoneBaseTemps[zone] + seasonal;
  }

  getPopulation(): number {
    let n = 0;
    for (let y = 0; y < GRID_HEIGHT; y++)
      for (let x = 0; x < GRID_WIDTH; x++)
        if (this.grid[y][x].org) n++;
    return n;
  }

  getLiveSpeciesCount(): number {
    const seen = new Set<number>();
    for (let y = 0; y < GRID_HEIGHT; y++)
      for (let x = 0; x < GRID_WIDTH; x++) {
        const org = this.grid[y][x].org;
        if (org) seen.add(org.speciesId);
      }
    return seen.size;
  }

  getLiveSpeciesInfo(): Array<{
    id: number; color: string; tempOpt: number; attack: number;
    divisionMass: number; count: number; metabolicType: "aerobic" | "anaerobic";
  }> {
    const counts  = new Map<number, number>();
    const metTypes = new Map<number, "aerobic" | "anaerobic">();

    for (let y = 0; y < GRID_HEIGHT; y++)
      for (let x = 0; x < GRID_WIDTH; x++) {
        const org = this.grid[y][x].org;
        if (org) {
          counts.set(org.speciesId, (counts.get(org.speciesId) ?? 0) + 1);
          if (!metTypes.has(org.speciesId)) metTypes.set(org.speciesId, org.metabolicType);
        }
      }

    const result: Array<{
      id: number; color: string; tempOpt: number; attack: number;
      divisionMass: number; count: number; metabolicType: "aerobic" | "anaerobic";
    }> = [];

    for (const [id, info] of this.speciesMap) {
      const count = counts.get(id);
      if (count) result.push({
        id, color: info.color, tempOpt: info.tempOpt,
        attack: info.attack, divisionMass: info.divisionMass,
        count, metabolicType: metTypes.get(id) ?? "aerobic",
      });
    }
    result.sort((a, b) => a.id - b.id);
    return result;
  }

  getTraitStats() {
    const temps: number[] = [];
    for (let y = 0; y < GRID_HEIGHT; y++)
      for (let x = 0; x < GRID_WIDTH; x++) {
        const org = this.grid[y][x].org;
        if (org) temps.push(org.tempOpt);
      }
    const m = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : 0;
    return { tempMean: m, tempStd: 0, maxAgeMean: 0, count: temps.length };
  }
}
