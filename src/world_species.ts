// src/world_species.ts
import { GRID_WIDTH, GRID_HEIGHT } from "./types";
import type { CellStateSpecies, OrganismSpecies, ZoneId } from "./types";

const GAS_DIFFUSION = 0.05;    // fracción por tick entre celdas vecinas (0.05×8=0.4 < 1, estable)
const GAS_PRODUCE_RATIO = 0.8; // fracción del gas consumido que se convierte en el gas opuesto
const GAS_BORDER_REGEN = 0.3;  // reposición por tick en columnas de borde
const GAS_BORDER_WIDTH = 5;    // columnas de borde que actúan como fuente
const GAS_ZONE_REGEN = 0.008;  // regeneración distribuida en toda la zona (no solo borde)

export class WorldSpecies {
  readonly worldType = "AEROBIC_WORLD";

  grid: CellStateSpecies[][];
  tickCount = 0;
  zoneBaseTemps: number[] = [0.2, 0.5, 0.7]; // 0–1
  zoneRegen: number[] = [0.018, 0.030, 0.008]; // ya no se usa para gases, pero se mantiene por la UI

  predatorThreshold = 0.3;

  reproThreshold = 1.2;
  reproCost = 0.9;
  reproChildEnergy = 0.5;
  reproCooldown = 4;

  tempStressIntensity = 0.09;
  baseMutationRate = 0.02;

  // Estaciones
  seasonPeriod = 1000;
  seasonAmplitude = 0.06;

  // Especies
  speciesCounter = 1;
  speciesMap = new Map<number, { color: string; tempOpt: number; maxAge: number; predationIndex: number; mutationRate: number; parentSpeciesId: number | null }>();

