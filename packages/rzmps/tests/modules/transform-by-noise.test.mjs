import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { Module, Particle, ParticleSystem, TransformByNoise, TransformMode } from '../../build/index.mjs';

const sample = (mode, dt = 0.25, mass = 2) => {
  const system = new ParticleSystem({ emitters: [], renderers: [] });
  const particle = new Particle({ position: new THREE.Vector3(1, 2, 3), mass, lifetime: 10 });
  new TransformByNoise({ transformMode: mode, strength: 2, frequency: 1.5, scrollSpeed: 3 })
    .modify([particle], dt, { system, deltaTime: dt, events: [] });
  system.destroy();
  return particle;
};

test('noise modes change their intended property while preserving the default velocity behavior', () => {
  const offset = sample(TransformMode.Position).position.sub(new THREE.Vector3(1, 2, 3));
  const velocity = sample(TransformMode.Velocity);
  assert(offset.length() > 0);
  assert(offset.clone().multiplyScalar(0.25).distanceTo(velocity.velocity) < 1e-12);
  assert(sample(undefined).velocity.distanceTo(velocity.velocity) < 1e-12);
  assert(sample('Position', 0.5).position.sub(new THREE.Vector3(1, 2, 3)).distanceTo(offset) < 1e-12);
  const force = sample(TransformMode.Force);
  assert(force.acceleration.distanceTo(offset.clone().multiplyScalar(0.5)) < 1e-12);
  assert.equal(force.velocity.length(), 0);
  assert(sample(TransformMode.Force, 1, 0).acceleration.distanceTo(offset) < 1e-12);
});

test('render-time position noise stays bounded and does not change the simulated beam trajectory', () => {
  const rendered = [];
  const system = new ParticleSystem({ emitters: [], renderers: [], gravityModifier: 0,
    modules: [new TransformByNoise({ transformMode: TransformMode.Position, strength: 0.05,
      priority: Module.Priority.Transient }),
    new Module(particle => rendered.push(particle.position.clone()), { priority: 2 })] });
  const particle = new Particle({ lifetime: 10, velocity: new THREE.Vector3(2, 0, 0) });
  system.particles.push(particle);
  for (let frame = 1; frame <= 4; frame++) {
    system.advanceFrames(1, 0.1);
    particle.restore();
    assert(Math.abs(particle.position.x - frame * 0.2) < 1e-12);
    assert.equal(particle.position.y, 0);
    assert.equal(particle.velocity.x, 2);
    assert(rendered[frame - 1].distanceTo(particle.position) <= Math.sqrt(3) * 0.05);
  }
  system.destroy();
});

test('noise scroll follows simulation time and honors independent module offsets', () => {
  const system = new ParticleSystem({ emitters: [], renderers: [] });
  const sample = (seconds, scrollSpeed = 3, offset = new THREE.Vector3()) => {
    system._elapsedTime = seconds;
    const p = new Particle({ lifetime: 10, position: new THREE.Vector3(1, 2, 3) });
    new TransformByNoise({ transformMode: TransformMode.Position, strength: 1, scrollSpeed, offset })
      .modify([p], 0.1, { system, deltaTime: 0.1, events: [] });
    return p.position;
  };
  assert(sample(0).distanceTo(sample(1)) > 0.01, 'new particles at the same point must see evolving noise');
  assert(sample(1, 0).distanceTo(sample(2, 0)) < 1e-12, 'zero speed keeps the time slice fixed');
  assert(sample(1).distanceTo(sample(1, 3, new THREE.Vector3(31.416, 0, 0))) > 0.01);
  system.destroy();
});
