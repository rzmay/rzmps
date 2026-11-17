import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { AudioRenderer, DecalRenderer, GasSimulation, LightRenderer, Particle, ParticleSystem }
  from '../../build/index.mjs';
import { readProfilerStats } from '../../../../apps/demo/src/profiling/readProfilerStats.js';

test('public benchmark snapshots provide simulation and per-renderer profiler data', () => {
  const lights = new LightRenderer({ brightness: 2 });
  const audio = new AudioRenderer({ onSpawn: false });
  const decals = new DecalRenderer(new THREE.MeshBasicMaterial());
  const gas = new GasSimulation();
  const system = new ParticleSystem({ emitters: [], modules: [gas], renderers: [lights, audio, decals] });
  lights._update([new Particle(), new Particle()]);
  audio._particleAudio.set('source', { audio: { isPlaying: true } });
  audio._eventAudio.add({ isPlaying: true });
  audio._eventAudio.add({ isPlaying: false });
  decals.instances.push({});
  const stats = readProfilerStats(system.benchmarks);
  assert.deepEqual(stats.renderers, [{ name: 'Lights', count: 2 }, { name: 'Audio clips', count: 2 },
    { name: 'Decals', count: 1 }]);
  assert.equal(stats.fluids[0].name, 'Gas');
  assert.equal(stats.fluids[0].cellSize, Number(gas.cellSize.toPrecision(3)).toString());
  assert.equal(gas.benchmarks.snapshot()['grid/width'], gas.gridDimensions.x);
  lights._update([]);
  assert.equal(readProfilerStats(system.benchmarks).renderers[0].count, 0);
  audio._particleAudio.clear(); audio._eventAudio.clear(); decals.instances.length = 0;
  system.destroy();
});

test('profiler aggregates subsystem snapshots without querying component internals', () => {
  const stats = readProfilerStats({ snapshot: () => ({
    'system/particleCount': 3, 'system/childrenCount': 2, 'system/allocatedSlots': 16,
    'systems/ParticleSystem-2/system/particleCount': 4,
    'systems/ParticleSystem-2/system/childrenCount': 1,
    'systems/ParticleSystem-2/renderers/LightRenderer-3/activeLights': 2,
    'renderers/LightRenderer-4/activeLights': 1,
    'modules/GasSimulation-5/grid/width': 16, 'modules/GasSimulation-5/grid/height': 32,
    'modules/GasSimulation-5/grid/depth': 16, 'modules/GasSimulation-5/grid/cellSize': 0.125,
  }) });
  assert.equal(stats.particles, 7); assert.equal(stats.children, 3); assert.equal(stats.allocated, 16);
  assert.deepEqual(stats.renderers, [{ name: 'Lights', count: 3 }]);
  assert.deepEqual(stats.fluids, [{ name: 'Gas', dimensions: '16 × 32 × 16', cellSize: '0.125' }]);
});
