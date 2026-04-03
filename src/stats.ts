// src/stats.ts
const API = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

const runsList = document.getElementById("runs-list") as HTMLDivElement;
const loading = document.getElementById("loading") as HTMLParagraphElement;
const chartSection = document.getElementById("chart-section") as HTMLDivElement;
const chartTitle = document.getElementById("chart-title") as HTMLHeadingElement;
const chartCanvas = document.getElementById("chart-canvas") as HTMLCanvasElement;
const chartLegend = document.getElementById("chart-legend") as HTMLDivElement;
const backBtn = document.getElementById("back-btn") as HTMLButtonElement;

const MIN_POPULATION_FOR_CHART = 50;

interface Run {
  id: string;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  endTick: number | null;
  dominantSpeciesId: number | null;
}

interface SpeciesSnapshot {
  speciesId: number;
  population: number;
}

interface Snapshot {
  tick: number;
  species: SpeciesSnapshot[];
}

async function loadRuns() {
  const res = await fetch(`${API}/runs`);
  const allRuns: Run[] = await res.json();

  // Filtrar runs sin ninguna especie que haya llegado a 50 individuos y borrarlos
  const validRuns: Run[] = [];
  for (const run of allRuns) {
    const snapsRes = await fetch(`${API}/runs/${run.id}/snapshots`);
    const snapshots: Snapshot[] = await snapsRes.json();
    const hasRelevant = snapshots.some(snap =>
      snap.species.some(sp => sp.population >= MIN_POPULATION_FOR_CHART)
    );
    if (hasRelevant) {
      validRuns.push(run);
    } else {
      await fetch(`${API}/runs/${run.id}`, { method: "DELETE" });
    }
  }

  loading.remove();
  renderRunList(validRuns);
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  // Sin opciones de timezone: usa la zona local del navegador
  return new Date(iso).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" });
}

const REASON_LABELS: Record<string, string> = {
  max_ticks: "Límite alcanzado",
  dominance: "Dominancia",
  extinction: "Extinción",
  manual: "Manual",
};

