import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { Particle, ParticleSystem, TrailRenderer } from '../../build/index.mjs';

test('ribbon conditions follow stable birth ordering, including ties and removed particles', () => {
  const system = new ParticleSystem({ emitters: [], renderers: [] });
  const particles = [30, 10, 20, 10, 40, 50].map(startTime => {
    const particle = new Particle({ lifetime: 10 }); particle.startTime = startTime; return particle;
  });
  system.particles.push(...particles);
  const context = { system, deltaTime: 0, events: [] };
  const selected = count => Array.from({ length: count }, (_, index) => {
    const condition = TrailRenderer.RibbonCondition(count, index);
    return particles.filter(particle => condition(particle, 0, context));
  });
  assert.deepEqual(selected(3), [[particles[0], particles[1]], [particles[3], particles[4]],
    [particles[2], particles[5]]]);
  particles[1].alive = false;
  assert.deepEqual(selected(2), [[particles[0], particles[3], particles[5]], [particles[2], particles[4]]]);
  assert.equal(TrailRenderer.RibbonCondition(3, 0)(new Particle(), 0, context), false);
  system.destroy();
});

test('instance ribbon conditions supply their configured ribbon count', () => {
  const system = new ParticleSystem({ emitters: [], renderers: [] });
  const particles = Array.from({ length: 8 }, (_, startTime) => {
    const particle = new Particle(); particle.startTime = startTime; return particle;
  });
  system.particles.push(...particles);
  const map = new THREE.Texture();
  const renderer = new TrailRenderer({ ribbonCount: 4, texture: map });
  const context = { system, deltaTime: 0, events: [] };
  const condition = renderer.RibbonCondition(2);
  assert.deepEqual(particles.filter(particle => condition(particle, 0, context)),
    [particles[2], particles[6]]);
  renderer.destroy(); map.dispose(); system.destroy();
});
