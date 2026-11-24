import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { Particle, RotationBySpeed } from '../../build/index.mjs';

const channels = ['rotation', 'angularVelocity', 'angularAcceleration'];
const options = speedRange => ({
  speedRange, angle: [2, 6], angularVelocity: [2, 6], angularAcceleration: () => 3,
});
const particleAt = speed => new Particle({
  velocity: new THREE.Vector3(speed, 0, 0),
  rotation: new THREE.Vector3(1, 1, 1),
  angularVelocity: new THREE.Vector3(1, 1, 1),
  angularAcceleration: new THREE.Vector3(1, 1, 1),
});
const check = (particle, expected) => channels.forEach((key, i) => {
  assert.deepEqual(particle[key].toArray(), Array(3).fill(expected[i]), key);
});

// Numeric nodes exercise the GPU callback and dynamic range getters without a GPU/browser.
class NumericNode {
  constructor(value) { this.value = value; }
  sub(b) { return new NumericNode(this.value - b.value); }
  div(b) { return new NumericNode(this.value / b.value); }
  max(b) { return new NumericNode(Math.max(this.value, b)); }
  clamp(a, b) { return new NumericNode(Math.min(b, Math.max(a, this.value))); }
}
function applyGPU(module, speed) {
  const result = particleAt(speed);
  module.evaluateDynamicGPU.number = (_key, get, _time, fallback) => new NumericNode(get() ?? fallback);
  module.evaluateDynamicGPU.parameterVector = (_key, get, time) => {
    const value = get();
    const n = typeof value === 'function' ? value(time.value)
      : Array.isArray(value) ? THREE.MathUtils.lerp(...value, time.value) : value * time.value;
    return new THREE.Vector3().setScalar(n);
  };
  const gpu = { velocity: { length: () => new NumericNode(speed) } };
  for (const key of channels) gpu[key] = {
    add: value => result[key].clone().add(value),
    assign: value => result[key].copy(value),
  };
  module.modifyGPU(gpu, 0.1, {});
  return result;
}

for (const backend of ['CPU', 'GPU callback']) {
  const apply = (module, speed) => {
    if (backend !== 'CPU') return applyGPU(module, speed);
    const particle = particleAt(speed);
    module._modify(particle, 0.1, {});
    return particle;
  };
  test(`${backend}: zero lower endpoints add no speed-driven motion below minimum and preserve initial spin`, () => {
    for (const range of [[0.25, 1], { min: 0.25, max: 1 }]) {
      const module = new RotationBySpeed({
        speedRange: range, angle: [0, 6], angularVelocity: [0, 6], angularAcceleration: [0, 3],
      });
      for (const speed of [0, 0.1, 0.25]) check(apply(module, speed), [1, 1, 1]);
    }
  });
  test(`${backend}: below-minimum speed intentionally clamps to nonzero endpoints and evaluates callbacks`, () => {
    const module = new RotationBySpeed(options([0.25, 1]));
    for (const speed of [0, 0.1, 0.25]) check(apply(module, speed), [3, 3, 4]);
  });
  test(`${backend}: moving particles retain interpolation and upper clamping`, () => {
    const module = new RotationBySpeed(options([0.25, 1]));
    check(apply(module, 0.625), [5, 5, 4]);
    check(apply(module, 1), [7, 7, 4]);
    check(apply(module, 2), [7, 7, 4]);
    module.options.speedRange = { min: 1, max: 3 };
    check(apply(module, 0.625), [3, 3, 4]);
    check(apply(module, 2), [5, 5, 4]);
  });
}
