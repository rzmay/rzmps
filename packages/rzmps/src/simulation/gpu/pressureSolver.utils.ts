import { PressureSolver } from '../../enums/PressureSolver';
import type { MultigridOptions } from '../multigrid.types';

/** Internal geometry estimate; no hierarchy depth is exposed as a user tuning parameter. */
export function pressureHierarchy(dimensions: readonly number[], options: MultigridOptions = {}) {
  const pre = options.preSmoothing ?? 2, post = options.postSmoothing ?? 4;
  const bottom = options.bottomIterations ?? 12;
  const fine = dimensions.reduce((a, b) => a * b, 1);
  let shape = [...dimensions], levels = 0, usefulLevels = 0, coarseWork = 0;
  while (Math.max(...shape) > 2 && !shape.some(n => n > 1 && n % 2)) {
    if (shape.every(n => n >= 2)) usefulLevels++;
    const parentFraction = shape.reduce((a, b) => a * b, 1) / fine;
    shape = shape.map(n => Math.max(1, n / 2));
    levels++;
    const last = Math.max(...shape) <= 2 || shape.some(n => n > 1 && n % 2);
    const fraction = shape.reduce((a, b) => a * b, 1) / fine;
    // Residual and prolongation traverse the parent level; restriction/smoothing traverse the child.
    coarseWork += 2 * parentFraction + fraction * (1 + (last ? bottom : pre + post));
    if (last) break;
  }
  return { levels, usefulLevels, cycleWork: pre + post + Math.max(1, Math.ceil(coarseWork)) };
}

/** Validated policy, deliberately absent from normal tuning options. @internal */
export const pressureAutoPolicy = { entryCells: 2_500_000, exitCells: 2_000_000,
  minimumLevels: 3, minimumWork: 64, stableSteps: 8 } as const;

/** Conservative, deterministic crossover. Live topology changes are checked again on the GPU. @internal */
export function selectPressureSolver(activeCells: number, levels: number, previous: PressureSolver) {
  const threshold = previous === PressureSolver.Multigrid
    ? pressureAutoPolicy.exitCells : pressureAutoPolicy.entryCells;
  return levels >= pressureAutoPolicy.minimumLevels && activeCells >= threshold
    ? PressureSolver.Multigrid : PressureSolver.Iterative;
}
