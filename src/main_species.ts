// src/main_species.ts
import { WorldSpecies } from "./world_species";
import { GRID_WIDTH, GRID_HEIGHT } from "./types";
import { RunTracker } from "./tracker";
import { LiveChart } from "./live_chart";

const canvas = document.getElementById("world") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

const zone0Input = document.getElementById("zone0Temp") as HTMLInputElement;
const zone1Input = document.getElementById("zone1Temp") as HTMLInputElement;
const zone2Input = document.getElementById("zone2Temp") as HTMLInputElement;

const zone0RegenInput = document.getElementById("zone0Regen") as HTMLInputElement;
const zone1RegenInput = document.getElementById("zone1Regen") as HTMLInputElement;
const zone2RegenInput = document.getElementById("zone2Regen") as HTMLInputElement;

const zone0Label = document.getElementById("zone0TempLabel") as HTMLSpanElement;
const zone1Label = document.getElementById("zone1TempLabel") as HTMLSpanElement;
const zone2Label = document.getElementById("zone2TempLabel") as HTMLSpanElement;

const zone0RegenLabel = document.getElementById("zone0RegenLabel") as HTMLSpanElement;
const zone1RegenLabel = document.getElementById("zone1RegenLabel") as HTMLSpanElement;
const zone2RegenLabel = document.getElementById("zone2RegenLabel") as HTMLSpanElement;

const tickDelayInput = document.getElementById("tickDelay") as HTMLInputElement;

/* const tickSpan = document.getElementById("tickValue") as HTMLSpanElement;
const popSpan = document.getElementById("popValue") as HTMLSpanElement;
const tempOptMeanSpan = document.getElementById("tempOptMean") as HTMLSpanElement;
const tempOptStdSpan = document.getElementById("tempOptStd") as HTMLSpanElement;
const maxAgeMeanSpan = document.getElementById("maxAgeMean") as HTMLSpanElement; */

const tempStressInput = document.getElementById("tempStress") as HTMLInputElement;
const tempStressLabel = document.getElementById("tempStressLabel") as HTMLSpanElement;

const speciesMInput = document.getElementById("speciesM") as HTMLInputElement;
const speciesMLabel = document.getElementById("speciesMLabel") as HTMLSpanElement;

const cellPosSpan = document.getElementById("cellPos") as HTMLSpanElement;
const cellZoneSpan = document.getElementById("cellZone") as HTMLSpanElement;
const cellAliveSpan = document.getElementById("cellAlive") as HTMLSpanElement;
const cellTempOptSpan = document.getElementById("cellTempOpt") as HTMLSpanElement;
const cellEnergySpan = document.getElementById("cellEnergy") as HTMLSpanElement;
const cellAgeSpan = document.getElementById("cellAge") as HTMLSpanElement;
const cellMaxAgeSpan = document.getElementById("cellMaxAge") as HTMLSpanElement;
const cellO2Span = document.getElementById("cellO2") as HTMLSpanElement;
const cellCO2Span = document.getElementById("cellCO2") as HTMLSpanElement;
const cellMetabolicSpan = document.getElementById("cellMetabolic") as HTMLSpanElement;
const cellSpeciesSpan = document.getElementById("cellSpecies") as HTMLSpanElement;
const cellPredationIndexSpan = document.getElementById("cellPredationIndex") as HTMLSpanElement;
const speciesListDiv = document.getElementById("speciesList") as HTMLDivElement;

const CELL_SIZE = canvas.width / GRID_WIDTH;
const INFO_BAR_HEIGHT = 40;
const CHART_INTERVAL = 100;

const liveChartCanvas = document.getElementById("live-chart") as HTMLCanvasElement;
const liveChart = new LiveChart(liveChartCanvas);

let world: WorldSpecies;
let tracker: RunTracker | null = null;
let lastTime = 0;
let accumulator = 0;
let tickDelay = Number(tickDelayInput.value);
let isRunning = false;
let simStatus = "en pausa";

const END_REASON_LABELS: Record<string, string> = {
  max_ticks:  "simulación finalizada · límite alcanzado",
  dominance:  "simulación finalizada · dominancia",
  extinction: "simulación finalizada · extinción",
  manual:     "simulación finalizada · manual",
};

tickDelayInput.addEventListener("input", () => {
  tickDelay = Number(tickDelayInput.value);
});

speciesMInput.addEventListener("input", () => {
  updateSpeciesMLabel();
});

