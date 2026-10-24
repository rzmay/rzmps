import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  Boids,
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
  const scene = new THREE.Scene();
  const nearby = KillZone.Sphere({ position: new THREE.Vector3(10, 0, 0) }, 1, 8, 4);
  const distant = KillZone.Sphere({ position: new THREE.Vector3(100, 0, 0) }, 1, 8, 4);
  const custom = new KillZone({
    position: new THREE.Vector3(100, 0, 0),
    test: () => false,
  });
  scene.add(nearby, distant, custom);
  const system = new ParticleSystem({
    emitters: [],
    renderers: [],
    modules: [],
    spatialEffectBoundsFiltering: true,
  });
  system._scene = scene;
  system.deltaTime = 0.1;
  system.particles.push(new Particle({
    lifetime: 2,
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(100, 0, 0),
  }));
  system.updateBoundingBox();

  const selected = system._getSpatialEffects();
  assert.ok(selected.includes(nearby), 'velocity-expanded bounds should retain upcoming effects');
  assert.ok(!selected.includes(distant), 'non-overlapping built-in effects should be filtered');
  assert.ok(selected.includes(custom), 'custom-test effects must bypass bounds filtering');
}

{
  const scene = new THREE.Scene();
  const effect = KillZone.Sphere({ position: new THREE.Vector3(20, 0, 0) }, 1, 8, 4);
  scene.add(effect);
  const system = new ParticleSystem({
    emitters: [],
    renderers: [],
    modules: [],
    spatialEffectBoundsFiltering: true,
  });
  system._scene = scene;
  system._isGPUProcessingActive = true;
  system._gpuCPUMirrorStale = true;
  system._gpuAllocationDiagnostics = {
    activeCount: 1,
    maxVelocity: 0,
    bounds: new THREE.Box3(
      new THREE.Vector3(19, -1, -1),
      new THREE.Vector3(21, 1, 1),
    ),
  };
  system.updateBoundingBox();
  assert.ok(system._getSpatialEffects().includes(effect), 'GPU telemetry bounds should drive overlap filtering');
}

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
  const particle = new Particle({
    mass: 1,
    lifetime: 2,
    position: new THREE.Vector3(1.9, 0, 0),
  });
  const field = ParticleForceField.Sphere({
    direction: new THREE.Vector3(2, 0, 0),
  }, 2, 16, 8);

  field.modify([particle], 0.5, createSystem());

  assert.equal(Number(particle.velocity.x.toFixed(4)), 1);
}

{
  const particle = new Particle({
    mass: 1,
    lifetime: 2,
    position: new THREE.Vector3(1.9, 0, 0),
  });
  const field = ParticleForceField.Sphere({
    direction: new THREE.Vector3(2, 0, 0),
    radialFalloff: true,
  }, 2, 16, 8);

  field.modify([particle], 0.5, createSystem());

  assert.ok(particle.velocity.x > 0);
  assert.ok(particle.velocity.x < 1);
}

{
  const particle = new Particle({
    mass: 1,
    lifetime: 2,
    position: new THREE.Vector3(1.9, 0, 0),
  });
  const field = ParticleForceField.Sphere({
    direction: new THREE.Vector3(2, 0, 0),
    radialFalloffEasing: (falloff) => falloff ** 2,
  }, 2, 16, 8);

  field.modify([particle], 0.5, createSystem());

  assert.equal(field.radialFalloff, true);
  assert.ok(particle.velocity.x > 0);
  assert.ok(particle.velocity.x < 0.25);
}

{
  const parent = new THREE.Group();
  const field = ParticleForceField.Sphere({
    direction: new THREE.Vector3(2, 0, 0),
  }, 1, 16, 8);
  parent.add(field);
  const system = createSystem();

  const original = new Particle({ mass: 1, position: new THREE.Vector3() });
  field.modify([original], 0.5, system);
  assert.ok(original.velocity.x > 0);

  parent.position.x = 5;
  const oldPosition = new Particle({ mass: 1, position: new THREE.Vector3() });
  const movedPosition = new Particle({
    mass: 1,
    position: new THREE.Vector3(5, 0, 0),
  });
  field.modify([oldPosition, movedPosition], 0.5, system);
  assert.equal(oldPosition.velocity.x, 0, 'a parent transform must move CPU influence');
  assert.ok(movedPosition.velocity.x > 0);
}

{
  const system = new ParticleSystem({ emitters: [], renderers: [], modules: [] });
  const effect = SpatialEffect.Torus(() => {}, {
    modifyGPU() {},
    bakedFieldResolution: 3,
  }, 1, 0.25, 4, 4);
  effect.syncGPUTransform(system);
  const texture = effect._bakedFieldTexture;
  assert.ok(texture, 'non-analytic geometry should create a baked GPU influence field');
  effect.position.x = 4;
  effect.syncGPUTransform(system);
  assert.equal(
    effect._bakedFieldTexture,
    texture,
    'rigid movement must retain the local-space baked influence texture',
  );
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
  const effect = SpatialEffect.Sphere((particle) => {
    particle.scale.set(3, 3, 3);
  }, {
    feather: 1,
    featherEasing: (feather) => feather * feather,
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

  assert.equal(Number(system.particles[0].scale.x.toFixed(4)), 1.5);
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
  const scene = new THREE.Scene();
  const system = new ParticleSystem({ emitters: [], renderers: [], modules: [] });
  system.position.set(0, 10, 0);
  scene.add(system);
  const affector = Boids.BoidAffector.Sphere({
    position: new THREE.Vector3(0, 10, 0),
    range: 1,
  }, 0.5, 8, 4);
  scene.add(affector);
  scene.updateMatrixWorld(true);

  assert.equal(
    affector.test(new Particle({ position: new THREE.Vector3() }), system),
    true,
    'BoidAffector range tests should compare world-space positions for local systems',
  );
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
