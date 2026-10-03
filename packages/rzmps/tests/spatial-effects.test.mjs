import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  KillZone,
  Module,
  Particle,
  ParticleForceField,
  ParticleSystem,
  SpatialEffect,
  SpatialEffectHelper,
} from '../build/index.mjs';

const createSystem = (scene = new THREE.Scene()) => ({
  scene,
  simulationSpace: 'world',
  cameraDistanceSq: 0,
  updateWorldMatrix() {},
});

const geometrySize = (geometry) => {
  geometry.computeBoundingBox();
  return geometry.boundingBox
    .getSize(new THREE.Vector3())
    .toArray()
    .map((value) => Number(value.toFixed(4)));
};

assert.equal(typeof SpatialEffect, 'function');
assert.equal(typeof KillZone, 'function');
assert.equal(typeof ParticleForceField, 'function');
assert.equal(typeof SpatialEffectHelper, 'function');

{
  assert.deepEqual(
    geometrySize(KillZone.Sphere(2, 16, 8).geometry),
    [4, 4, 4],
  );
  assert.deepEqual(
    geometrySize(KillZone.Box(4, 5, 6).geometry),
    [4, 5, 6],
  );
  assert.deepEqual(
    geometrySize(ParticleForceField.Sphere({ gravity: 1 }, 3, 16, 8).geometry),
    [6, 6, 6],
  );
  assert.deepEqual(
    geometrySize(ParticleForceField.Box(4, 5, 6).geometry),
    [4, 5, 6],
  );
}

{
  const scene = new THREE.Scene();
  const killZone = KillZone.Sphere({}, 1, 16, 8);
  scene.add(killZone);

  const system = new ParticleSystem({
    emitters: [],
    renderers: [],
    modules: [],
    gravityModifier: 0,
  });
  system._scene = scene;
  system.particles.push(new Particle({
    lifetime: 2,
    position: new THREE.Vector3(0, 0, 0),
  }));

  system._processParticles();

  assert.equal(system.particles.length, 0);
}

{
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  root.position.set(0, 3, 0);
  scene.add(root);
  scene.add(KillZone.Sphere({ position: new THREE.Vector3(0, 3, 0) }, 1, 16, 8));

  const system = new ParticleSystem({
    emitters: [],
    renderers: [],
    modules: [],
    gravityModifier: 0,
  });
  root.add(system);
  system.particles.push(new Particle({
    lifetime: 2,
    position: new THREE.Vector3(0, 0, 0),
  }));

  system._processParticles();

  assert.equal(system.particles.length, 0);
}

{
  const scene = new THREE.Scene();
  const killZone = new KillZone({
    test: SpatialEffect.Plane({
      position: new THREE.Vector3(0, 0, 0),
      normal: new THREE.Vector3(0, 1, 0),
    }),
    tags: 'killable',
  });
  scene.add(killZone);

  const system = new ParticleSystem({
    emitters: [],
    renderers: [],
    modules: [],
    gravityModifier: 0,
  });
  system._scene = scene;
  system.particles.push(new Particle({
    lifetime: 2,
    position: new THREE.Vector3(0, 1, 0),
  }));
  system.particles.push(new Particle({
    lifetime: 2,
    position: new THREE.Vector3(1000, 1, 1000),
    tags: ['killable'],
  }));

  system._processParticles();

  assert.equal(system.particles.length, 1);
  assert.notDeepEqual(system.particles[0].tags, ['killable']);
}

{
  const scene = new THREE.Scene();
  scene.add(ParticleForceField.Sphere({
    direction: new THREE.Vector3(2, 0, 0),
  }, 2, 16, 8));

  const system = new ParticleSystem({
    emitters: [],
    renderers: [],
    modules: [],
    gravityModifier: 0,
  });
  system._scene = scene;
  system.deltaTime = 0.5;
  system.particles.push(new Particle({
    mass: 1,
    lifetime: 2,
    position: new THREE.Vector3(0, 0, 0),
  }));

  system._processParticles();

  assert.ok(system.particles[0].velocity.x > 0);
}