function updateSliderLabels() {
  const r0 = (Number(zone0RegenInput.value) / 1000) * 2;
  const r1 = (Number(zone1RegenInput.value) / 1000) * 2;
  const r2 = (Number(zone2RegenInput.value) / 1000) * 2;
  zone0RegenLabel.textContent = r0.toFixed(3);
  zone1RegenLabel.textContent = r1.toFixed(3);
  zone2RegenLabel.textContent = r2.toFixed(3);

  tempStressLabel.textContent = (Number(tempStressInput.value) / 100).toFixed(2);
}

function updateInspectorFromMouse(event: MouseEvent) {
  const rect = canvas.getBoundingClientRect();
  const mx = event.clientX - rect.left;
  const my = event.clientY - rect.top;

  const myInGrid = my - INFO_BAR_HEIGHT;
  if (myInGrid < 0) {
    clearInspector();
    return;
  }

  const x = Math.floor(mx / CELL_SIZE);
  const y = Math.floor(myInGrid / CELL_SIZE);

  if (x < 0 || y < 0 || x >= GRID_WIDTH || y >= GRID_HEIGHT) {
    clearInspector();
    return;
  }

  const cell = world.grid[y][x];
  cellO2Span.textContent = cell.env.o2.toFixed(3);
  cellCO2Span.textContent = cell.env.co2.toFixed(3);
  cellPosSpan.textContent = `${x}, ${y}`;
  cellZoneSpan.textContent = cell.env.zone.toString();

  if (!cell.org) {
    cellAliveSpan.textContent = "no";
    cellTempOptSpan.textContent = "-";
    cellEnergySpan.textContent = "-";
    cellAgeSpan.textContent = "-";
    cellMaxAgeSpan.textContent = "-";
    cellMetabolicSpan.textContent = "-";
    if (cellSpeciesSpan) cellSpeciesSpan.textContent = "-";
    cellPredationIndexSpan.textContent = "-";
  } else {
    const org = cell.org;
    cellAliveSpan.textContent = "sí";
    cellTempOptSpan.textContent = (org.tempOpt * 50).toFixed(1) + " ºC";
    cellEnergySpan.textContent = org.energy.toFixed(2);
    cellAgeSpan.textContent = org.age.toString();
    const daysPerTick = 1 / 24;
    const maxAgeDays = org.maxAge * daysPerTick;
    cellMaxAgeSpan.textContent = `${org.maxAge} ticks (~${maxAgeDays.toFixed(1)} días)`;
    cellMetabolicSpan.textContent = org.metabolicType === "aerobic" ? "O₂→CO₂" : "CO₂→O₂";
    if (cellSpeciesSpan) cellSpeciesSpan.textContent = org.speciesId.toString();
    cellPredationIndexSpan.textContent = org.predationIndex.toFixed(2);
  }
}

function clearInspector() {
  cellPosSpan.textContent = "-";
  cellZoneSpan.textContent = "-";
  cellAliveSpan.textContent = "no";
  cellTempOptSpan.textContent = "-";
  cellEnergySpan.textContent = "-";
  cellAgeSpan.textContent = "-";
  cellMaxAgeSpan.textContent = "-";
  cellO2Span.textContent = "-";
  cellCO2Span.textContent = "-";
  cellMetabolicSpan.textContent = "-";
  if (cellSpeciesSpan) cellSpeciesSpan.textContent = "-";
  cellPredationIndexSpan.textContent = "-";
}

function updateParamsFromUI() {
  world.zoneRegen[0] = (Number(zone0RegenInput.value) / 1000) * 2;
  world.zoneRegen[1] = (Number(zone1RegenInput.value) / 1000) * 2;
  world.zoneRegen[2] = (Number(zone2RegenInput.value) / 1000) * 2;

  world.tempStressIntensity = Number(tempStressInput.value) / 100;

  updateSliderLabels();
}

function updateZoneTempsFromUI() {
  world.zoneBaseTemps[0] = Number(zone0Input.value) / 100;
  world.zoneBaseTemps[1] = Number(zone1Input.value) / 100;
  world.zoneBaseTemps[2] = Number(zone2Input.value) / 100;

  zone0Label.textContent = (world.zoneBaseTemps[0] * 50).toFixed(1);
  zone1Label.textContent = (world.zoneBaseTemps[1] * 50).toFixed(1);
  zone2Label.textContent = (world.zoneBaseTemps[2] * 50).toFixed(1);
}

