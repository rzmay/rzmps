/* eslint-env node */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { Box3, Vector3 } from 'three';
import { StorageBufferAttribute } from 'three/webgpu';
import { float, storage, vec3 } from 'three/tsl';

// Test the owned source directly, without a package build or GPU device.
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

const { default: Projection } = await import('../../src/simulation/gpu/FluidPressureProjection.ts');
const { default: Grid } = await import('../../src/spatial/structures/gpu/SparseVolumeGrid.ts');
const { default: LightRenderer } = await import('../../src/rendering/renderers/LightRenderer.ts');
const { createGPUParticleRenderBufferState } = await import('../../src/simulation/gpu/Particle.ts');

test('cold pressure capture covers both initialization bindings and later diagnostic toggles', async () => {
  const grid = new Grid({ cellSubdivisions: 1,
    bounds: new Box3(new Vector3(), new Vector3(4, 4, 4)) }, 2);
  const attributes = [1, 1, 1, 4, 4].map(size =>
    new StorageBufferAttribute(new Float32Array(grid.cellCount * size), size));
  const [solid, pressure, divergence, input, output] = attributes.map((attribute, i) =>
    storage(attribute, i < 3 ? 'float' : 'vec4', grid.cellCount));
  const controls = { minIterations: 2, maxIterations: 2, tolerance: 0,
    diagnostics: false, measureVelocity: false };
  const projection = new Projection(grid.gridDimensions, float(1), float(10),
    solid, pressure, divergence, vec3(0), vec3(0), grid,
    undefined, undefined, undefined, undefined, undefined, () => controls);
  const compiled = new Set(), submitted = [];
  const renderer = { backend: {}, compute(nodes) { submitted.push(...(Array.isArray(nodes) ? nodes : [nodes])); },
    async compileComputeAsync(nodes) { nodes.forEach(node => compiled.add(node)); } };
  try {
    await projection.prepare(renderer, input, output, 2);
    assert.equal(submitted.length, 0, 'preparation submits no solver work');
    assert.equal(projection.initialized, false);
    assert.equal(projection.pressureInitialized, false);
    const stencil = [projection.stencilIndicesAttribute, projection.stencilWeightsAttribute];
    const reduction = projection.reduction, allocatedBytes = projection.allocatedBytes;
    for (const binding of [input, output]) {
      projection.initialized = false;
      projection.initialize(renderer, binding);
    }
    // Avoid asynchronous readback while exercising the live diagnostic branches.
    projection.readPending = true;
    for (const diagnostics of [false, true]) {
      controls.diagnostics = diagnostics;
      controls.measureVelocity = !diagnostics;
      projection.solve(renderer, input, output, 2);
    }
    assert(submitted.length > 0);
    assert(submitted.every(node => compiled.has(node)), 'all live graph identities were compiled');
    assert.deepEqual([projection.stencilIndicesAttribute, projection.stencilWeightsAttribute], stencil);
    assert.equal(projection.reduction, reduction, 'measurement variants share one reduction hierarchy');
    assert.equal(projection.allocatedBytes, allocatedBytes, 'diagnostic toggles allocate no additional storage');
  } finally {
    projection.dispose(); attributes.forEach(attribute => attribute.dispose()); grid.dispose();
  }
});

for (const count of [0, 7]) {
  test(`grouped light preparation restores count ${count} and never dispatches or reads back`, async () => {
    const light = new LightRenderer({ count: 2 });
    const input = { count, capacity: 64 };
    const a = { name: 'snapshot' }, b = { name: 'aggregate' };
    const compiled = [], compute = () => assert.fail('live compute during preparation');
    const renderer = { compute, async compileComputeAsync(nodes) {
      assert.equal(input.count, count, 'count restored before asynchronous compilation');
      assert.equal(this.compute, compute);
      compiled.push(...nodes);
    } };
    const system = { gpuProcessing: true, prepareGPURenderInput(actual) { assert.equal(actual, renderer); return input; },
      getGPURendererTagMask() { return 3; } };
    light._gpuGrouping = { prepare(buffers, owner, cap, ratio, radius, mask) {
      assert.equal(buffers, input); assert.equal(owner, system);
      assert.equal(buffers.count, 64); assert.equal(cap, 2); assert.equal(mask, 3);
      renderer.compute([a, b]); renderer.compute(a);
    }, readback() { assert.fail('readback during preparation'); } };
    await light.prepareResources(system, renderer);
    assert.deepEqual(compiled, [a, b]);
    assert.equal(input.count, count); assert.equal(renderer.compute, compute);
  });
}

