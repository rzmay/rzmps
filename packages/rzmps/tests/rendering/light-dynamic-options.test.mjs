import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { LightRenderer, Particle } from '../../build/index.mjs';

const particle = (time, id = 'source-a') => Object.assign(
  new Particle({ alpha: 0.5, color: new THREE.Color('white') }), { time, id });

test('all point-light options evaluate per source and refresh after pool reuse', () => {
  const lights = new LightRenderer({ count: 2, allocation: { shrinkDelay: Infinity },
    brightness: time => 4 * (1 - time) * (2 + time), alphaAffectsIntensity: true,
    color: time => time < 0.5 ? 'red' : 'blue',
    distance: time => 8 - 4 * time, decay: time => 1 + time });
  const a = particle(0), b = particle(0.75, 'source-b');
  lights._update([a, b]);
  assert.equal(lights.lights[0].intensity, 4);
  assert.equal(lights.lights[1].intensity, 1.375);
  assert(lights.lights[0].color.equals(new THREE.Color('red')));
  assert(lights.lights[1].color.equals(new THREE.Color('blue')));
  assert.equal(lights.lights[1].distance, 5);
  assert.equal(lights.lights[1].decay, 1.75);
  const pooled = lights.lights[0];
  lights._update([]); assert.equal(pooled.intensity, 0);
  lights._update([b]); assert.equal(lights.lights[0], pooled);
  assert.equal(pooled.intensity, 1.375);
  assert(pooled.color.equals(new THREE.Color('blue')));
  assert.equal('lightOptions' in lights, false);
  lights.destroy();
});

test('dynamic power uses Three point-light units and deterministic interval evaluation', () => {
  const lights = new LightRenderer({ brightness: 2, power: time => 4 * Math.PI * (1 - time),
    distance: [3, 9] });
  const source = particle(0.5);
  lights._update([source]);
  assert.equal(lights.lights[0].intensity, 0.5, 'power is an alternative to brightness');
  const distance = lights.lights[0].distance;
  lights._update([source]); assert.equal(lights.lights[0].distance, distance);
  source.time = 1; lights._update([source]); assert.equal(lights.lights[0].intensity, 0);
  lights.power = undefined;
  lights._update([source]); assert.equal(lights.lights[0].intensity, 2);
  lights.destroy();
});
