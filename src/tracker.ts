// src/tracker.ts
import type { WorldSpecies } from "./world_species";
import { GRID_HEIGHT } from "./types";

const API = import.meta.env.VITE_API_URL ?? "http://localhost:8000";
const SNAPSHOT_INTERVAL = 100;
const DOMINANCE_THRESHOLD = 0.8;
const MAX_TICKS = 50000;

export class RunTracker {
  private runId: string;
  private world: WorldSpecies;
  private lastSnapshotTick = -1;
  private active = false;

  constructor(world: WorldSpecies) {
    this.world = world;
    const now = new Date();
    this.runId = now.getFullYear().toString()
      + String(now.getMonth() + 1).padStart(2, "0")
      + String(now.getDate()).padStart(2, "0")
      + String(now.getHours()).padStart(2, "0")
      + String(now.getMinutes()).padStart(2, "0");
  }

  async startRun() {
    const w = this.world;
    await post(`/runs`, {
      run_id: this.runId,
      settings: {
        gridWidth: 50,
        gridHeight: 50,
        initialMutationRate: w.speciesMap.get(1)?.mutationRate ?? 0,
        reproThreshold: w.reproThreshold,
        seasonPeriod: w.seasonPeriod,
        seasonAmplitude: w.seasonAmplitude,
        zoneBaseTemps: [...w.zoneBaseTemps],
        zoneRegen: [...w.zoneRegen],
      },
    });

    // registrar especie fundadora
    const founder = w.speciesMap.get(1);
    if (founder) {
      await post(`/runs/${this.runId}/species`, {
        tick: 0,
        speciesId: 1,
        parentSpeciesId: null,
        founderTraits: {
          tempOpt: founder.tempOpt,
          maxAge: founder.maxAge,
          predationIndex: founder.predationIndex,
          mutationRate: founder.mutationRate,
        },
        zone: 1,
        x: 25,
        y: 25,
      });
    }

    // hook de especiación
    w.onNewSpecies = async (ev) => {
      await post(`/runs/${this.runId}/species`, {
        tick: w.tickCount,
        ...ev,
      });
    };

    this.active = true;
  }

  async onTick(): Promise<"continue" | "end_max" | "end_dominance" | "end_extinction"> {
    if (!this.active) return "continue";

    const tick = this.world.tickCount;

    // snapshot periódico
    if (tick - this.lastSnapshotTick >= SNAPSHOT_INTERVAL) {
      this.lastSnapshotTick = tick;
      await this.sendSnapshot(tick);
    }

    // condiciones de fin
    if (tick >= MAX_TICKS) return "end_max";

    const pop = this.world.getPopulation();
    if (pop === 0) return "end_extinction";

    const dominant = this.getDominantSpecies();
    if (dominant && dominant.fraction >= DOMINANCE_THRESHOLD) return "end_dominance";

    return "continue";
  }

  async endRun(reason: "max_ticks" | "extinction" | "dominance" | "manual") {
    if (!this.active) return;
    this.active = false;
    const dominant = this.getDominantSpecies();
    await post(`/runs/${this.runId}/end`, {
      tick: this.world.tickCount,
      reason,
      dominantSpeciesId: dominant?.speciesId ?? null,
    });
  }

  private async sendSnapshot(tick: number) {
    const speciesStats = this.computeSpeciesStats();
    if (speciesStats.length === 0) return;

    // detectar extinciones desde snapshot anterior
    await this.detectExtinctions(tick, speciesStats.map(s => s.speciesId));

    await post(`/runs/${this.runId}/snapshots`, { tick, species: speciesStats });
  }

  private lastLiveIds = new Set<number>();

  private async detectExtinctions(tick: number, currentIds: number[]) {
    const currentSet = new Set(currentIds);
    for (const id of this.lastLiveIds) {
      if (!currentSet.has(id)) {
        await post(`/runs/${this.runId}/extinctions`, {
          tick,
          speciesId: id,
          lastPopulation: 0,
        });
      }
    }
    this.lastLiveIds = currentSet;
  }

  private computeSpeciesStats() {
    const w = this.world;
    type Acc = { tempOpt: number[]; predIdx: number[]; mutRate: number[]; maxAge: number[]; energy: number[]; zone: number[] };
    const acc = new Map<number, Acc>();

    for (let y = 0; y < 50; y++) {
      for (let x = 0; x < 50; x++) {
        const org = w.grid[y][x].org;
        if (!org) continue;
        if (!acc.has(org.speciesId)) acc.set(org.speciesId, { tempOpt: [], predIdx: [], mutRate: [], maxAge: [], energy: [], zone: [] });
        const a = acc.get(org.speciesId)!;
        a.tempOpt.push(org.tempOpt);
        a.predIdx.push(org.predationIndex);
        a.mutRate.push(org.mutationRate);
        a.maxAge.push(org.maxAge);
        a.energy.push(org.energy);
        a.zone.push(Math.floor(y / (GRID_HEIGHT / 3)));
      }
    }

    return Array.from(acc.entries()).map(([speciesId, a]) => ({
      speciesId,
      population: a.tempOpt.length,
      meanTempOpt: mean(a.tempOpt),
      meanPredationIndex: mean(a.predIdx),
      meanMutationRate: mean(a.mutRate),
      meanMaxAge: mean(a.maxAge),
      meanEnergy: mean(a.energy),
      dominantZone: mode(a.zone),
      activePredators: a.predIdx.filter(p => p > w.predatorThreshold).length,
    }));
  }

  private getDominantSpecies(): { speciesId: number; fraction: number } | null {
    const stats = this.computeSpeciesStats();
    if (stats.length === 0) return null;
    const total = stats.reduce((s, sp) => s + sp.population, 0);
    if (total === 0) return null;
    const top = stats.reduce((a, b) => a.population > b.population ? a : b);
    return { speciesId: top.speciesId, fraction: top.population / total };
  }

  get id() { return this.runId; }
}

async function post(path: string, body: unknown) {
  try {
    await fetch(`${API}${path}`, {
      method: path.includes("/end") ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.warn("Tracker fetch error:", e);
  }
}

function mean(arr: number[]) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function mode(arr: number[]) {
  const freq = new Map<number, number>();
  for (const v of arr) freq.set(v, (freq.get(v) ?? 0) + 1);
  let best = arr[0];
  let bestN = 0;
  for (const [v, n] of freq) if (n > bestN) { best = v; bestN = n; }
  return best;
}
