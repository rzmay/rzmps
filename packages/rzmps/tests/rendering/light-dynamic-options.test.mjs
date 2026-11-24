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

test('configureLight edits evaluated lights and does not leak custom values through pool reuse', () => {
  const lights = new LightRenderer({ brightness: 4, distance: 6, configureLight(particle, light) {
    light.intensity *= 1 - particle.time;
    light.color.set(particle.time < 0.5 ? 'orange' : 'red');
  } });
  const source = particle(0.75);
  lights._update([source]);
  assert.equal(lights.lights[0].intensity, 1);
  source.time = 0;
  lights._update([source]);
  assert.equal(lights.lights[0].intensity, 4);
  assert(lights.lights[0].color.equals(new THREE.Color('orange')));
  lights.configureLight = undefined;
  lights._update([source]);
  assert(lights.lights[0].color.equals(new THREE.Color('white')));
  lights.destroy();
});

test('CPU grouped lights retain the source of the highest-priority member regardless of input order', async () => {
  const { ParticleSystem } = await import('../../build/index.mjs');
  const system = new ParticleSystem({ emitters: [], renderers: [] });
  const a = system.registerEmissionSource({ transform: new THREE.Matrix4(), age: 1, lifetime: 4 });
  const b = system.registerEmissionSource({ transform: new THREE.Matrix4(), age: 3, lifetime: 4 });
  const first = particle(0), second = particle(0, 'source-b');
  first.lodPriority = 0.8; second.lodPriority = 0.2;
  system.bindParticleSource(first, a); system.bindParticleSource(second, b);
  assert.equal(first.shallowClone('copy').source, a);
  const selected = [];
  const lights = new LightRenderer({ count: 1, configureLight(particle) { selected.push(particle.source); } });
  lights.setup(system);
  lights.update([first, second], system, 0);
  lights.update([second, first], system, 0);
  assert.deepEqual(selected, [b, b]);
  lights.destroy(); system.destroy();
});
