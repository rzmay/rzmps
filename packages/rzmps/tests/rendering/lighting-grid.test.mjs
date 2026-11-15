import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { LightingGrid } from '../../build/index.mjs';
import { fibonacciDirections, directionTransfer, SceneLightingCollection }
  from '../../src/rendering/lighting/lightingGrid.utils.ts';

test('Fibonacci bins and cascade transfers preserve constants and integrated energy', () => {
  for (const count of [4, 6, 12, 24]) {
    const bins = fibonacciDirections(count), coarse = fibonacciDirections(count * 2);
    assert.deepEqual(bins, fibonacciDirections(count));
    bins.forEach(bin => assert(Math.abs(bin.length() - 1) < 1e-12));
    const weights = directionTransfer(bins, coarse);
    weights.forEach(row => assert(Math.abs(row.reduce((a, b) => a + b, 0) - 1) < 1e-8));
    for (let j = 0; j < coarse.length; j++) {
      const sum = weights.reduce((total, row) => total + row[j], 0);
      assert(Math.abs(sum - 0.5) < 1e-3);
    }
  }
});

test('coarse world-space layout is rectangular, configurable and independent of fluid storage', () => {
  const grid = new LightingGrid({ levels: 2, directions: [4, 8], cellSize: 0.25 });
  assert.equal(grid.statistics.probes, 4 ** 3 + 2 ** 3);
  assert.equal(grid.statistics.directionalEntries, 4 ** 3 * 4 + 2 ** 3 * 8);
  assert.deepEqual(grid.locate(new THREE.Vector3()).toArray(), [2, 2, 2]);
  for (const options of [{ levels: 0 }, { directions: 0 }, { cellSize: 0 }, { levelScale: 1 },
    { maxDistance: -1 }, { samplesPerInterval: 0 }, { scatteringIterations: -1 }, { margin: -1 }]) {
    assert.throws(() => new LightingGrid(options), RangeError);
  }
  assert.throws(() => grid.update({ backend: {} }, new THREE.Scene(), grid.bounds), /native WebGPU/);
  grid.dispose(); grid.dispose();
});

test('cached scene discovery follows lights added to and removed from nested groups', () => {
  const scene = new THREE.Scene(), group = new THREE.Group(), cache = new SceneLightingCollection();
  scene.add(group); cache.update(scene); assert.equal(cache.lights.length, 0);
  const light = new THREE.PointLight(); group.add(light); cache.update(scene);
  assert.deepEqual(cache.lights, [light]);
  group.remove(light); cache.update(scene); assert.equal(cache.lights.length, 0);
  cache.dispose();
});

test('large valid domains coarsen probe spacing instead of aborting the render loop', () => {
  const grid = new LightingGrid({ cellSize: 0.25, directions: 12 });
  grid.configure(new THREE.Box3(new THREE.Vector3(-32, -32, -32), new THREE.Vector3(32, 32, 32)));
  assert.equal(grid.cellSize, 0.25, 'requested spacing remains available for smaller domains');
  assert(grid.statistics.probeSpacing > 0.25);
  for (const cascade of grid.cascades) {
    assert(cascade.local.image.width <= 2048);
    assert(cascade.local.image.height <= 2048);
    assert(cascade.local.image.depth <= 2048);
  }
  grid.configure(new THREE.Box3(new THREE.Vector3(-2, -2, -2), new THREE.Vector3(2, 2, 2)));
  assert.equal(grid.statistics.probeSpacing, 0.25);
  grid.dispose();
});