{
  const inside = new Particle({
    mass: 1,
    position: new THREE.Vector3(0, 0, 0),
  });
  const outside = new Particle({
    mass: 1,
    position: new THREE.Vector3(3, 0, 0),
  });
  const invertedField = ParticleForceField.Sphere({
    inverted: true,
    gravity: 2,
  }, 1, 16, 8);

  invertedField.modify([inside, outside], 1, createSystem());

  assert.equal(inside.velocity.length(), 0);
  assert.ok(outside.velocity.x < 0);
}

{
  const particle = new Particle({ lifetime: 10 });
  particle.kill();

  assert.equal(particle.realtime, Number.POSITIVE_INFINITY);
  assert.equal(particle.time, Number.POSITIVE_INFINITY);
}

{
  const scene = new THREE.Scene();
  const effect = SpatialEffect.Sphere((particle) => {
    particle.scale.set(3, 3, 3);
  }, {
    feather: 1,
    priority: Module.Priority.Transient,
  }, 1, 16, 8);
  scene.add(effect);

  const system = new ParticleSystem({
    emitters: [],
    renderers: [],
    modules: [],
    gravityModifier: 0,
  });
  system._scene = scene;
  system.particles.push(new Particle({
    lifetime: 2,
    position: new THREE.Vector3(1.5, 0, 0),
  }));

  system._processParticles();

  assert.ok(system.particles[0].scale.x > 1);
  assert.ok(system.particles[0].scale.x < 3);
}

{
  const scene = new THREE.Scene();
  const particleRoot = new THREE.Group();
  particleRoot.position.set(0, 2, 0);
  scene.add(particleRoot);

  const effect = SpatialEffect.Sphere((particle) => {
    particle.color.set('#ff0000');
    particle.scale.set(3, 3, 3);
  }, {
    feather: 1,
    priority: Module.Priority.Transient,
    position: new THREE.Vector3(0, 2, 0),
  }, 1, 16, 8);
  scene.add(effect);

  const system = new ParticleSystem({
    emitters: [],
    renderers: [],
    modules: [],
    gravityModifier: 0,
  });
  particleRoot.add(system);
  system.particles.push(new Particle({
    lifetime: 2,
    position: new THREE.Vector3(1.5, 0, 0),
    color: new THREE.Color('#ffffff'),
  }));

  system._processParticles();

  assert.ok(system.particles[0].scale.x > 1);
  assert.ok(system.particles[0].scale.x < 3);
  assert.ok(system.particles[0].color.r === 1);
  assert.ok(system.particles[0].color.g > 0);
  assert.ok(system.particles[0].color.g < 1);
}

{
  const effect = SpatialEffect.Sphere(null, {
    feather: 1,
  }, 1, 16, 8);

  assert.equal(effect.getFeather(new THREE.Vector3(1.8, 1.8, 0)), 0);
  assert.ok(effect.getFeather(new THREE.Vector3(1.5, 0, 0)) > 0);
}

{
  const effect = new SpatialEffect(null, {
    position: new THREE.Vector3(2, 0, 0),
    feather: 2,
  });

  assert.equal(effect.getFeather(new THREE.Vector3(2, 0, 0)), 1);
  assert.equal(effect.getFeather(new THREE.Vector3(3, 0, 0)), 0.5);
  assert.equal(effect.getFeather(new THREE.Vector3(5, 0, 0)), 0);
}

{
  let receivedFeather = 0;
  const effect = SpatialEffect.Sphere((particle, deltaTime, particleSystem, feather) => {
    receivedFeather = feather;
    particle.scale.setScalar(4);
  }, {
    feather: 1,
    automaticFeather: false,
  }, 1, 16, 8);

  const system = new ParticleSystem({
    emitters: [],
    renderers: [],
    modules: [],
    gravityModifier: 0,
  });
  system.particles.push(new Particle({
    lifetime: 2,
    position: new THREE.Vector3(1.5, 0, 0),
  }));

  system.spatialEffects = [effect];
  system._processParticles();

  assert.ok(receivedFeather > 0);
  assert.ok(receivedFeather < 1);
  assert.equal(system.particles[0].scale.x, 4);
}
