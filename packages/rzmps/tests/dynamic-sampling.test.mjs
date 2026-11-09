import assert from 'node:assert/strict';
import { Color, Vector3 } from 'three';
import { float, uniform, vec3 } from 'three/tsl';
import {
  sampleDynamicValue, maxDynamicNumber, minDynamicNumber, maxDynamicVector, minDynamicVector,
  maxDynamicColor, minDynamicColor, Emitter, ParticleSystem,
} from '../build/index.mjs';

assert.equal(maxDynamicNumber([-8, -2]), -2);
assert.equal(minDynamicNumber(new Set([-8, -2])), -8);
assert.equal(maxDynamicNumber(t => new Set([() => [-4, t * 3], 2]), 4), 3);
assert.equal(minDynamicNumber(t => [-t * 3, 2], 4), -3);
const times = [];
assert.equal(maxDynamicNumber(t => { times.push(t); return t; }, 4), 1);
assert.deepEqual(times, [0, 1/3, 2/3, 1]);
assert.equal(maxDynamicNumber(() => { throw new Error('unreadable'); }), 0);
assert.equal(maxDynamicNumber(t => { if(t === 0) throw new Error('one sample'); return t; }, 2), 1);
assert.equal(maxDynamicNumber(float(7)), 7);
assert.equal(minDynamicNumber(uniform(-3)), -3);
assert.equal(maxDynamicNumber(vec3(1)), 0);
assert.equal(maxDynamicNumber(new Set(), 16, 42), 42);
assert.equal(minDynamicNumber(new Set(), 16, 42), 42);
assert.equal(maxDynamicNumber(Infinity, 16, 42), 42);
assert.equal(maxDynamicNumber(t => t, Infinity), 1);

// Custom reductions and input adapters share deterministic traversal without random evaluation.
assert.equal(sampleDynamicValue(new Set(['short', 'longest']), (a,b) => a.length>b.length?a:b), 'longest');
assert.equal(sampleDynamicValue(() => new Set([2, 3]), (a,b) => a+b, 2), 10);
assert.equal(sampleDynamicValue(new Set(['2', '3']), Math.max, 2, Number), 3);
assert.equal(sampleDynamicValue(new Set(), Math.max), undefined);
const cyclic = new Set([2]); cyclic.add(cyclic);
assert.equal(maxDynamicNumber(cyclic), 2);
const recursive = () => recursive;
assert.equal(maxDynamicNumber(recursive), 0);

const vector = new Vector3(-1, 5, -3);
assert.deepEqual(maxDynamicVector([2, vector]).toArray(), [2, 5, 2]);
assert.deepEqual(minDynamicVector([2, vector]).toArray(), [-1, 2, -3]);
assert.deepEqual(maxDynamicVector(t => [vector, new Vector3(t, 2, t*6)], 2).toArray(), [1, 5, 6]);
assert.deepEqual(minDynamicVector(uniform(vector)).toArray(), vector.toArray());
maxDynamicVector(vector).setScalar(100);
minDynamicVector(vector).setScalar(100);
assert.deepEqual(vector.toArray(), [-1, 5, -3]);
assert.deepEqual(maxDynamicVector(vec3(1)).toArray(), [1, 1, 1]);
assert.deepEqual(maxDynamicVector(vec3(1).add(2)).toArray(), [0, 0, 0]);

const color = new Color(0.2, 0.8, 0.4);
assert.deepEqual(maxDynamicColor([color, new Color(0.5, 0.3, 0.9)]).toArray(), [0.5, 0.8, 0.9]);
assert.deepEqual(minDynamicColor([color, new Color(0.5, 0.3, 0.9)]).toArray(), [0.2, 0.3, 0.4]);
assert.ok(maxDynamicColor(() => new Set(['red', 'blue'])).equals(new Color(1, 0, 1)));
assert.ok(minDynamicColor(new Set(['red', 'blue'])).equals(new Color(0, 0, 0)));
assert.ok(maxDynamicColor(uniform(color)).equals(color));
maxDynamicColor(color).setRGB(1, 1, 1);
minDynamicColor(color).setRGB(0, 0, 0);
assert.deepEqual(color.toArray(), [0.2, 0.8, 0.4]);
assert.ok(maxDynamicColor(vec3(1)).equals(new Color(0, 0, 0)));

const resolution = ParticleSystem.GPU_DYNAMIC_VALUE_RESOLUTION;
try {
  ParticleSystem.GPU_DYNAMIC_VALUE_RESOLUTION = 4;
  const emitter = new Emitter({initialValues:{lifetime:t => 10-Math.abs(t-1/3)*3}});
  assert.equal(emitter.getMaxLifetime(), 10);
  emitter.initialValues.lifetime = vec3(1);
  assert.equal(emitter.getMaxLifetime(), null);
  emitter.initialValues.lifetime = () => [2, 4];
  assert.equal(emitter.getMaxLifetime(), 4);
} finally { ParticleSystem.GPU_DYNAMIC_VALUE_RESOLUTION = resolution; }
console.log('Shared dynamic reductions, numeric/vector/color extrema, functions, nodes, isolation and lifetime sampling passed.');
