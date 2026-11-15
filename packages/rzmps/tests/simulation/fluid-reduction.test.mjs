/* eslint-env node */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { Box3, Vector3 } from 'three';
import { StorageBufferAttribute } from 'three/webgpu';
import { bool, float, storage, uniform, vec3, vec4 } from 'three/tsl';

// Exercise current source without rebuilding the library or requiring a GPU/device.
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
    return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
      }).outputText,
    };
  },
});

const { default: FluidReduction } = await import('../../src/simulation/gpu/FluidReduction.ts');
const { default: FluidPressureProjection } = await import('../../src/simulation/gpu/FluidPressureProjection.ts');
const { default: SparseVolumeGrid } = await import('../../src/spatial/structures/gpu/SparseVolumeGrid.ts');

class ObservedReduction extends FluidReduction {
  buildLevel(input, output, active, groups, final) {
    (this.levelInputs ??= []).push({ active, groups, final });
    return super.buildLevel(input, output, active, groups, final);
  }
}

// Evaluate the actual captured TSL uint expressions, including after uniform updates.
function uintValue(node) {
  if (node.isConstNode || node.isUniformNode) return node.value;
  if (node.isConvertNode || node.isVarNode) return uintValue(node.node);
  if (node.isOperatorNode) {
    const a = uintValue(node.aNode), b = uintValue(node.bNode);
    if (node.op === '+') return a + b;
    if (node.op === '/') return Math.floor(a / b);
  }
  throw new Error(`Unsupported uint expression: ${node.constructor.name}`);
}

test('reserved compact reduction handles empty, growth and shrink without replacing kernels or scratch', () => {
  // Reserve enough to require three reduction stages, even when only one item is active.
  const maximum = 256 * (64 * 64 + 1);
  const count = uniform(1, 'uint');
  const reduction = new ObservedReduction(maximum, { count, index: index => index });
  try {
    assert.equal(reduction.levelInputs.length, 3);
    assert.deepEqual(reduction.levelInputs.map(level => level.groups), [65, 2, 1]);
    assert.deepEqual(reduction.levelInputs.map(level => level.final), [false, false, true]);
    assert.equal(reduction.partialAttribute.count, Math.ceil(maximum / 256) * 3);
    const scratch = [...reduction.attributes], bytes = reduction.allocatedBytes;
    const key = {}, submitted = [];
    const renderer = { compute(nodes) { submitted.push(...(Array.isArray(nodes) ? nodes : [nodes])); } };
    const sample = () => vec4(1), active = () => bool(true);
    reduction.compute(renderer, key, sample, active);
    const kernels = [...submitted];

    for (const population of [0, 1, 255, 256, 257, 16384, 16385, maximum, 257, 1, 0]) {
      count.value = population;
      // Each stage consumes the previous stage's live output, never its reserved capacity.
      let expected = Math.ceil(population / 256);
      for (const level of reduction.levelInputs) {
        assert.equal(uintValue(level.active), expected, `population ${population}`);
        expected = Math.ceil(expected / 64);
      }
      submitted.length = 0;
      reduction.compute(renderer, key, sample, active);
      assert.deepEqual(submitted, kernels);
      assert.deepEqual(reduction.attributes, scratch);
      assert.equal(reduction.allocatedBytes, bytes);
      assert.equal(uintValue(reduction.range.count), population);
    }
  } finally {
    reduction.dispose();
  }
});

test('pressure reduction falls back from a zero or undersized maximum to the current FLIP pool', () => {
  const grid = new SparseVolumeGrid({ cellSubdivisions: 3,
    bounds: new Box3(new Vector3(), new Vector3(8, 8, 8)) }, 128);
  const attribute = new StorageBufferAttribute(new Float32Array(grid.cellCount), 1);
  const field = storage(attribute, 'float', grid.cellCount);
  const projection = new FluidPressureProjection(grid.gridDimensions, float(1), float(10),
    field, field, field, vec3(0), vec3(0), grid);
  try {
    for (const maximum of [0, 1, grid.cellCount, grid.cellCount * 2]) {
      grid.reductionCellCount = maximum;
      const reduction = projection.createReduction();
      try {
        const reserved = Math.max(grid.cellCount, maximum);
        assert.equal(reduction.partialAttribute.count, Math.ceil(reserved / 256) * 3);
        assert.equal(reduction.range.count.node, grid.pages);
      } finally {
        reduction.dispose();
      }
    }
    // Changing the configured maximum cannot enlarge a hierarchy already reserved/prepared.
    grid.reductionCellCount = grid.cellCount;
    const reduction = projection.createReduction();
    reduction.dispose();
    grid.reductionCellCount = grid.cellCount * 4;
    assert.throws(() => projection.createCapacityStorage(256), /reserved reduction cell count/);
  } finally {
    projection.dispose();
    attribute.dispose();
    grid.dispose();
  }
});

test('lazy pressure scratch invalidates a staged payload before any live rebinding', () => {
  const grid = new SparseVolumeGrid({ cellSubdivisions: 1,
    bounds: new Box3(new Vector3(), new Vector3(4, 4, 4)) }, 2);
  grid.reductionCellCount = 4 * grid.cellsPerBrick + 1;
  const attribute = new StorageBufferAttribute(new Float32Array(grid.cellCount), 1);
  const field = storage(attribute, 'float', grid.cellCount);
  const projection = new FluidPressureProjection(grid.gridDimensions, float(1), float(10),
    field, field, field, vec3(0), vec3(0), grid);
  const payload = projection.createCapacityStorage(4);
  try {
    assert(projection.canAdoptCapacityStorage(payload));
    projection.prepareStencil({ compute() {} });
    assert.equal(projection.canAdoptCapacityStorage(payload), false);
    assert.equal(projection.attribute, payload.sourceAttributes[0]);
    assert.equal(grid.capacity, 2);
  } finally {
    payload.attributes.forEach(value => value.dispose());
    projection.dispose(); attribute.dispose(); grid.dispose();
  }
});
