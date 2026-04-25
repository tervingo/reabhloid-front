// src/stats.ts
const API = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

const runsList = document.getElementById("runs-list") as HTMLDivElement;
const loading = document.getElementById("loading") as HTMLParagraphElement;
const chartSection = document.getElementById("chart-section") as HTMLDivElement;
const chartTitle = document.getElementById("chart-title") as HTMLHeadingElement;
const chartCanvas = document.getElementById("chart-canvas") as HTMLCanvasElement;
const chartLegend = document.getElementById("chart-legend") as HTMLDivElement;
const backBtn = document.getElementById("back-btn") as HTMLButtonElement;
const runSettingsDiv = document.getElementById("run-settings") as HTMLDivElement;
const boardCanvas = document.getElementById("board-canvas") as HTMLCanvasElement;

const MIN_POPULATION_FOR_CHART = 50;

// Tooltip div (creado una sola vez)
const tooltip = document.createElement("div");
tooltip.style.cssText = `
  position: fixed; display: none; pointer-events: none;
  background: rgba(20,20,20,0.93); border: 1px solid #555; border-radius: 5px;
  padding: 7px 10px; font-size: 12px; color: #eee; line-height: 1.6;
  white-space: nowrap; z-index: 100;
`;
document.body.appendChild(tooltip);

interface FinalCell {
  x: number;
  y: number;
  speciesId: number;
  energy: number;
  tempOpt: number;
  predationIndex: number;
}

interface RunSettings {
  zoneBaseTemps: number[];
  zoneRegen: number[];
  seasonPeriod: number;
  seasonAmplitude: number;
  tempStressIntensity: number;
  initialMutationRate: number;
  reproThreshold: number;
}

interface Run {
  id: string;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  endTick: number | null;
  dominantSpeciesId: number | null;
  comment: string;
  rating: number;  // 0 = sin valoración, 1-3 = estrellas
  worldType?: string;
  finalBoard?: FinalCell[];
  settings?: RunSettings;
}

interface SpeciesSnapshot {
  speciesId: number;
  population: number;
  meanTempOpt: number;
  meanPredationIndex: number;
  meanMutationRate: number;
  meanMaxAge: number;
  metabolicType?: "aerobic" | "anaerobic";
}

interface Snapshot {
  tick: number;
  species: SpeciesSnapshot[];
}

interface Marker {
  cx: number;
  cy: number;
  spId: number;
  color: string;
  isFirst: boolean;
  entry: SpeciesSnapshot;
  tick: number;
}

// Listener activo del canvas (para poder eliminarlo al redibujar)
let activeMouseHandler: ((e: MouseEvent) => void) | null = null;

