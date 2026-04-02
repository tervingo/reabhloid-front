// src/world_species.ts
import { GRID_WIDTH, GRID_HEIGHT } from "./types";
import type { CellStateSpecies, OrganismSpecies, ZoneId } from "./types";

export class WorldSpecies {
  grid: CellStateSpecies[][];
  tickCount = 0;
  zoneBaseTemps: number[] = [0.2, 0.5, 0.7]; // 0–1
  zoneRegen: number[] = [0.018, 0.030, 0.008];

  predatorThreshold = 0.3;  // pIndex por encima del cual el organismo intenta cazar

  reproThreshold = 1.2;
  reproCost = 0.9;
  reproChildEnergy = 0.5;
  reproCooldown = 4;

  tempStressIntensity = 0.1;

  // Estaciones
  seasonPeriod = 300;    // ticks por ciclo completo
  seasonAmplitude = 0.12; // ±6 ºC en escala 0-1

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
    this.initGrid();             // SOLO crea ambiente, sin organismos
  }

  private resetGridEmpty() {
    this.grid = [];
    this.initGrid();
    this.tickCount = 0;
  }

  seedSingleAncestor(initialMutationRate: number) {
    this.resetGridEmpty();

    const x = Math.floor(GRID_WIDTH / 2);
    const y = Math.floor(GRID_HEIGHT / 2);
    const cell = this.grid[y][x];
    const tempOpt = this.baseTempForZone(cell.env.zone);

    const baseSpecies = this.createSpecies({ tempOpt, maxAge: 80, predationIndex: 0.5, mutationRate: initialMutationRate, parentSpeciesId: null });

    cell.org = {
      energy: 1,
      age: 0,
      maxAge: 80,
      tempOpt,
      mutationRate: initialMutationRate,
      reproThreshold: this.reproThreshold,
      reproCooldown: 0,
      predationIndex: 0.5,
      speciesId: baseSpecies,
      founderId: baseSpecies,
      // speciationMarkerTicks opcionalmente 0/undefined
    };
  }

  private updateOrganisms() {
    const newGrid = this.grid.map(row =>
      row.map(cell => ({
        ...cell,
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

        // 4) comer
        const eaten = Math.min(cell.env.nutrient, 0.2);
        newCell.env.nutrient -= eaten;
        newOrg.energy += eaten * 1.0;

        // 5) muerte
        if (newOrg.energy <= 0 || newOrg.age > newOrg.maxAge) {
          // reciclaje: muerte por vejez devuelve energía al suelo
          if (newOrg.energy > 0) {
            newCell.env.nutrient = Math.min(1, newCell.env.nutrient + newOrg.energy * 0.5);
          }
          newCell.org = null;
          continue;
        }

        newOrg = newCell.org;
        if (!newOrg) continue;

        // 6) cooldown reproducción
        if (newOrg.reproCooldown && newOrg.reproCooldown > 0) {
          newOrg.reproCooldown -= 1;
        }

        // 7) predación: activa si pIndex > umbral y tiene hambre
        const hungerThreshold = 1.3;
        if (newOrg.predationIndex > this.predatorThreshold && newOrg.energy < hungerThreshold) {
          const victimPos = this.findPreyWithPolicy(x, y, newGrid, newOrg);
          if (victimPos) {
            const [vx, vy] = victimPos;
            const victimCell = newGrid[vy][vx];
            const victim = victimCell.org;
            if (victim) {
              // 6) escape: probabilidad proporcional al pIndex de la presa
              const escapeChance = victim.predationIndex * 0.6;
              if (Math.random() < escapeChance) {
                // la presa escapa
              } else {
                const efficiency = 0.4 + newOrg.predationIndex * 0.5;
                newOrg.energy += victim.energy * efficiency;
                // restos de la presa vuelven al suelo
                victimCell.env.nutrient = Math.min(1, victimCell.env.nutrient + victim.energy * (1 - efficiency) * 0.4);
                victimCell.org = null;
                victimCell.env.lastEatenTicks = 5;
              }
            }
          }
        }
        // 8) reproducción con camada variable
        const canReproduce =
          newOrg.energy > this.reproThreshold &&
          (newOrg.reproCooldown ?? 0) <= 0 &&
          newOrg.age > 5;

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
    const r = parent.mutationRate;
    const jitter = (v: number, scale: number) =>
      v + (Math.random() * 2 - 1) * scale * r;

    let child: OrganismSpecies = {
      energy: parent.energy,
      age: 0,
      maxAge: Math.max(20, Math.round(jitter(parent.maxAge, 10))),
      tempOpt: Math.max(0, Math.min(1, jitter(parent.tempOpt, 0.1))),
      mutationRate: Math.max(0.001, Math.min(0.3, jitter(parent.mutationRate, 0.6))),
      reproThreshold: Math.max(0.5, jitter(parent.reproThreshold, 0.4)),
      reproCooldown: 0,
      predationIndex: Math.max(
        0,
        Math.min(1, jitter(parent.predationIndex, 0.6))
      ),
      speciesId: parent.speciesId,
      founderId: parent.founderId,
    };

    if (this.shouldSpeciate(parent, child)) {
      const newSpeciesId = this.createSpecies({ tempOpt: child.tempOpt, maxAge: child.maxAge, predationIndex: child.predationIndex, mutationRate: child.mutationRate, parentSpeciesId: parent.speciesId });
      child = {
        ...child,
        speciesId: newSpeciesId,
        founderId: newSpeciesId,
        speciationMarkerTicks: 10,
      };
      const zone = this.zoneForY(y);
      this.onNewSpecies?.({
        speciesId: newSpeciesId,
        parentSpeciesId: parent.speciesId,
        founderTraits: { tempOpt: child.tempOpt, maxAge: child.maxAge, predationIndex: child.predationIndex, mutationRate: child.mutationRate },
        zone,
        x,
        y,
      });
    }

    return child;
  }

  private shouldSpeciate(parent: OrganismSpecies, child: OrganismSpecies): boolean {
    let diffCount = 0;
    const m = parent.mutationRate;

    // umbrales muy bajos, acordes con jitter * M
    if (Math.abs(child.tempOpt - parent.tempOpt) > 0.003) diffCount++;
    if (Math.abs(child.mutationRate - parent.mutationRate) > 0.0005) diffCount++;
    if (Math.abs(child.maxAge - parent.maxAge) > 1.5) diffCount++;
    if (Math.abs(child.reproThreshold - parent.reproThreshold) > 0.03) diffCount++;

    // si quieres, puedes quitar por ahora el cambio de isPredator del criterio
    // if (child.isPredator !== parent.isPredator) diffCount++;

    if (diffCount > 0) {
      console.log("diffCount =", diffCount, "M =", m);
    }

    if (diffCount === 0) return false;

    // probabilidad base según diffCount
    let baseP = 0;
    if (diffCount === 1) baseP = 0.02;   // 2%
    else if (diffCount === 2) baseP = 0.06;
    else baseP = 0.15;

    // factor según M: M=0.02→0.4, M=0.05→0.75, M=0.1→1.25 (cap a 2)
    const mFactor = Math.min(2, 0.2 + m * 10);
    const p = Math.min(0.9, baseP * mFactor);

    return Math.random() < p;
  }

  private findPreyWithPolicy(
    x: number,
    y: number,
    grid: CellStateSpecies[][],
    predator: OrganismSpecies
  ): [number, number] | null {
    const candidates: [number, number][] = [];
    const pIndex = predator.predationIndex; // 0..1

    // factor según predationIndex: qué energía máxima tolera en la presa
    const minFactor = 0.3;  // pIndex = 0: solo mucho más débiles
    const maxFactor = 2;  // pIndex = 1: puede atacar algo más fuerte
    const factor = minFactor + (maxFactor - minFactor) * pIndex;

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= GRID_WIDTH || ny >= GRID_HEIGHT) continue;

        const prey = grid[ny][nx].org;
        if (!prey) continue;

        // misma especie: nunca es presa
        if (prey.speciesId === predator.speciesId) continue;

        if (prey.energy <= predator.energy * factor) {
          candidates.push([nx, ny]);
        }
      }
    }

    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }


  private initGrid() {
    for (let y = 0; y < GRID_HEIGHT; y++) {
      const row: CellStateSpecies[] = [];
      const zone = this.zoneForY(y);
      const baseTemp = this.baseTempForZone(zone);
      for (let x = 0; x < GRID_WIDTH; x++) {
        row.push({
          env: {
            temperature: baseTemp,
            nutrient: Math.random() * 1.0,
            zone,
            lastEatenTicks: 0,
          },
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

  getLiveSpeciesInfo(): Array<{ id: number; color: string; tempOpt: number; maxAge: number; predationIndex: number; count: number }> {
    const counts = new Map<number, number>();
    for (let y = 0; y < GRID_HEIGHT; y++) {
      for (let x = 0; x < GRID_WIDTH; x++) {
        const org = this.grid[y][x].org;
        if (org) counts.set(org.speciesId, (counts.get(org.speciesId) ?? 0) + 1);
      }
    }
    const result: Array<{ id: number; color: string; tempOpt: number; maxAge: number; predationIndex: number; count: number }> = [];
    for (const [id, info] of this.speciesMap) {
      const count = counts.get(id);
      if (count) result.push({ id, ...info, count });
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
    for (let y = 0; y < GRID_HEIGHT; y++) {
      for (let x = 0; x < GRID_WIDTH; x++) {
        const cell = this.grid[y][x];

        if (cell.env.lastEatenTicks && cell.env.lastEatenTicks > 0) {
          cell.env.lastEatenTicks -= 1;
        }

        cell.env.temperature = this.getActualZoneTemp(cell.env.zone);

        const regen = this.zoneRegen[cell.env.zone];
        cell.env.nutrient = Math.min(1, cell.env.nutrient + regen);
      }
    }
  }

  private findEmptyNeighbor(
    x: number,
    y: number,
    grid: CellStateSpecies[][]
  ): [number, number] | null {
    const candidates: [number, number][] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
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

    return {
      tempMean: tempStats.mean,
      tempStd: tempStats.std,
      maxAgeMean: ageStats.mean,
      count: temps.length,
    };
  }

  getPopulation(): number {
    let count = 0;
    for (let y = 0; y < GRID_HEIGHT; y++) {
      for (let x = 0; x < GRID_WIDTH; x++) {
        if (this.grid[y][x].org) count++;
      }
    }
    return count;
  }

  getLiveSpeciesCount(): number {
    const seen = new Set<number>();
    for (let y = 0; y < GRID_HEIGHT; y++) {
      for (let x = 0; x < GRID_WIDTH; x++) {
        const org = this.grid[y][x].org;
        if (org) seen.add(org.speciesId);
      }
    }
    return seen.size;
  }
}

// auxiliares
function meanAndStd(values: number[]): { mean: number; std: number } {
  if (values.length === 0) return { mean: 0, std: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  if (values.length === 1) return { mean, std: 0 };
  const variance =
    values.reduce((s, v) => s + (v - mean) * (v - mean), 0) /
    (values.length - 1);
  return { mean, std: Math.sqrt(variance) };
}