function attachListeners() {
  [zone0Input, zone1Input, zone2Input].forEach(input => {
    input.addEventListener("input", () => {
      updateZoneTempsFromUI();
    });
  });
  [
    zone0RegenInput,
    zone1RegenInput,
    zone2RegenInput,
    tempStressInput,
  ].forEach(input => {
    input.addEventListener("input", () => {
      updateParamsFromUI();
    });
  });

  const startBtn = document.getElementById("start") as HTMLButtonElement;
  const restartBtn = document.getElementById("restart") as HTMLButtonElement;
  const pauseBtn = document.getElementById("pause") as HTMLButtonElement;
  const stepBtn = document.getElementById("step") as HTMLButtonElement;

  startBtn.addEventListener("click", () => {
    isRunning = true;
    simStatus = "simulación en curso";
    lastTime = performance.now();
  });

  pauseBtn.addEventListener("click", () => {
    isRunning = false;
    simStatus = "simulación en pausa";
    updateUIAndDraw();
  });

  restartBtn.addEventListener("click", async () => {
    await initWorld();
    updateUIAndDraw();
  });

  stepBtn.addEventListener("click", () => {
    isRunning = false;
    world.step();
    updateUIAndDraw();
  });

  canvas.addEventListener("mousemove", updateInspectorFromMouse);
  canvas.addEventListener("mouseleave", clearInspector);
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, canvas.width, INFO_BAR_HEIGHT);

  ctx.fillStyle = "#ffffff";
  ctx.font = "16px monospace";
  ctx.textBaseline = "middle";

  const tickText = `Tick: ${world.tickCount}`;
  const popText = `Pop: ${world.getPopulation()}`;
  const speciesCount = world.getLiveSpeciesCount();
  const speciesText = `Species: ${speciesCount}`;

  ctx.fillText(tickText, 6, INFO_BAR_HEIGHT / 2);
  ctx.fillText(popText, 150, INFO_BAR_HEIGHT / 2);
  ctx.fillText(speciesText, 300, INFO_BAR_HEIGHT / 2);

  const statusColor = simStatus.startsWith("simulación finalizada") ? "#f88" : simStatus === "simulación en curso" ? "#4fc" : "#fa4";
  ctx.fillStyle = statusColor;
  ctx.textAlign = "right";
  ctx.fillText(simStatus, canvas.width - 8, INFO_BAR_HEIGHT / 2);
  ctx.textAlign = "left";

  for (let y = 0; y < GRID_HEIGHT; y++) {
    for (let x = 0; x < GRID_WIDTH; x++) {
      const cell = world.grid[y][x];

      // Fondo: O2 → azul, CO2 → rojo, mezcla → interpolación
      const o2 = cell.env.o2;
      const co2 = cell.env.co2;
      // Base de zona para el brillo (fría/templada/cálida)
      const zoneDim = cell.env.zone === 0 ? 0.6 : cell.env.zone === 1 ? 0.8 : 1.0;
      const rBg = Math.round(Math.min(255, co2 * 160 * zoneDim));
      const gBg = Math.round(Math.min(255, (o2 + co2) * 30 * zoneDim));
      const bBg = Math.round(Math.min(255, o2 * 160 * zoneDim));

      ctx.fillStyle = `rgb(${rBg}, ${gBg}, ${bBg})`;
      ctx.fillRect(
        x * CELL_SIZE,
        INFO_BAR_HEIGHT + y * CELL_SIZE,
        CELL_SIZE,
        CELL_SIZE
      );

      if (cell.org) {
        const org = cell.org;
        const speciesInfo = world.speciesMap.get(org.speciesId);
        ctx.fillStyle = speciesInfo ? speciesInfo.color : "#ffffff";

        const ageRatio = org.maxAge > 0 ? org.age / org.maxAge : 0;
        const cx = x * CELL_SIZE + CELL_SIZE / 2;
        const cy = INFO_BAR_HEIGHT + y * CELL_SIZE + CELL_SIZE / 2;
        const size = CELL_SIZE * 0.35;

        if (org.age <= 10) {
          drawStar(ctx, cx, cy, size);
        } else if (ageRatio <= 0.33) {
          drawCircle(ctx, cx, cy, size);
        } else if (ageRatio <= 0.66) {
          drawSquare(ctx, cx, cy, size);
        } else if (ageRatio <= 0.9) {
          drawTriangle(ctx, cx, cy, size);
        } else {
          drawCross(ctx, cx, cy, size);
        }

        // Marcador metabólico: esquina superior izquierda
        // aerobic (O2→CO2): punto blanco; anaerobic (CO2→O2): cruz blanca
        {
          const mx = x * CELL_SIZE + 2;
          const my = INFO_BAR_HEIGHT + y * CELL_SIZE + 2;
          const ms = CELL_SIZE * 0.18;
          ctx.save();
          ctx.fillStyle = "#fff";
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 1;
          if (org.metabolicType === "aerobic") {
            ctx.beginPath();
            ctx.arc(mx + ms, my + ms, ms, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.beginPath();
            ctx.moveTo(mx, my + ms); ctx.lineTo(mx + ms * 2, my + ms);
            ctx.moveTo(mx + ms, my); ctx.lineTo(mx + ms, my + ms * 2);
            ctx.stroke();
          }
          ctx.restore();
        }

        if (org.speciationMarkerTicks && org.speciationMarkerTicks > 0) {
          const cx2 = x * CELL_SIZE + CELL_SIZE / 2;
          const cy2 = INFO_BAR_HEIGHT + y * CELL_SIZE + CELL_SIZE / 2;
          const size2 = CELL_SIZE * 0.4;

          ctx.save();
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(cx2 - size2, cy2);
          ctx.lineTo(cx2 + size2, cy2);
          ctx.moveTo(cx2, cy2 - size2);
          ctx.lineTo(cx2, cy2 + size2);
          ctx.stroke();
          ctx.restore();
        }

        if (org.predationIndex > world.predatorThreshold) {
          ctx.save();
          ctx.strokeStyle = "red";
          ctx.lineWidth = 1.5;
          ctx.strokeRect(
            x * CELL_SIZE + 1,
            INFO_BAR_HEIGHT + y * CELL_SIZE + 1,
            CELL_SIZE - 2,
            CELL_SIZE - 2
          );
          ctx.restore();
        }
      }

      if (!cell.org && cell.env.lastEatenTicks && cell.env.lastEatenTicks > 0) {
        const cx = x * CELL_SIZE + CELL_SIZE / 2;
        const cy = INFO_BAR_HEIGHT + y * CELL_SIZE + CELL_SIZE / 2;
        const size = CELL_SIZE * 0.35;

        ctx.save();
        ctx.strokeStyle = "orangeRed";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx - size, cy - size);
        ctx.lineTo(cx + size, cy + size);
        ctx.moveTo(cx - size, cy + size);
        ctx.lineTo(cx + size, cy - size);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  // Rótulos de temperatura por zona en el borde izquierdo
  const zoneBoundaries = [
    Math.floor(GRID_HEIGHT / 3),
    Math.floor((2 * GRID_HEIGHT) / 3),
    GRID_HEIGHT,
  ];
  const zoneStarts = [0, zoneBoundaries[0], zoneBoundaries[1]];

  ctx.save();
  ctx.font = "bold 13px monospace";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  for (let z = 0; z < 3; z++) {
    const rowStart = zoneStarts[z];
    const rowEnd = zoneBoundaries[z];
    const canvasTop = INFO_BAR_HEIGHT + rowStart * CELL_SIZE;
    const canvasBottom = INFO_BAR_HEIGHT + rowEnd * CELL_SIZE;
    const midY = (canvasTop + canvasBottom) / 2;
    const tempC = (world.getActualZoneTemp(z as 0|1|2) * 50).toFixed(1);
    const label = `Z${z}: ${tempC}ºC`;

    const padding = 4;
    const textWidth = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(4, midY - 9, textWidth + padding * 2, 18);

    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, 4 + padding, midY);
  }
  ctx.restore();
}

function drawCircle(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
}

function drawSquare(ctx: CanvasRenderingContext2D, cx: number, cy: number, half: number) {
  ctx.fillRect(cx - half, cy - half, half * 2, half * 2);
}

function drawTriangle(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number) {
  const h = size * Math.sqrt(3);
  ctx.beginPath();
  ctx.moveTo(cx, cy - h / 2);
  ctx.lineTo(cx - size, cy + h / 2);
  ctx.lineTo(cx + size, cy + h / 2);
  ctx.closePath();
  ctx.fill();
}

function drawCross(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number) {
  const half = size;
  ctx.save();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - half, cy - half);
  ctx.lineTo(cx + half, cy + half);
  ctx.moveTo(cx - half, cy + half);
  ctx.lineTo(cx + half, cy - half);
  ctx.stroke();
  ctx.restore();
}