async function loadRuns() {
  const res = await fetch(
    `${API}/runs?min_pop=${MIN_POPULATION_FOR_CHART}&cleanup=true`
  );
  const validRuns: Run[] = await res.json();
  loading.remove();
  renderRunList(validRuns);
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  // MongoDB omite la Z final — sin ella el navegador puede interpretar como local en vez de UTC
  const utc = iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z";
  return new Date(utc).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" });
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
  tooltip.style.display = "none";

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

    const starsDisplay = renderStars(run.rating);

    const worldBadge = run.worldType === "AEROBIC_WORLD_V2"
      ? `<span style="background:#1a3a4a;color:#7df;border:1px solid #7df;border-radius:3px;font-size:11px;padding:1px 6px;margin-left:8px">🌿 AERÓBICO v2</span>`
      : run.worldType === "AEROBIC_WORLD"
      ? `<span style="background:#1a4a2a;color:#4fc;border:1px solid #4fc;border-radius:3px;font-size:11px;padding:1px 6px;margin-left:8px">🌿 AERÓBICO</span>`
      : "";

    card.innerHTML = `
      <div class="run-header">
        <strong>${run.id}</strong>${worldBadge}
        <div class="run-actions">
          <button class="btn-view">Ver</button>
          <button class="btn-edit">Editar</button>
          <button class="btn-delete">Borrar</button>
        </div>
      </div>
      <div class="run-meta">
        Inicio: ${formatDate(run.startedAt)} &nbsp;|&nbsp;
        Fin: ${fin} &nbsp;|&nbsp;
        Razón: <em>${reason}</em> &nbsp;|&nbsp;
        Duración: ${ticks}
        ${run.dominantSpeciesId != null ? ` &nbsp;|&nbsp; Sp. dominante: #${run.dominantSpeciesId}` : ""}
      </div>
      <div class="run-extra">
        <span class="rating-display">${starsDisplay}</span>
        ${run.comment ? `<span class="run-comment" style="color:#aaa;font-size:12px;margin-left:8px">${escapeHtml(run.comment)}</span>` : ""}
      </div>
      <div class="edit-form">
        <textarea class="comment-input" placeholder="Comentario...">${escapeHtml(run.comment ?? "")}</textarea>
        <div class="stars">
          <span>Valoración:</span>
          ${[1,2,3].map(n => `<button class="star-btn ${(run.rating ?? 0) >= n ? "active" : ""}" data-star="${n}">★</button>`).join("")}
          <button class="star-btn clear-stars" title="Sin valoración">✕</button>
        </div>
        <div class="edit-actions">
          <button class="btn-save">Guardar</button>
          <button class="btn-cancel">Cancelar</button>
        </div>
      </div>
    `;

    card.querySelector(".btn-view")!.addEventListener("click", () => showChart(run));
    card.querySelector(".btn-delete")!.addEventListener("click", () => deleteRun(run.id, card));
    card.querySelector(".btn-edit")!.addEventListener("click", () => toggleEditForm(card));
    setupEditForm(card, run);

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
  chartTitle.textContent = `Run ${run.id} — evolución de especies${run.worldType === "AEROBIC_WORLD_V2" ? " 🌿 v2" : run.worldType === "AEROBIC_WORLD" ? " 🌿" : ""}`;
  chartLegend.innerHTML = "";
  runSettingsDiv.innerHTML = "";

  const ctx = chartCanvas.getContext("2d")!;
  ctx.clearRect(0, 0, chartCanvas.width, chartCanvas.height);
  ctx.fillStyle = "#888";
  ctx.font = "14px sans-serif";
  ctx.fillText("Cargando datos...", 20, 30);

  const [snapsRes, runRes] = await Promise.all([
    fetch(`${API}/runs/${run.id}/snapshots`),
    fetch(`${API}/runs/${run.id}`),
  ]);
  const snapshots: Snapshot[] = await snapsRes.json();
  const fullRun: Run = await runRes.json();

  if (fullRun.settings) renderSettings(fullRun.settings);
  drawChart(ctx, snapshots);
  drawFinalBoard(fullRun.finalBoard ?? []);
}

function drawFinalBoard(cells: FinalCell[]) {
  const GRID = 50;
  const CELL = boardCanvas.width / GRID;
  const ctx = boardCanvas.getContext("2d")!;
  ctx.clearRect(0, 0, boardCanvas.width, boardCanvas.height);

  if (cells.length === 0) {
    ctx.fillStyle = "#333";
    ctx.fillRect(0, 0, boardCanvas.width, boardCanvas.height);
    ctx.fillStyle = "#666";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("sin datos", boardCanvas.width / 2, boardCanvas.height / 2);
    return;
  }

  // Fondo con color de zona
  const zoneColors = ["#0a1a30", "#0a1f0a", "#2a0a0a"];
  for (let y = 0; y < GRID; y++) {
    const zone = y < Math.floor(GRID / 3) ? 0 : y < Math.floor(2 * GRID / 3) ? 1 : 2;
    ctx.fillStyle = zoneColors[zone];
    ctx.fillRect(0, y * CELL, boardCanvas.width, CELL);
  }

  // Organismos
  const PREDATOR_THRESHOLD = 0.3;
  for (const c of cells) {
    const hue = (c.speciesId * 157) % 360;
    ctx.fillStyle = `hsl(${hue}, 90%, 50%)`;
    ctx.fillRect(c.x * CELL, c.y * CELL, CELL, CELL);

    if (c.predationIndex > PREDATOR_THRESHOLD) {
      ctx.strokeStyle = "rgba(255,60,60,0.7)";
      ctx.lineWidth = CELL > 4 ? 1 : 0.5;
      ctx.strokeRect(c.x * CELL + 0.5, c.y * CELL + 0.5, CELL - 1, CELL - 1);
    }
  }
}

function renderSettings(s: RunSettings) {
  const t = s.zoneBaseTemps ?? [0, 0.5, 0.7];
  const r = s.zoneRegen ?? [0, 0, 0];
  const groups: Array<[string, string]> = [
    ["Zona 0 (fría)",       `${(t[0]*50).toFixed(1)} ºC · regen ${r[0].toFixed(3)}`],
    ["Zona 1 (templada)",   `${(t[1]*50).toFixed(1)} ºC · regen ${r[1].toFixed(3)}`],
    ["Zona 2 (caliente)",   `${(t[2]*50).toFixed(1)} ºC · regen ${r[2].toFixed(3)}`],
    ["Estaciones",          `periodo ${s.seasonPeriod ?? "—"} ticks · amplitud ±${((s.seasonAmplitude ?? 0)*50).toFixed(1)} ºC`],
    ["Estrés térmico",      (s.tempStressIntensity ?? 0).toFixed(2)],
    ["Mutación inicial",    (s.initialMutationRate ?? 0).toFixed(4)],
    ["Umbral reproducción", (s.reproThreshold ?? 0).toFixed(2)],
  ];
  runSettingsDiv.innerHTML = groups.map(([label, val]) => `
    <div class="setting-group">
      <span class="setting-label">${label}</span>
      <span class="setting-val">${val}</span>
    </div>
  `).join("");
}

function drawChart(ctx: CanvasRenderingContext2D, snapshots: Snapshot[]) {
  const W = chartCanvas.width;
  const H = chartCanvas.height;
  const PAD = { top: 20, right: 20, bottom: 40, left: 60 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  // Qué especies alguna vez tuvieron >= MIN_POPULATION_FOR_CHART
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

  const markers: Marker[] = [];
  const sortedIds = [...relevantIds].sort((a, b) => a - b);

  sortedIds.forEach((spId) => {
    const color = speciesColor(spId);

    // Recopilar todos los snapshots donde aparece esta especie
    const entries: Array<{ tick: number; entry: SpeciesSnapshot }> = [];
    for (const snap of snapshots) {
      const entry = snap.species.find(s => s.speciesId === spId);
      if (entry) entries.push({ tick: snap.tick, entry });
    }
    if (entries.length === 0) return;

    // Dibujar línea (dashed para anaeróbicas)
    const metabolicType = entries[0].entry.metabolicType ?? "aerobic";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.setLineDash(metabolicType === "anaerobic" ? [5, 4] : []);
    ctx.beginPath();
    ctx.moveTo(scaleX(entries[0].tick), scaleY(entries[0].entry.population));
    for (let i = 1; i < entries.length; i++) {
      ctx.lineTo(scaleX(entries[i].tick), scaleY(entries[i].entry.population));
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Marcador de primer tick
    const first = entries[0];
    markers.push({
      cx: scaleX(first.tick),
      cy: scaleY(first.entry.population),
      spId, color, isFirst: true,
      entry: first.entry,
      tick: first.tick,
    });

    // Marcador de último tick (solo si hay más de un punto y no es el mismo)
    const last = entries[entries.length - 1];
    if (last.tick !== first.tick) {
      markers.push({
        cx: scaleX(last.tick),
        cy: scaleY(last.entry.population),
        spId, color, isFirst: false,
        entry: last.entry,
        tick: last.tick,
      });
    }

    // Leyenda
    const item = document.createElement("div");
    item.className = "legend-item";
    item.innerHTML = `
      <span class="legend-color" style="background:${color}"></span>
      <span>sp. #${spId}</span>
    `;
    chartLegend.appendChild(item);
  });

  // Dibujar marcadores encima de las líneas
  const MARKER_R = 5;
  for (const m of markers) {
    ctx.beginPath();
    ctx.arc(m.cx, m.cy, MARKER_R, 0, Math.PI * 2);
    ctx.fillStyle = m.isFirst ? m.color : "#111";
    ctx.fill();
    ctx.strokeStyle = m.color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Reemplazar listener anterior
  if (activeMouseHandler) {
    chartCanvas.removeEventListener("mousemove", activeMouseHandler);
    chartCanvas.removeEventListener("mouseleave", activeMouseHandler);
  }

  activeMouseHandler = (e: MouseEvent) => {
    if (e.type === "mouseleave") {
      tooltip.style.display = "none";
      return;
    }
    const rect = chartCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Buscar marcador más cercano dentro de radio de detección
    const HIT_R = 10;
    let hit: Marker | null = null;
    let bestDist = HIT_R;
    for (const m of markers) {
      const d = Math.sqrt((mx - m.cx) ** 2 + (my - m.cy) ** 2);
      if (d < bestDist) { bestDist = d; hit = m; }
    }

    if (!hit) {
      tooltip.style.display = "none";
      return;
    }

    const sp = hit.entry;
    const label = hit.isFirst ? "Primer tick" : "Último tick";
    tooltip.innerHTML = `
      <strong style="color:${hit.color}">sp. #${hit.spId}</strong> — ${label} (tick ${hit.tick})<br>
      Población: ${sp.population}<br>
      TempOpt: ${(sp.meanTempOpt * 50).toFixed(1)} ºC<br>
      Depredación: ${sp.meanPredationIndex.toFixed(3)}<br>
      Mutación: ${sp.meanMutationRate.toFixed(4)}<br>
      maxAge: ${Math.round(sp.meanMaxAge)}
    `;
    tooltip.style.display = "block";
    tooltip.style.left = (e.clientX + 14) + "px";
    tooltip.style.top = (e.clientY - 10) + "px";
  };

  chartCanvas.addEventListener("mousemove", activeMouseHandler);
  chartCanvas.addEventListener("mouseleave", activeMouseHandler);
}

function speciesColor(speciesId: number): string {
  const hue = (speciesId * 157) % 360;
  return `hsl(${hue}, 90%, 50%)`;
}

function renderStars(rating: number): string {
  if (rating === 0) return "";
  return [1,2,3].map(n => `<span style="color:${n <= rating ? "#fc4" : "#444"};font-size:16px">★</span>`).join("");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function toggleEditForm(card: HTMLElement) {
  card.querySelector(".edit-form")!.classList.toggle("open");
}