function renderRunList(runs: Run[]) {
  runsList.style.display = "block";
  chartSection.style.display = "none";
  backBtn.style.display = "none";
  runsList.innerHTML = "";

  if (runs.length === 0) {
    runsList.innerHTML = "<p>No hay runs registrados.</p>";
    return;
  }

  for (const run of runs) {
    const card = document.createElement("div");
    card.className = "run-card";

    const reason = run.endReason ? (REASON_LABELS[run.endReason] ?? run.endReason) : "—";
    const ticks = run.endTick != null ? `${run.endTick} ticks` : "—";
    const fin = run.endedAt ? formatDate(run.endedAt) : "—";

    card.innerHTML = `
      <div class="run-header">
        <strong>${run.id}</strong>
        <div class="run-actions">
          <button class="btn-view" data-id="${run.id}">Ver</button>
          <button class="btn-delete" data-id="${run.id}">Borrar</button>
        </div>
      </div>
      <div class="run-meta">
        Inicio: ${formatDate(run.startedAt)} &nbsp;|&nbsp;
        Fin: ${fin} &nbsp;|&nbsp;
        Razón: <em>${reason}</em> &nbsp;|&nbsp;
        Duración: ${ticks}
        ${run.dominantSpeciesId != null ? ` &nbsp;|&nbsp; Sp. dominante: #${run.dominantSpeciesId}` : ""}
      </div>
    `;

    card.querySelector(".btn-view")!.addEventListener("click", () => showChart(run));
    card.querySelector(".btn-delete")!.addEventListener("click", () => deleteRun(run.id, card));

    runsList.appendChild(card);
  }
}

async function deleteRun(runId: string, card: HTMLElement) {
  if (!confirm(`¿Borrar run ${runId} y todos sus datos?`)) return;
  await fetch(`${API}/runs/${runId}`, { method: "DELETE" });
  card.remove();
}

async function showChart(run: Run) {
  runsList.style.display = "none";
  chartSection.style.display = "block";
  backBtn.style.display = "inline-block";
  chartTitle.textContent = `Run ${run.id} — evolución de especies`;
  chartLegend.innerHTML = "";

  const ctx = chartCanvas.getContext("2d")!;
  ctx.clearRect(0, 0, chartCanvas.width, chartCanvas.height);
  ctx.fillStyle = "#888";
  ctx.font = "14px sans-serif";
  ctx.fillText("Cargando datos...", 20, 30);

  const res = await fetch(`${API}/runs/${run.id}/snapshots`);
  const snapshots: Snapshot[] = await res.json();

  drawChart(ctx, snapshots);
}

function drawChart(ctx: CanvasRenderingContext2D, snapshots: Snapshot[]) {
  const W = chartCanvas.width;
  const H = chartCanvas.height;
  const PAD = { top: 20, right: 20, bottom: 40, left: 60 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  // Calcular qué especies alguna vez tuvieron >= MIN_POPULATION_FOR_CHART
  const maxPopPerSpecies = new Map<number, number>();
  for (const snap of snapshots) {
    for (const sp of snap.species) {
      const prev = maxPopPerSpecies.get(sp.speciesId) ?? 0;
      if (sp.population > prev) maxPopPerSpecies.set(sp.speciesId, sp.population);
    }
  }
  const relevantIds = new Set(
    [...maxPopPerSpecies.entries()]
      .filter(([, max]) => max >= MIN_POPULATION_FOR_CHART)
      .map(([id]) => id)
  );

  if (relevantIds.size === 0) {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#aaa";
    ctx.font = "14px sans-serif";
    ctx.fillText("Ninguna especie alcanzó 50 individuos.", PAD.left, PAD.top + 20);
    return;
  }

  // Rangos
  const ticks = snapshots.map(s => s.tick);
  const minTick = ticks[0] ?? 0;
  const maxTick = ticks[ticks.length - 1] ?? 1;

  let maxPop = 0;
  for (const snap of snapshots) {
    for (const sp of snap.species) {
      if (relevantIds.has(sp.speciesId) && sp.population > maxPop) maxPop = sp.population;
    }
  }

  const scaleX = (t: number) => PAD.left + ((t - minTick) / (maxTick - minTick || 1)) * plotW;
  const scaleY = (p: number) => PAD.top + plotH - (p / (maxPop || 1)) * plotH;

  // Fondo
  ctx.clearRect(0, 0, W, H);

  // Grid horizontal
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1;
  const ySteps = 5;
  for (let i = 0; i <= ySteps; i++) {
    const p = (maxPop / ySteps) * i;
    const y = scaleY(p);
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(PAD.left + plotW, y);
    ctx.stroke();
    ctx.fillStyle = "#888";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(Math.round(p).toString(), PAD.left - 6, y + 4);
  }

  // Grid vertical
  const xSteps = Math.min(10, snapshots.length - 1);
  for (let i = 0; i <= xSteps; i++) {
    const t = minTick + ((maxTick - minTick) / xSteps) * i;
    const x = scaleX(t);
    ctx.beginPath();
    ctx.moveTo(x, PAD.top);
    ctx.lineTo(x, PAD.top + plotH);
    ctx.stroke();
    ctx.fillStyle = "#888";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(Math.round(t).toString(), x, PAD.top + plotH + 16);
  }

  // Ejes
  ctx.strokeStyle = "#666";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(PAD.left, PAD.top);
  ctx.lineTo(PAD.left, PAD.top + plotH);
  ctx.lineTo(PAD.left + plotW, PAD.top + plotH);
  ctx.stroke();

  // Etiquetas ejes
  ctx.fillStyle = "#aaa";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("tick", PAD.left + plotW / 2, H - 4);
  ctx.save();
  ctx.translate(14, PAD.top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("individuos", 0, 0);
  ctx.restore();

  // Paleta de colores para especies
  const palette = [
    "#4fc", "#f74", "#9df", "#fa4", "#c8f", "#7f4", "#f9c", "#4af",
    "#ff7", "#aff", "#f4a", "#7cf", "#fc7", "#c7f", "#7fc", "#f77",
  ];

  // Líneas por especie
  const sortedIds = [...relevantIds].sort((a, b) => a - b);
  sortedIds.forEach((spId, idx) => {
    const color = palette[idx % palette.length];
    const points: Array<[number, number]> = [];

    for (const snap of snapshots) {
      const entry = snap.species.find(s => s.speciesId === spId);
      if (entry) points.push([snap.tick, entry.population]);
    }

    if (points.length === 0) return;

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(scaleX(points[0][0]), scaleY(points[0][1]));
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(scaleX(points[i][0]), scaleY(points[i][1]));
    }
    ctx.stroke();

    // Leyenda
    const item = document.createElement("div");
    item.className = "legend-item";
    item.innerHTML = `
      <span class="legend-color" style="background:${color}"></span>
      <span>sp. #${spId}</span>
    `;
    chartLegend.appendChild(item);
  });
}

backBtn.addEventListener("click", () => {
  loadRuns();
});

loadRuns();