function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, outerR: number) {
  const innerR = outerR * 0.5;
  const spikes = 5;
  let rot = -Math.PI / 2;
  const step = Math.PI / spikes;
  ctx.beginPath();
  for (let i = 0; i < spikes; i++) {
    const xOuter = cx + Math.cos(rot) * outerR;
    const yOuter = cy + Math.sin(rot) * outerR;
    ctx.lineTo(xOuter, yOuter);
    rot += step;

    const xInner = cx + Math.cos(rot) * innerR;
    const yInner = cy + Math.sin(rot) * innerR;
    ctx.lineTo(xInner, yInner);
    rot += step;
  }
  ctx.closePath();
  ctx.fill();
}

function updateUIAndDraw() {
  draw();

  const liveSpecies = world.getLiveSpeciesInfo();
  speciesListDiv.innerHTML = liveSpecies.map(sp =>
    `<div style="display:flex;align-items:center;gap:5px;margin:2px 0">` +
    `<span style="display:inline-block;width:10px;height:10px;background:${sp.color};flex-shrink:0;border-radius:2px"></span>` +
    `<span>#${sp.id}->${sp.count} &nbsp;T:${(sp.tempOpt * 50).toFixed(1)}ºC &nbsp;A:${sp.maxAge} &nbsp;P:${sp.predationIndex.toFixed(2)}</span>` +
    `</div>`
  ).join('');

/*
  const pop = world.getPopulation();
  tickSpan.textContent = world.tickCount.toString();
  popSpan.textContent = pop.toString();

   const traits = world.getTraitStats();
  if (tempOptMeanSpan && tempOptStdSpan && maxAgeMeanSpan) {
    tempOptMeanSpan.textContent = (traits.tempMean * 50).toFixed(1);
    tempOptStdSpan.textContent = (traits.tempStd * 50).toFixed(1);
    const daysPerTick = 1 / 24;
    const maxAgeDays = traits.maxAgeMean * daysPerTick;
    maxAgeMeanSpan.textContent = maxAgeDays.toFixed(1);
  } */
}

