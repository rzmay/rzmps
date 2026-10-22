import assert from 'node:assert/strict';
import * as THREE from 'three';
import { EmissionShape, EmissionSource } from '../build/index.mjs';

assert.equal(new EmissionShape().volumeSamples, 'auto');

const fixed = new EmissionShape({
  geometry: new THREE.BoxGeometry(2, 2, 2),
  source: EmissionSource.Volume,
  volumeSamples: 64,
});
const fixedSamples = fixed.getVolumeSamples();
assert.equal(fixedSamples.length, 64);
assert.ok(fixedSamples.every(({ radius }) => radius >= 0));
assert.equal(fixed.getVolumeSamples(), fixedSamples, 'unchanged geometry should reuse its table');

const savedRandom = Math.random;
let haltonSamples;
try {
  Math.random = () => 0;
  const haltonShape = new EmissionShape({
    geometry: new THREE.BoxGeometry(2, 2, 2),
    source: EmissionSource.Volume,
    volumeSamples: 8,
  });
  haltonSamples = haltonShape.getVolumeSamples();
} finally {
  Math.random = savedRandom;
}
assert.ok(haltonSamples[0].position.distanceTo(new THREE.Vector3(0, -1 / 3, -0.6)) < 1e-6);
assert.equal(
  new Set(haltonSamples.map(({ position: samplePosition }) => (
    samplePosition.toArray().map((component) => component.toFixed(6)).join(':')
  ))).size,
  haltonSamples.length,
  'Halton baking should distribute samples across distinct strata',
);

for (let index = 0; index < 1_000; index += 1) {
  const { position, normal } = fixed.getPoint();
  assert.ok(Math.abs(position.x) <= 1 + 1e-6);
  assert.ok(Math.abs(position.y) <= 1 + 1e-6);
  assert.ok(Math.abs(position.z) <= 1 + 1e-6);
  assert.ok(Math.abs(normal.length() - 1) < 1e-6);
}

const position = fixed.geometry.getAttribute('position');
position.setX(0, position.getX(0) - 0.1);
position.needsUpdate = true;
assert.notEqual(fixed.getVolumeSamples(), fixedSamples, 'CPU geometry edits should rebuild the table');

const automatic = new EmissionShape({
  geometry: new THREE.SphereGeometry(1, 16, 8),
  source: EmissionSource.Volume,
  volumeSamples: 'auto',
});
const automaticSamples = automatic.getVolumeSamples();
assert.equal(automaticSamples.length, 256, 'a simple closed volume should use the automatic minimum');
assert.equal(automatic.resolvedVolumeSamples, automaticSamples.length);
assert.ok(
  automaticSamples.every((sample) => sample.neighbors?.length === 3),
  'volume samples should bake a constant-size normal neighborhood',
);

const layered = new EmissionShape({
  geometry: new THREE.TorusGeometry(1, 0.3, 16, 32),
  source: EmissionSource.Volume,
  volumeSamples: 'auto',
});
assert.ok(layered.resolvedVolumeSamples > 256, 'automatic sizing should scale for narrow volumes');

console.log('emission shape volume tests passed');
