// src/live_chart.ts

const CHART_MIN_POP = 20;  // umbral mínimo para mostrar una especie en la gráfica live

interface SpEntry {
  speciesId: number;
  population: number;
  color: string;
  metabolicType?: "aerobic" | "anaerobic";
}

interface HistoryPoint {
  tick: number;
  species: SpEntry[];
}

export class LiveChart {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private history: HistoryPoint[] = [];
  private colorMap = new Map<number, string>();
  private metabolicMap = new Map<number, "aerobic" | "anaerobic">();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
  }

  reset() {
    this.history = [];
    this.colorMap.clear();
    this.metabolicMap.clear();
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  addSnapshot(tick: number, species: SpEntry[]) {
    for (const sp of species) {
      if (!this.colorMap.has(sp.speciesId)) this.colorMap.set(sp.speciesId, sp.color);
      if (sp.metabolicType) this.metabolicMap.set(sp.speciesId, sp.metabolicType);
    }
    this.history.push({ tick, species });
    this.draw();
  }

  private getColor(spId: number): string {
    return this.colorMap.get(spId) ?? "#fff";
  }

  private draw() {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const PAD = { top: 16, right: 12, bottom: 36, left: 50 };
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const ctx = this.ctx;

    // Qué especies alcanzaron >= CHART_MIN_POP en algún punto
    const maxPopPerSpecies = new Map<number, number>();
    for (const pt of this.history) {
      for (const sp of pt.species) {
        const prev = maxPopPerSpecies.get(sp.speciesId) ?? 0;
        if (sp.population > prev) maxPopPerSpecies.set(sp.speciesId, sp.population);
      }
    }
    const relevantIds = new Set(
      [...maxPopPerSpecies.entries()]
        .filter(([, max]) => max >= CHART_MIN_POP)
        .map(([id]) => id)
    );

    // Rangos
    const minTick = this.history[0]?.tick ?? 0;
    const maxTick = this.history[this.history.length - 1]?.tick ?? 1;

    let maxPop = 0;
    for (const pt of this.history) {
      for (const sp of pt.species) {
        if (relevantIds.has(sp.speciesId) && sp.population > maxPop) maxPop = sp.population;
      }
    }
    if (maxPop === 0) maxPop = 1;

    const scaleX = (t: number) =>
      PAD.left + ((t - minTick) / (maxTick - minTick || 1)) * plotW;
    const scaleY = (p: number) =>
      PAD.top + plotH - (p / maxPop) * plotH;

    ctx.clearRect(0, 0, W, H);

    // Grid horizontal
    ctx.strokeStyle = "#2a2a2a";
    ctx.lineWidth = 1;
    const ySteps = 4;
    for (let i = 0; i <= ySteps; i++) {
      const p = (maxPop / ySteps) * i;
      const y = scaleY(p);
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(PAD.left + plotW, y);
      ctx.stroke();
      ctx.fillStyle = "#666";
      ctx.font = "10px monospace";
      ctx.textAlign = "right";
      ctx.fillText(Math.round(p).toString(), PAD.left - 4, y + 3);
    }

    // Grid vertical (máx 6 marcas)
    const xSteps = Math.min(6, this.history.length - 1);
    if (xSteps > 0) {
      for (let i = 0; i <= xSteps; i++) {
        const t = minTick + ((maxTick - minTick) / xSteps) * i;
        const x = scaleX(t);
        ctx.beginPath();
        ctx.moveTo(x, PAD.top);
        ctx.lineTo(x, PAD.top + plotH);
        ctx.stroke();
        ctx.fillStyle = "#666";
        ctx.font = "10px monospace";
        ctx.textAlign = "center";
        ctx.fillText(Math.round(t).toString(), x, PAD.top + plotH + 14);
      }
    }

    // Ejes
    ctx.strokeStyle = "#555";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(PAD.left, PAD.top);
    ctx.lineTo(PAD.left, PAD.top + plotH);
    ctx.lineTo(PAD.left + plotW, PAD.top + plotH);
    ctx.stroke();

    // Líneas por especie
    for (const spId of relevantIds) {
      const color = this.getColor(spId);
      const points: Array<[number, number]> = [];
      for (const pt of this.history) {
        const entry = pt.species.find(s => s.speciesId === spId);
        if (entry) points.push([pt.tick, entry.population]);
      }
      if (points.length === 0) continue;

      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(this.metabolicMap.get(spId) === "anaerobic" ? [4, 3] : []);
      ctx.beginPath();
      ctx.moveTo(scaleX(points[0][0]), scaleY(points[0][1]));
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(scaleX(points[i][0]), scaleY(points[i][1]));
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Etiqueta tick actual
    ctx.fillStyle = "#888";
    ctx.font = "10px monospace";
    ctx.textAlign = "left";
    ctx.fillText(`tick ${maxTick}`, PAD.left + 2, PAD.top - 4);
  }
}