test('grouping capture failure restores the shared renderer and population', async () => {
  const light = new LightRenderer({ count: 2 }), input = { count: 0, capacity: 64 };
  const compute = () => assert.fail('dispatch');
  const renderer = { compute, async compileComputeAsync() { assert.fail('compile after capture failure'); } };
  light._gpuGrouping = { prepare() { throw new Error('capture failed'); } };
  await assert.rejects(light.prepareResources({ gpuProcessing: true, prepareGPURenderInput: () => input,
    getGPURendererTagMask() {} }, renderer), /capture failed/);
  assert.equal(input.count, 0); assert.equal(renderer.compute, compute);
});

test('system preparation settles particle bindings before grouping and retains graphs on live handoff', async () => {
  // Exercise the actual prepare method without loading unrelated renderer texture assets in Node.
  const source = ts.createSourceFile('ParticleSystem.ts', readFileSync(
    new URL('../../src/core/ParticleSystem.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(node => ts.isClassDeclaration(node)
    && node.name?.text === 'ParticleSystem');
  const method = declaration.members.find(node => node.name?.getText(source) === 'prepare');
  const harness = ts.transpileModule(`class PreparationHarness { ${method.getText(source)} }`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  const Preparation = new Function('ParticleSystem', 'Module', `${harness}; return PreparationHarness;`)(
    { isWebGPURenderer: candidate => candidate.isWebGPURenderer }, class {});
  const light = new LightRenderer({ count: 2 });
  const input = createGPUParticleRenderBufferState(64), compiled = new Set(), submitted = [];
  const renderer = { isWebGPURenderer: true, backend: {},
    compute(nodes) { submitted.push(...(Array.isArray(nodes) ? nodes : [nodes])); },
    async compileComputeAsync(nodes) { nodes.forEach(node => compiled.add(node)); } };
  const events = [];
  let finishRendering;
  const rendering = new Promise(resolve => { finishRendering = resolve; });
  const ordinary = { supportsGPUInput: true, supportsGPUEventInput: true, syncGPUConfiguration() {},
    async prepareResources() { events.push('render'); await rendering; } };
  const module = { syncGPUConfiguration() {}, benchmarks: { spanAsync: (_, work) => work() },
    async prepareResources() {
      assert.deepEqual(events, ['render'], 'ordinary renderers start alongside modules');
      events.push('module'); finishRendering();
    } };
  const system = { gpuProcessing: true, sceneRenderer: renderer, simulationSpace: 'world', quality: 1,
    prepareGPURenderInput: () => input, getGPURendererTagMask: () => undefined,
    emitters: [], renderers: [ordinary, light], subSystems: new Map(),
    getModules: () => [module], _getSpatialEffects: () => [], _discoverEventTypes() {},
    _canProcessParticlesOnGPU: () => true };
  system.gpuSimulation = { _gpuParameters: { sync() {} }, _prepareGPUTagRegistry() {},
    async preparePrograms() {
      assert.deepEqual(events, ['render', 'module']);
      events.push('particles'); system.gpuParticleBuffers = { version: 7 };
    } };
  const prepareLight = light.prepareResources.bind(light);
  light.prepareResources = async (...args) => {
    assert.equal(system.gpuParticleBuffers?.version, 7, 'grouping waits for final simulation bindings');
    events.push('grouping'); return prepareLight(...args);
  };
  try {
    await Preparation.prototype.prepare.call(system, renderer);
    assert.deepEqual(events, ['render', 'module', 'particles', 'grouping']);
    assert.equal(input.count, 0);
    assert.equal(submitted.length, 0);
    assert(compiled.size > 0);
    for (const count of [7, 32, 3]) {
      input.count = count;
      const grouping = light._gpuGrouping;
      grouping.prepare(input, system, light.count, light.groupingRatio, light.groupingRadius,
        system.getGPURendererTagMask(light.tags));
      assert.equal(grouping.inputCount.value, count, 'live uniform replaces reserved count');
      assert.equal(grouping.snapshot.count, count, 'snapshot count follows live input');
      assert.equal(grouping.source.currentBuffers.count, count, 'source hierarchy sees refreshed count');
      assert.equal(grouping.output.count, 2);
      assert.equal(grouping.centers.currentBuffers.count, 2);
    }
    assert(submitted.length > 0);
    assert(submitted.every(node => compiled.has(node)), 'live grouping uses only prepared nodes');
  } finally {
    light.reset(); input.dispose();
  }
});
