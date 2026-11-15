/* eslint-env node */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { Box3, Vector3 } from 'three';
import { float, uniform } from 'three/tsl';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      const url = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(url)) return { url: url.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!url.endsWith('.ts')) return next(url, context);
    return { format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
      }).outputText };
  },
});

const { default: Grid } = await import('../../src/spatial/structures/gpu/SparseVolumeGrid.ts');
const { default: Multigrid } = await import('../../src/simulation/gpu/SparsePressureMultigrid.ts');

for (const shape of [[32, 32, 32], [1, 64, 2], [48, 80, 16]]) {
  test(`actual bottom receives coarse solving and thin axes keep their width: ${shape}`, () => {
    const dimensions = new Vector3(...shape);
    const bounds = new Box3(new Vector3(), dimensions.clone().multiplyScalar(0.1));
    const grid = new Grid({ bounds, brickSubdivisions: 3, cellSubdivisions: 3 }, 64, dimensions);
    const fine = { grid, spacing: float(0.1), active: () => float(1).greaterThan(0),
      pressure: () => float(0), residual: () => float(0), open: () => float(1), add() {}, updateResidual() {} };
    const closed = uniform(new Vector3());
    const mg = new Multigrid(fine, closed, closed), events = [];
    for (const [depth, level] of mg.levels.entries()) {
      level.restrict = () => events.push({ kind: 'restrict', depth });
      level.smooth = (_, count) => events.push({ kind: 'smooth', depth, count });
      level.prolong = () => events.push({ kind: 'prolong', depth });
    }
    mg.correct({}, { preSmooth: 1, postSmooth: 3, coarseIterations: 17 });
    const restrictions = events.filter(e => e.kind === 'restrict');
    const bottom = restrictions.at(-1).depth;
    assert.deepEqual(events.filter(e => e.kind === 'smooth' && e.depth === bottom),
      [{ kind: 'smooth', depth: bottom, count: 17 }]);
    assert(bottom < mg.levels.length - 1, 'reserved hierarchy depth must not determine coarse iteration count');
    for (const { depth } of restrictions) {
      const level = mg.levels[depth];
      assert.deepEqual(level.grid.bounds.getSize(new Vector3()).toArray(), bounds.getSize(new Vector3()).toArray());
      if (level.fineDimensions.x === 1) assert.equal(level.ratio.value.x, 1);
    }
    mg.dispose(); grid.dispose();
  });
}

const { pressureHierarchy, selectPressureSolver } = await import('../../src/simulation/gpu/pressureSolver.utils.ts');
const { PressureSolver } = await import('../../src/enums/PressureSolver.ts');
test('Auto crossover has hysteresis and requires useful coarse levels', () => {
  let previous = PressureSolver.Iterative;
  const result = [100_000, 2_600_000, 2_300_000, 2_500_000, 2_100_000, 1_900_000].map(cells => {
    previous = selectPressureSolver(cells, 4, previous);
    return previous;
  });
  assert.deepEqual(result, ['Iterative', 'Multigrid', 'Multigrid', 'Multigrid', 'Multigrid', 'Iterative']);
  assert.equal(selectPressureSolver(4_000_000, 1, PressureSolver.Multigrid), PressureSolver.Iterative);
  assert.equal(pressureHierarchy([1, 64, 2]).usefulLevels, 0);
  const work = pressureHierarchy([128, 128, 128]);
  assert(work.cycleWork > 6, 'coarse transfers/smoothing must consume fine-equivalent work units');
  assert(work.usefulLevels >= 3);
});
