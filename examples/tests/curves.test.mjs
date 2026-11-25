import test from 'node:test';
import assert from 'node:assert/strict';
import { Curve } from 'curves';
import { Easing } from 'eaz';
import { Color, Vector3 } from 'three';
import { float } from 'three/tsl';
import { ColorOverLifetime, Particle, ParticleSystem, ScaleOverLifetime } from '@rzmps/rzmps';

test('callable timestamp curves and detached evaluators work as numeric DynamicValues', t => {
  const system = new ParticleSystem({ emitters: [], renderers: [] });
  t.after(() => system.destroy());
  const curve = new Curve({ 0: 0, 0.2: 1, 1: 0 });
  const detached = curve.evaluate;
  const context = { system, deltaTime: 0, events: [] };
  for (const age of [0, 0.1, 0.2, 0.6, 1]) {
    const expected = age < 0.2 ? Easing.cubic.inOut(age / 0.2) : Easing.cubic.inOut((1 - age) / 0.8);
    assert.ok(Math.abs(curve(age) - expected) < 1e-12);
    assert.equal(detached(age), curve(age));
    for (const alpha of [curve, detached]) {
      const particle = new Particle({ lifetime: 1, alpha: 1 });
      particle.time = age;
      new ColorOverLifetime({ alpha }).modify([particle], 0, context);
      assert.ok(Math.abs(particle.alpha - expected) < 1e-12);
    }
  }
  const module = new ColorOverLifetime({ alpha: curve });
  assert.equal(module.evaluateDynamicGPU.number('alpha', () => curve, float(0.5)).isNode, true);
});

test('cast vector and RGB curves return Three.js instances accepted by CPU and GPU dynamic inputs', t => {
  const system = new ParticleSystem({ emitters: [], renderers: [] });
  t.after(() => system.destroy());
  const context = { system, deltaTime: 0, events: [] };
  const scale = new Curve({ 0: { x: 1, y: 2, z: 3 }, 1: { x: 3, y: 4, z: 5 } }).cast(
    ({ x, y, z }) => new Vector3(x, y, z),
  );
  const color = new Curve({ 0: new Color(1, 0, 0), 1: new Color(0, 0, 1) }).cast(({ r, g, b }) => new Color(r, g, b));
  assert.ok(scale(0.5) instanceof Vector3);
  assert.ok(color(0.5) instanceof Color);
  assert.deepEqual(scale.source(0.5), { x: 2, y: 3, z: 4 });
  const particle = new Particle({ lifetime: 1, scale: new Vector3(1, 1, 1), color: new Color(1, 1, 1) });
  particle.time = 0.5;
  const size = new ScaleOverLifetime({ scale });
  const tint = new ColorOverLifetime({ color });
  size.modify([particle], 0, context);
  tint.modify([particle], 0, context);
  assert.deepEqual(particle.scale.toArray(), [2, 3, 4]);
  assert.deepEqual(particle.color.toArray(), [0.5, 0, 0.5]);
  assert.equal(size.evaluateDynamicGPU.vector('scale', () => scale, float(0.5)).isNode, true);
  assert.equal(tint.evaluateDynamicGPU.color('color', () => color, float(0.5)).isNode, true);
});
