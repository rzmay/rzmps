import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  Module,
  Particle,
  ParticleSystem,
  SpatialEffect,
} from '../build/index.mjs';

const createSystem = (scene = new THREE.Scene()) => ({
  scene,
  simulationSpace: 'world',
  cameraDistanceSq: 0,
  updateWorldMatrix() {},
});

{
  const system = new ParticleSystem({ emitters: [], renderers: [], modules: [], gpuProcessing: false });
  const accepted = new Particle({ tags: ['included'] });
  const rejected = new Particle({ tags: ['included'], position: new THREE.Vector3(1, 0, 0) });
  const excluded = new Particle({ tags: ['excluded'] });
  const dead = new Particle({ tags: ['included'] });
  dead.alive = false;
  system.particles.push(accepted, rejected, excluded, dead);
  const conditionCalls = [];
  const updateCalls = [];
  const module = new Module((...args) => updateCalls.push(args), {
    tags: 'included',
    useOctree: true,
    condition: (...args) => {
      conditionCalls.push(args);
      const [particle, deltaTime, { system: owner, octree }] = args;
      assert.equal(deltaTime, 0.125);
      assert.equal(owner, system);
      assert.equal(octree, module.getParticleOctree());
      return octree.particlesInRadius(particle.position, 0.5).includes(accepted);
    },
  });
  const context = module.beginExecution(system, 0.125);
  module.prepare(context);
  module.modify(system.particles, 0.125, context);
  assert.deepEqual(conditionCalls.map(args => args[0]), [accepted, rejected]);
  assert.equal(updateCalls.length, 1);
  assert.deepEqual(updateCalls[0], conditionCalls[0]);
  module.cleanup();
  system.destroy();
}

{
  let conditionArgs;
  let updateArgs;
  const particle = new Particle();
  const module = new Module((...args) => { updateArgs = args; }, {
    condition: (...args) => { conditionArgs = args; return true; },
  });
  const context = module.beginExecution(createSystem(), 0.25);
  module.modify([particle], 0.25, context);
  assert.deepEqual(conditionArgs, [particle, 0.25, context]);
  assert.deepEqual(updateArgs, conditionArgs);
}

{
  const accepted = new Particle({
    position: new THREE.Vector3(0, 0, 0),
    tags: ['accepted'],
  });
  const rejected = new Particle({
    position: new THREE.Vector3(0, 0, 0),
    tags: ['rejected'],
  });

  const module = new Module((particle) => {
    particle.alpha = 0.25;
  }, {
    condition: (particle) => particle.tags?.includes('accepted') ?? false,
  });

  module.modify([accepted, rejected], 0, module.beginExecution(createSystem(), 0));

  assert.equal(accepted.alpha, 0.25);
  assert.equal(rejected.alpha, 1);
}

{
  const accepted = new Particle({
    position: new THREE.Vector3(0, 0, 0),
    tags: ['accepted'],
  });
  const rejected = new Particle({
    position: new THREE.Vector3(0, 0, 0),
    tags: ['rejected'],
  });

  const effect = SpatialEffect.Sphere((particle) => {
    particle.alpha = 0.5;
  }, {
    condition: (particle) => particle.tags?.includes('accepted') ?? false,
  }, 2, 16, 8);

  effect.modify([accepted, rejected], 0, createSystem());

  assert.equal(accepted.alpha, 0.5);
  assert.equal(rejected.alpha, 1);
}