  onNewSpecies?: (event: {
    speciesId: number; parentSpeciesId: number | null;
    founderTraits: { tempOpt: number; maxAge: number; predationIndex: number; mutationRate: number };
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

    // Nace en la franja O2 pura (primer tercio), centro vertical
    const x = Math.floor(GRID_WIDTH / 6);
    const y = Math.floor(GRID_HEIGHT / 2);
    const cell = this.grid[y][x];
    const tempOpt = this.baseTempForZone(cell.env.zone);

    const baseSpecies = this.createSpecies({ tempOpt, maxAge: 80, predationIndex: 0.5, mutationRate: initialMutationRate, parentSpeciesId: null });

    // El ancestro nace en la franja de O2 puro como aeróbico
    cell.org = {
      energy: 1,
      age: 0,
      maxAge: 80,
      tempOpt,
      mutationRate: initialMutationRate,
      reproThreshold: this.reproThreshold,
      reproCooldown: 0,
      predationIndex: 0.5,
      metabolicType: "aerobic",
      speciesId: baseSpecies,
      founderId: baseSpecies,
    };
  }

  private updateOrganisms() {
    const newGrid = this.grid.map(row =>
      row.map(cell => ({
        ...cell,
        env: { ...cell.env },
        org: cell.org ? { ...cell.org } : null,
      }))
    );

    for (let y = 0; y < GRID_HEIGHT; y++) {
      for (let x = 0; x < GRID_WIDTH; x++) {
        const cell = this.grid[y][x];
        const org = cell.org;
        if (!org) continue;

        const newCell = newGrid[y][x];
        let newOrg = newCell.org;
        if (!newOrg) continue;

        // 1) edad
        newOrg.age += 1;

        // marcador especiación
        if (newOrg.speciationMarkerTicks && newOrg.speciationMarkerTicks > 0) {
          newOrg.speciationMarkerTicks -= 1;
        }

        // 2) coste basal + coste metabólico por capacidad depredadora
        newOrg.energy -= 0.01 + newOrg.predationIndex * 0.015;

        // 3) estrés térmico
        const tempDiff = Math.abs(cell.env.temperature - newOrg.tempOpt);
        const tempPenalty = tempDiff * tempDiff * this.tempStressIntensity;
        newOrg.energy -= tempPenalty;
        const tempGainFactor = Math.max(0.05, 1 - tempDiff * this.tempStressIntensity * 15);

        // 4) metabolismo gaseoso: consume su gas, produce el opuesto
        const isAerobic = newOrg.metabolicType === "aerobic";
        const gasAvail = isAerobic ? newCell.env.o2 : newCell.env.co2;
        const consumed = Math.min(gasAvail, 0.02);  // consumo de gas por tick
        if (isAerobic) {
          newCell.env.o2 = Math.max(0, newCell.env.o2 - consumed);
          newCell.env.co2 = Math.min(1, newCell.env.co2 + consumed * GAS_PRODUCE_RATIO);
        } else {
          newCell.env.co2 = Math.max(0, newCell.env.co2 - consumed);
          newCell.env.o2 = Math.min(1, newCell.env.o2 + consumed * GAS_PRODUCE_RATIO);
        }
        newOrg.energy += consumed * tempGainFactor;

        // 5) muerte
        if (newOrg.energy <= 0 || newOrg.age > newOrg.maxAge) {
          newCell.org = null;
          continue;
        }

        newOrg = newCell.org;
        if (!newOrg) continue;

        // 6) cooldown reproducción
        if (newOrg.reproCooldown && newOrg.reproCooldown > 0) {
          newOrg.reproCooldown -= 1;
        }

        // 7) predación
        const hungerThreshold = 1.3;
        if (newOrg.predationIndex > this.predatorThreshold && newOrg.energy < hungerThreshold) {
          const victimPos = this.findPreyWithPolicy(x, y, newGrid, newOrg);
          if (victimPos) {
            const [vx, vy] = victimPos;
            const victimCell = newGrid[vy][vx];
            const victim = victimCell.org;
            if (victim) {
              const escapeChance = victim.predationIndex * 0.6;
              if (Math.random() < escapeChance) {
                // la presa escapa
              } else {
                const efficiency = 0.4 + newOrg.predationIndex * 0.5;
                newOrg.energy += victim.energy * efficiency * tempGainFactor;
                victimCell.org = null;
                victimCell.env.lastEatenTicks = 5;
              }
            }
          }
        }

        // 8) reproducción — bloqueada si no hay gas suficiente
        const gasForRepro = isAerobic ? newCell.env.o2 : newCell.env.co2;
        const effectiveReproThreshold = this.reproThreshold + tempDiff * this.tempStressIntensity * 15;
        const canReproduce =
          newOrg.energy > effectiveReproThreshold &&
          (newOrg.reproCooldown ?? 0) <= 0 &&
          newOrg.age > 5 &&
          gasForRepro > 0.05;

        if (canReproduce) {
          const maxLitter =
            newOrg.energy > this.reproThreshold * 3 ? 3 :
            newOrg.energy > this.reproThreshold * 2 ? 2 : 1;
          let placed = 0;
          while (placed < maxLitter && newOrg.energy > this.reproCost) {
            const pos = this.findEmptyNeighbor(x, y, newGrid);
            if (!pos) break;
            const [nx, ny] = pos;
            const child = this.mutateOrganism(newOrg, nx, ny);
            child.energy = this.reproChildEnergy;
            newOrg.energy -= this.reproCost;
            newGrid[ny][nx].org = child;
            placed++;
          }
          if (placed > 0) newOrg.reproCooldown = this.reproCooldown;
        }
      }
    }

    this.grid = newGrid;
  }

  private mutateOrganism(parent: OrganismSpecies, x: number, y: number): OrganismSpecies {
    const r = parent.mutationRate + this.baseMutationRate;
    const jitter = (v: number, scale: number) =>
      v + (Math.random() * 2 - 1) * scale * r;

    // Posible cambio de tipo metabólico (baja probabilidad)
    const metabolicFlip = Math.random() < r * 0.3;
    const metabolicType = metabolicFlip
      ? (parent.metabolicType === "aerobic" ? "anaerobic" : "aerobic")
      : parent.metabolicType;

    let child: OrganismSpecies = {
      energy: parent.energy,
      age: 0,
      maxAge: Math.max(20, Math.round(jitter(parent.maxAge, 10))),
      tempOpt: Math.max(0, Math.min(1, jitter(parent.tempOpt, 0.1))),
      mutationRate: Math.max(0.001, Math.min(0.3, jitter(parent.mutationRate, 0.6))),
      reproThreshold: Math.max(0.5, jitter(parent.reproThreshold, 0.4)),
      reproCooldown: 0,
      predationIndex: Math.max(0, Math.min(1, jitter(parent.predationIndex, 0.6))),
      metabolicType,
      speciesId: parent.speciesId,
      founderId: parent.founderId,
    };

    // El flip metabólico siempre especiará
    if (metabolicFlip || this.shouldSpeciate(parent, child)) {
      const newSpeciesId = this.createSpecies({
        tempOpt: child.tempOpt,
        maxAge: child.maxAge,
        predationIndex: child.predationIndex,
        mutationRate: child.mutationRate,
        parentSpeciesId: parent.speciesId,
      });
      child = { ...child, speciesId: newSpeciesId, founderId: newSpeciesId, speciationMarkerTicks: 10 };
      const zone = this.zoneForY(y);
      this.onNewSpecies?.({
        speciesId: newSpeciesId,
        parentSpeciesId: parent.speciesId,
        founderTraits: { tempOpt: child.tempOpt, maxAge: child.maxAge, predationIndex: child.predationIndex, mutationRate: child.mutationRate },
        zone, x, y,
      });
    }

    return child;
  }

  private shouldSpeciate(parent: OrganismSpecies, child: OrganismSpecies): boolean {
    let diffCount = 0;
    const m = parent.mutationRate + this.baseMutationRate;

    if (Math.abs(child.tempOpt - parent.tempOpt) > 0.003) diffCount++;
    if (Math.abs(child.mutationRate - parent.mutationRate) > 0.0005) diffCount++;
    if (Math.abs(child.maxAge - parent.maxAge) > 1.5) diffCount++;
    if (Math.abs(child.reproThreshold - parent.reproThreshold) > 0.03) diffCount++;

    if (diffCount === 0) return false;

    let baseP = 0;
    if (diffCount === 1) baseP = 0.02;
    else if (diffCount === 2) baseP = 0.06;
    else baseP = 0.15;

    const mFactor = Math.min(2, 0.2 + m * 10);
    const p = Math.min(0.9, baseP * mFactor);
    return Math.random() < p;
  }

  private findPreyWithPolicy(
    x: number, y: number,
    grid: CellStateSpecies[][],
    predator: OrganismSpecies
  ): [number, number] | null {
    const candidates: [number, number][] = [];
    const factor = 0.3 + (2 - 0.3) * predator.predationIndex;

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= GRID_WIDTH || ny >= GRID_HEIGHT) continue;
        const prey = grid[ny][nx].org;
        if (!prey || prey.speciesId === predator.speciesId) continue;
        if (prey.energy <= predator.energy * factor) candidates.push([nx, ny]);
      }
    }
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  private initGrid() {
    // Columnas de gas: izquierda O2, centro mixto, derecha CO2
    const leftBound = Math.floor(GRID_WIDTH / 3);
    const rightBound = Math.floor(2 * GRID_WIDTH / 3);

    for (let y = 0; y < GRID_HEIGHT; y++) {
      const row: CellStateSpecies[] = [];
      const zone = this.zoneForY(y);
      const baseTemp = this.baseTempForZone(zone);
      for (let x = 0; x < GRID_WIDTH; x++) {
        let o2: number, co2: number;
        if (x < leftBound) {
          o2 = 0.8 + Math.random() * 0.2;
          co2 = 0;
        } else if (x < rightBound) {
          o2 = 0.4 + Math.random() * 0.2;
          co2 = 0.4 + Math.random() * 0.2;
        } else {
          o2 = 0;
          co2 = 0.8 + Math.random() * 0.2;
        }
        row.push({
          env: { temperature: baseTemp, o2, co2, zone, lastEatenTicks: 0 },
          org: null,
        });
      }
      this.grid.push(row);
    }
  }

  private zoneForY(y: number): ZoneId {
    const h = GRID_HEIGHT;
    if (y < h / 3) return 0;
    if (y < (2 * h) / 3) return 1;
    return 2;
  }

  private baseTempForZone(zone: ZoneId): number {
    return this.zoneBaseTemps[zone];
  }

  private createSpecies(traits: { tempOpt: number; maxAge: number; predationIndex: number; mutationRate: number; parentSpeciesId: number | null }): number {
    const id = this.speciesCounter++;
    const hue = (id * 157) % 360;
    const color = `hsl(${hue}, 90%, 50%)`;
    this.speciesMap.set(id, { color, ...traits });
    return id;
  }

  getLiveSpeciesInfo(): Array<{ id: number; color: string; tempOpt: number; maxAge: number; predationIndex: number; count: number; metabolicType: "aerobic" | "anaerobic" }> {
    const counts = new Map<number, number>();
    const metabolicTypes = new Map<number, "aerobic" | "anaerobic">();
    for (let y = 0; y < GRID_HEIGHT; y++) {
      for (let x = 0; x < GRID_WIDTH; x++) {
        const org = this.grid[y][x].org;
        if (org) {
          counts.set(org.speciesId, (counts.get(org.speciesId) ?? 0) + 1);
          if (!metabolicTypes.has(org.speciesId)) metabolicTypes.set(org.speciesId, org.metabolicType);
        }
      }
    }
    const result: Array<{ id: number; color: string; tempOpt: number; maxAge: number; predationIndex: number; count: number; metabolicType: "aerobic" | "anaerobic" }> = [];
    for (const [id, info] of this.speciesMap) {
      const count = counts.get(id);
      if (count) result.push({ id, ...info, count, metabolicType: metabolicTypes.get(id) ?? "aerobic" });
    }
    result.sort((a, b) => a.id - b.id);
    return result;
  }

  step() {
    this.tickCount++;
    this.updateEnvironment();
    this.updateOrganisms();
  }

  getActualZoneTemp(zone: ZoneId): number {
    const seasonal = this.seasonAmplitude * Math.sin(2 * Math.PI * this.tickCount / this.seasonPeriod);
    return this.zoneBaseTemps[zone] + seasonal;
  }

  private updateEnvironment() {
    // Difusión de gases entre celdas vecinas
    const dO2 = Array.from({ length: GRID_HEIGHT }, () => new Float32Array(GRID_WIDTH));
    const dCO2 = Array.from({ length: GRID_HEIGHT }, () => new Float32Array(GRID_WIDTH));

    for (let y = 0; y < GRID_HEIGHT; y++) {
      for (let x = 0; x < GRID_WIDTH; x++) {
        const cell = this.grid[y][x];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= GRID_WIDTH || ny >= GRID_HEIGHT) continue;
            const n = this.grid[ny][nx];
            dO2[y][x]  += GAS_DIFFUSION * (n.env.o2  - cell.env.o2);
            dCO2[y][x] += GAS_DIFFUSION * (n.env.co2 - cell.env.co2);
          }
        }
      }
    }

    for (let y = 0; y < GRID_HEIGHT; y++) {
      for (let x = 0; x < GRID_WIDTH; x++) {
        const env = this.grid[y][x].env;
        env.o2  = Math.max(0, Math.min(1, env.o2  + dO2[y][x]));
        env.co2 = Math.max(0, Math.min(1, env.co2 + dCO2[y][x]));

        // Reposición en bordes: izquierda genera O2, derecha genera CO2
        if (x < GAS_BORDER_WIDTH) {
          env.o2 = Math.min(1, env.o2 + GAS_BORDER_REGEN);
        } else if (x < GRID_WIDTH / 2) {
          // Zona O2: regeneración distribuida suave
          env.o2 = Math.min(1, env.o2 + GAS_ZONE_REGEN);
        }
        if (x >= GRID_WIDTH - GAS_BORDER_WIDTH) {
          env.co2 = Math.min(1, env.co2 + GAS_BORDER_REGEN);
        } else if (x >= GRID_WIDTH / 2) {
          // Zona CO2: regeneración distribuida suave
          env.co2 = Math.min(1, env.co2 + GAS_ZONE_REGEN);
        }

        env.temperature = this.getActualZoneTemp(env.zone);
        if (env.lastEatenTicks > 0) env.lastEatenTicks -= 1;
      }
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

  getTraitStats() {
    const temps: number[] = [];
    const agesMax: number[] = [];
    for (let y = 0; y < GRID_HEIGHT; y++) {
      for (let x = 0; x < GRID_WIDTH; x++) {
        const org = this.grid[y][x].org;
        if (!org) continue;
        temps.push(org.tempOpt);
        agesMax.push(org.maxAge);
      }
    }
    const tempStats = meanAndStd(temps);
    const ageStats = meanAndStd(agesMax);
    return { tempMean: tempStats.mean, tempStd: tempStats.std, maxAgeMean: ageStats.mean, count: temps.length };
  }

  getPopulation(): number {
    let count = 0;
    for (let y = 0; y < GRID_HEIGHT; y++)
      for (let x = 0; x < GRID_WIDTH; x++)
        if (this.grid[y][x].org) count++;
    return count;
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
}

function meanAndStd(values: number[]): { mean: number; std: number } {
  if (values.length === 0) return { mean: 0, std: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  if (values.length === 1) return { mean, std: 0 };
  const variance = values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (values.length - 1);
  return { mean, std: Math.sqrt(variance) };
}