function updateSpeciesMLabel() {
  const m = Number(speciesMInput.value) / 100;
  speciesMLabel.textContent = m.toFixed(3);
}

function loop(timestamp: number) {
  const dt = timestamp - lastTime;
  lastTime = timestamp;

  if (isRunning) {
    accumulator += dt;
    while (accumulator >= tickDelay) {
      world.step();
      accumulator -= tickDelay;
      updateUIAndDraw();
      if (world.tickCount % CHART_INTERVAL === 0) {
        const species = world.getLiveSpeciesInfo().map(sp => ({
          speciesId: sp.id,
          population: sp.count,
          color: sp.color,
          metabolicType: sp.metabolicType,
        }));
        liveChart.addSnapshot(world.tickCount, species);
      }
      if (tracker) {
        tracker.onTick().then(result => {
          if (result !== "continue") {
            isRunning = false;
            const reason = result === "end_max" ? "max_ticks"
              : result === "end_extinction" ? "extinction"
              : "dominance";
            simStatus = END_REASON_LABELS[reason] ?? "finalizada";
            tracker!.endRun(reason);
            updateUIAndDraw();
          }
        });
      }
    }
  }
}

async function initWorld() {
  if (tracker) await tracker.endRun("manual");
  simStatus = "en pausa";
  liveChart.reset();
  world = new WorldSpecies();
  accumulator = 0;
  isRunning = false;
  lastTime = performance.now();
  const initialM = Number(speciesMInput.value) / 100;
  world.seedSingleAncestor(initialM);
  tracker = new RunTracker(world);
  await tracker.startRun();
}

window.addEventListener("DOMContentLoaded", async () => {
  tickDelay = Number(tickDelayInput.value);

  await initWorld();

  attachListeners();

  updateUIAndDraw();
  updateZoneTempsFromUI();
  updateSpeciesMLabel();
  updateSliderLabels();

  const loopWrapper = (t: number) => {
    loop(t);
    requestAnimationFrame(loopWrapper);
  };
  requestAnimationFrame(loopWrapper);
});