function setupEditForm(card: HTMLElement, run: Run) {
  const form = card.querySelector(".edit-form")!;
  const starBtns = form.querySelectorAll<HTMLButtonElement>(".star-btn[data-star]");
  let currentRating = run.rating ?? 0;

  function updateStarDisplay() {
    starBtns.forEach(btn => {
      btn.classList.toggle("active", Number(btn.dataset.star) <= currentRating);
    });
  }

  starBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      currentRating = Number(btn.dataset.star);
      updateStarDisplay();
    });
  });

  form.querySelector(".clear-stars")!.addEventListener("click", () => {
    currentRating = 0;
    updateStarDisplay();
  });

  form.querySelector(".btn-cancel")!.addEventListener("click", () => {
    form.classList.remove("open");
  });

  form.querySelector(".btn-save")!.addEventListener("click", async () => {
    const comment = (form.querySelector(".comment-input") as HTMLTextAreaElement).value;
    await fetch(`${API}/runs/${run.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comment, rating: currentRating }),
    });
    run.comment = comment;
    run.rating = currentRating;
    // Actualizar visualización en la tarjeta sin recargar
    const ratingDisplay = card.querySelector(".rating-display")!;
    ratingDisplay.innerHTML = renderStars(currentRating);
    const commentSpan = card.querySelector(".run-comment");
    if (commentSpan) commentSpan.textContent = comment;
    else if (comment) {
      const extra = card.querySelector(".run-extra")!;
      const span = document.createElement("span");
      span.className = "run-comment";
      span.style.cssText = "color:#aaa;font-size:12px;margin-left:8px";
      span.textContent = comment;
      extra.appendChild(span);
    }
    form.classList.remove("open");
  });
}

backBtn.addEventListener("click", () => {
  tooltip.style.display = "none";
  loadRuns();
});

loadRuns();
