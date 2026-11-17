import { liquidCheckpoint, compareMarkers } from './liquidQuality.utils.js';

/** Source-free 2x changes, checkpointed against actual completed substep time. */
export async function runLiquidQualityTransition(system, renderer, advance, clock,
  measureFrame = advance, pipelineCount = () => null) {
  const { flip } = system.__liquidFixture;
  const initial = await liquidCheckpoint(system, renderer), stages = [];
  const original = flip.spatialGridOptions.cellSubdivisions;
  let previous = initial;
  for (const subdivisions of [original - 1, original]) {
    const beforeTime = { ...clock }, from = flip.cellSize, pipelinesBefore = pipelineCount();
    const started = performance.now();
    flip.setSpatialGridOptions({ cellSubdivisions: subdivisions });
    const firstFrame = await measureFrame();
    for (let frame = 0; frame < 3; frame++) await advance();
    const fencedWallMs = performance.now() - started;
    const next = await liquidCheckpoint(system, renderer);
    const time = Object.fromEntries(Object.keys(clock).map(key => [key, clock[key] - beforeTime[key]]));
    stages.push({ fromCellWidth: from, toCellWidth: flip.cellSize, fencedWallMs, ...time, firstFrame,
      computePipelines: pipelinesBefore == null ? null : pipelineCount() - pipelinesBefore,
      ...compareMarkers(previous.markers, next.markers, time.executedSeconds),
      pressure: next.quality.pressure, particleCount: next.quality.particles, mass: next.quality.mass });
    previous = next;
  }
  return { stages, initial: initial.quality, final: previous.quality,
    ...compareMarkers(initial.markers, previous.markers,
      stages.reduce((sum, stage) => sum + stage.executedSeconds, 0)) };
}
