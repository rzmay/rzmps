import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  BoidAffector,
  Boids,
  Particle,
  ParticleOctree,
  ParticleSystem,
} from '../build/index.mjs';

/*
 * Checks:
 * - ParticleOctree locates dense cells and sparse ancestors.
 * - ParticleOctree stores deduplicated neighbors on nodes.
 * - ParticleOctree performs exact-radius queries with index and tag filtering.
 * - ParticleOctree filters rebuilds by tag.
 * - ParticleOctree respects timeQuality rebuild cadence.
 * - Boids steers velocity from octree aggregate samples.
 * - BoidAffector targets/obstacles steer through Boids aggregates.
 * - BoidAffector tag filters and BVH surface sampling work.
 * - Boids can treat tagged particles as affectors.
 */

const aggregate = {
  new: (particle) => (particle
    ? {
      count: 1,
      center: particle.position.clone(),
    }
    : {
      count: 0,
      center: new THREE.Vector3(),
    }),
  combine: (a, b) => {
    if (b.count === 0) return a;
    const count = a.count + b.count;
    a.center.multiplyScalar(a.count).addScaledVector(b.center, b.count).divideScalar(count);
    a.count = count;
    return a;
  },
};

const octreeParticles = [
  new Particle({
    position: new THREE.Vector3(0.1, 0.1, 0.1),
    velocity: new THREE.Vector3(1, 0, 0),
  }),
  new Particle({
    position: new THREE.Vector3(0.2, 0.1, 0.1),
    velocity: new THREE.Vector3(1, 0, 0),
  }),
];
const octree = new ParticleOctree({
  bounds: new THREE.Box3(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(1, 1, 1),
  ),
  maxDepth: 3,
  particlesPerLeaf: 1,
}, aggregate);

octree.rebuild(octreeParticles);

const denseNode = octree.locate(new THREE.Vector3(0.1, 0.1, 0.1));
const sparseNode = octree.locate(new THREE.Vector3(0.9, 0.9, 0.9));

assert.ok(denseNode.depth > sparseNode.depth);
assert.equal(sparseNode, octree.root);

const neighborIds = new Set(denseNode.neighbors.map((node) => node.id));

assert.equal(neighborIds.size, denseNode.neighbors.length);
assert.ok(denseNode.neighbors.every((node) => node.size >= denseNode.size));

const radiusResults = octree.particlesInRadius(
  new THREE.Vector3(0.1, 0.1, 0.1),
  0.11,
  { excludeIndex: 0 },
);
assert.equal(radiusResults.length, 1);
assert.equal(radiusResults[0], octreeParticles[1]);

octreeParticles[0].tags = ['included'];
octreeParticles[1].tags = ['excluded'];

const taggedRadiusResults = octree.particlesInRadius(
  new THREE.Vector3(0.15, 0.1, 0.1),
  1,
  { tags: ['included'] },
);
assert.deepEqual(taggedRadiusResults, [octreeParticles[0]]);

const taggedOctree = new ParticleOctree({
  bounds: new THREE.Box3(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(1, 1, 1),
  ),
  maxDepth: 3,
  particlesPerLeaf: 8,
}, aggregate);

assert.equal(taggedOctree.rebuild(octreeParticles, ['included']), true);
assert.equal(taggedOctree.root.aggregate.count, 1);
assert.deepEqual(taggedOctree.root.aggregate.center.toArray(), octreeParticles[0].position.toArray());

taggedOctree.setBounds(new THREE.Box3(
  new THREE.Vector3(-1, -1, -1),
  new THREE.Vector3(2, 2, 2),
));
assert.equal(taggedOctree.rebuild(octreeParticles), true);
assert.deepEqual(taggedOctree.bounds.min.toArray(), [-1, -1, -1]);
assert.deepEqual(taggedOctree.bounds.max.toArray(), [2, 2, 2]);

// Configured tags are the default for rebuild; an explicit selection still overrides them.
const configuredTagsOctree = new ParticleOctree({ tags: 'included' }, aggregate);
configuredTagsOctree.rebuild(octreeParticles);
assert.equal(configuredTagsOctree.root.aggregate.count, 1);
configuredTagsOctree.rebuild(octreeParticles, []);
assert.equal(configuredTagsOctree.root.aggregate.count, octreeParticles.length);

const throttledOctree = new ParticleOctree({
  bounds: new THREE.Box3(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(1, 1, 1),
  ),
  maxDepth: 2,
  particlesPerLeaf: 2,
  timeQuality: 0.5,
}, aggregate);

assert.equal(throttledOctree.rebuild(octreeParticles), true);
const previousRoot = throttledOctree.root;
assert.equal(throttledOctree.rebuild(octreeParticles), false);
assert.equal(throttledOctree.root, previousRoot);
assert.equal(throttledOctree.rebuild(octreeParticles), true);

const boid = new Particle({
  lifetime: 10,
  position: new THREE.Vector3(0, 0, 0),
  velocity: new THREE.Vector3(1, 0, 0),
});
const neighbor = new Particle({
  lifetime: 10,
  position: new THREE.Vector3(1, 0, 0),
  velocity: new THREE.Vector3(0, 1, 0),
});
const boids = new Boids({
  octreeOptions: {
    bounds: new THREE.Box3(
      new THREE.Vector3(-2, -2, -2),
      new THREE.Vector3(2, 2, 2),
    ),
    maxDepth: 3,
    particlesPerLeaf: 1,
  },
  alignmentWeight: 1,
  cohesionWeight: 1,
  separationWeight: 0,
  speed: 1,
  steering: 1,
});

const system = new ParticleSystem({
  emitters: [],
  renderers: [],
  modules: [],
});

system.particles.push(boid, neighbor);
system.deltaTime = 1;
boids.prepare(boids.beginExecution(system, 0));
boids.modify([boid], 1, boids.executionContext);

assert.ok(boid.velocity.y > 0);

// Explicit octree options must preserve Boids' aggregate format and rebuild only once per prepare.
const boidsRoot = boids.octree.root;
assert.ok(boidsRoot.aggregate.particleAffectors instanceof Map);
assert.equal(boidsRoot.aggregate.count, 2);
boids.prepare(boids.beginExecution(system, 0));
assert.equal(boids.octree.root, boidsRoot);
boids.prepare(boids.beginExecution(system, 0));
assert.notEqual(boids.octree.root, boidsRoot);
assert.ok(boids.octree.root.aggregate.particleAffectors instanceof Map);

const radiusLimitedBoid = new Particle({
  lifetime: 10,
  position: new THREE.Vector3(0, 0, 0),
  velocity: new THREE.Vector3(1, 0, 0),
});
const outOfRangeNeighbor = new Particle({
  lifetime: 10,
  position: new THREE.Vector3(0.75, 0, 0),
  velocity: new THREE.Vector3(0, 1, 0),
});
const radiusLimitedBoids = new Boids({
  octreeOptions: {
    bounds: new THREE.Box3(
      new THREE.Vector3(-2, -2, -2),
      new THREE.Vector3(2, 2, 2),
    ),
  },
  neighborRadius: 0.5,
  alignmentWeight: 1,
  cohesionWeight: 0,
  separationWeight: 0,
  steering: 10,
});
const radiusLimitedSystem = new ParticleSystem({
  emitters: [],
  renderers: [],
  modules: [],
});
radiusLimitedSystem.particles.push(radiusLimitedBoid, outOfRangeNeighbor);
radiusLimitedBoids.prepare(radiusLimitedBoids.beginExecution(radiusLimitedSystem, 0));
radiusLimitedBoids.modify([radiusLimitedBoid], 0.1, radiusLimitedBoids.executionContext);
assert.deepEqual(radiusLimitedBoid.velocity.toArray(), [1, 0, 0]);

const quickTurnBoid = new Particle({
  lifetime: 10,
  position: new THREE.Vector3(0, 0, 0),
  velocity: new THREE.Vector3(1, 0, 0),
});
const quickTurnNeighbor = new Particle({
  lifetime: 10,
  position: new THREE.Vector3(1, 0, 0),
  velocity: new THREE.Vector3(0, 1, 0),
});
const quickTurnBoids = new Boids({
  octreeOptions: {
    bounds: new THREE.Box3(
      new THREE.Vector3(-2, -2, -2),
      new THREE.Vector3(2, 2, 2),
    ),
    maxDepth: 3,
    particlesPerLeaf: 1,
  },
  alignmentWeight: 1,
  cohesionWeight: 0,
  separationWeight: 0,
  speed: 1,
  steering: 10,
});
const quickTurnSystem = new ParticleSystem({
  emitters: [],
  renderers: [],
  modules: [],
});

quickTurnSystem.particles.push(quickTurnBoid, quickTurnNeighbor);
quickTurnBoids.prepare(quickTurnBoids.beginExecution(quickTurnSystem, 0));
quickTurnBoids.modify([quickTurnBoid], 0.1, quickTurnBoids.executionContext);

assert.ok(quickTurnBoid.velocity.y > 0.75);

const distantBoid = new Particle({
  lifetime: 10,
  position: new THREE.Vector3(40, 0, 0),
  velocity: new THREE.Vector3(1, 0, 0),
});
const distantNeighbor = new Particle({
  lifetime: 10,
  position: new THREE.Vector3(41, 0, 0),
  velocity: new THREE.Vector3(0, 1, 0),
});
const autoBoundsBoids = new Boids({
  octreeOptions: {
    maxDepth: 3,
    particlesPerLeaf: 1,
  },
  alignmentWeight: 1,
  cohesionWeight: 1,
  separationWeight: 0,
  speed: 1,
  steering: 1,
});
const autoBoundsSystem = new ParticleSystem({
  emitters: [],
  renderers: [],
  modules: [],
});

autoBoundsSystem.particles.push(distantBoid, distantNeighbor);
autoBoundsBoids.prepare(autoBoundsBoids.beginExecution(autoBoundsSystem, 0));
autoBoundsBoids.modify([distantBoid], 1, autoBoundsBoids.executionContext);

assert.ok(distantBoid.velocity.y > 0);

const neutralSpeedBoid = new Particle({
  lifetime: 10,
  position: new THREE.Vector3(0, 0, 0),
  velocity: new THREE.Vector3(1, 0, 0),
});
const neutralSpeedBoids = new Boids({
  octreeOptions: {
    bounds: new THREE.Box3(
      new THREE.Vector3(-1, -1, -1),
      new THREE.Vector3(1, 1, 1),
    ),
  },
  alignmentWeight: 0,
  cohesionWeight: 0,
  separationWeight: 0,
  affectorWeight: 0,
  speed: 2,
  steering: 1,
});
const neutralSpeedSystem = new ParticleSystem({
  emitters: [],
  renderers: [],
  modules: [],
});

neutralSpeedSystem.particles.push(neutralSpeedBoid);
neutralSpeedBoids.prepare(neutralSpeedBoids.beginExecution(neutralSpeedSystem, 0));
neutralSpeedBoids.modify([neutralSpeedBoid], 1, neutralSpeedBoids.executionContext);

assert.deepEqual(neutralSpeedBoid.velocity.toArray(), [2, 0, 0]);

const neutralNoMaintainBoid = new Particle({
  lifetime: 10,
  position: new THREE.Vector3(0, 0, 0),
  velocity: new THREE.Vector3(1, 0, 0),
});
const neutralNoMaintainBoids = new Boids({
  octreeOptions: {
    bounds: new THREE.Box3(
      new THREE.Vector3(-1, -1, -1),
      new THREE.Vector3(1, 1, 1),
    ),
  },
  alignmentWeight: 0,
  cohesionWeight: 0,
  separationWeight: 0,
  affectorWeight: 0,
  maintainSpeed: false,
  speed: 2,
  steering: 1,
});
const neutralNoMaintainSystem = new ParticleSystem({
  emitters: [],
  renderers: [],
  modules: [],
});

neutralNoMaintainSystem.particles.push(neutralNoMaintainBoid);
neutralNoMaintainBoids.prepare(neutralNoMaintainBoids.beginExecution(neutralNoMaintainSystem, 0));
neutralNoMaintainBoids.modify([neutralNoMaintainBoid], 1, neutralNoMaintainBoids.executionContext);

assert.deepEqual(neutralNoMaintainBoid.velocity.toArray(), [1, 0, 0]);

const opposingBoid = new Particle({
  lifetime: 10,
  position: new THREE.Vector3(0, 0, 0),
  velocity: new THREE.Vector3(1, 0, 0),
});
const opposingNeighbor = new Particle({
  lifetime: 10,
  position: new THREE.Vector3(0.5, 0, 0),
  velocity: new THREE.Vector3(-1, 0, 0),
});
const opposingBoids = new Boids({
  octreeOptions: {
    bounds: new THREE.Box3(
      new THREE.Vector3(-1, -1, -1),
      new THREE.Vector3(1, 1, 1),
    ),
    maxDepth: 2,
    particlesPerLeaf: 1,
  },
  alignmentWeight: 1,
  cohesionWeight: 0,
  separationWeight: 0,
  speed: 1,
  steering: 0.5,
});
const opposingSystem = new ParticleSystem({
  emitters: [],
  renderers: [],
  modules: [],
});

opposingSystem.particles.push(opposingBoid, opposingNeighbor);
opposingBoids.prepare(opposingBoids.beginExecution(opposingSystem, 0));
opposingBoids.modify([opposingBoid], 1, opposingBoids.executionContext);

assert.ok(Math.abs(opposingBoid.velocity.length() - 1) < Number.EPSILON);

const targetBoid = new Particle({
  lifetime: 10,
  position: new THREE.Vector3(0, 0, 0),
  velocity: new THREE.Vector3(0, 1, 0),
});
const targetAffector = new BoidAffector({
  position: new THREE.Vector3(1, 0, 0),
  weight: BoidAffector.Weight.Target,
});
const targetBoids = new Boids({
  octreeOptions: {
    bounds: new THREE.Box3(
      new THREE.Vector3(-2, -2, -2),
      new THREE.Vector3(2, 2, 2),
    ),
    maxDepth: 1,
    particlesPerLeaf: 8,
  },
  affectors: [targetAffector],
  alignmentWeight: 0,
  cohesionWeight: 0,
  separationWeight: 0,
  affectorWeight: 1,
  speed: 1,
  steering: 1,
});
const targetSystem = new ParticleSystem({
  emitters: [],
  renderers: [],
  modules: [],
});

targetSystem.particles.push(targetBoid);
targetBoids.prepare(targetBoids.beginExecution(targetSystem, 0));
targetBoids.modify([targetBoid], 1, targetBoids.executionContext);

assert.ok(targetBoid.velocity.x > 0.99);
assert.ok(Math.abs(targetBoid.velocity.y) < 1e-12);

const excludedBoid = new Particle({
  lifetime: 10,
  position: new THREE.Vector3(0, 0, 0),
  velocity: new THREE.Vector3(0, 1, 0),
  tags: ['blue'],
});
const excludedAffector = new BoidAffector({
  position: new THREE.Vector3(1, 0, 0),
  weight: BoidAffector.Weight.Target,
  tags: ['red'],
});
const excludedBoids = new Boids({
  octreeOptions: {
    bounds: new THREE.Box3(
      new THREE.Vector3(-2, -2, -2),
      new THREE.Vector3(2, 2, 2),
    ),
    maxDepth: 1,
    particlesPerLeaf: 8,
  },
  affectors: [excludedAffector],
  alignmentWeight: 0,
  cohesionWeight: 0,
  separationWeight: 0,
  affectorWeight: 1,
  speed: 1,
  steering: 1,
});
const excludedSystem = new ParticleSystem({
  emitters: [],
  renderers: [],
  modules: [],
});

excludedSystem.particles.push(excludedBoid);
excludedBoids.prepare(excludedBoids.beginExecution(excludedSystem, 0));
excludedBoids.modify([excludedBoid], 1, excludedBoids.executionContext);

assert.deepEqual(excludedBoid.velocity.toArray(), [0, 1, 0]);

const conditionedBoid = new Particle({
  lifetime: 10,
  position: new THREE.Vector3(0, 0, 0),
  velocity: new THREE.Vector3(0, 1, 0),
  tags: ['affected'],
});
const unconditionedBoid = new Particle({
  lifetime: 10,
  position: new THREE.Vector3(0.1, 0, 0),
  velocity: new THREE.Vector3(0, 1, 0),
  tags: ['ignored'],
});
const conditionedAffector = new BoidAffector({
  position: new THREE.Vector3(1, 0, 0),
  weight: BoidAffector.Weight.Target,
  condition: (particle) => particle.tags?.includes('affected') ?? false,
});
const conditionedBoids = new Boids({
  octreeOptions: {
    bounds: new THREE.Box3(
      new THREE.Vector3(-2, -2, -2),
      new THREE.Vector3(2, 2, 2),
    ),
    maxDepth: 1,
    particlesPerLeaf: 8,
  },
  affectors: [conditionedAffector],
  alignmentWeight: 0,
  cohesionWeight: 0,
  separationWeight: 0,
  affectorWeight: 1,
  speed: 1,
  steering: 1,
});
const conditionedSystem = new ParticleSystem({
  emitters: [],
  renderers: [],
  modules: [],
});

conditionedSystem.particles.push(conditionedBoid, unconditionedBoid);
conditionedBoids.prepare(conditionedBoids.beginExecution(conditionedSystem, 0));
conditionedBoids.modify([conditionedBoid, unconditionedBoid], 1, conditionedBoids.executionContext);

assert.ok(conditionedBoid.velocity.x > 0.99);
assert.deepEqual(unconditionedBoid.velocity.toArray(), [0, 1, 0]);

const sphereAffector = BoidAffector.Sphere(
  { weight: BoidAffector.Weight.Obstacle },
  1,
  16,
  8,
);
const sampledPoint = sphereAffector.samplePoint(new THREE.Vector3(3, 0, 0));

assert.ok(sampledPoint.x > 0.9);
assert.ok(sampledPoint.x < 1.1);
assert.equal(Boids.BoidAffector, BoidAffector);
assert.ok(Boids.BoidAffector.Box({
  weight: Boids.BoidAffector.Weight.Obstacle,
  inverted: true,
}, 1, 1, 1) instanceof BoidAffector);

const directBoxAffector = Boids.BoidAffector.Box(4, 5, 6);
directBoxAffector.geometry.computeBoundingBox();
assert.deepEqual(
  directBoxAffector.geometry.boundingBox.getSize(new THREE.Vector3()).toArray(),
  [4, 5, 6],
);

const particleAffectorBoid = new Particle({
  lifetime: 10,
  position: new THREE.Vector3(0, 0, 0),
  velocity: new THREE.Vector3(0, 1, 0),
  tags: ['boid'],
});
const particleAffectorSource = new Particle({
  lifetime: 10,
  position: new THREE.Vector3(1, 0, 0),
  velocity: new THREE.Vector3(),
  scale: new THREE.Vector3(0.25, 0.25, 0.25),
  tags: ['hazard'],
});
const particleAffectorBoids = new Boids({
  octreeOptions: {
    bounds: new THREE.Box3(
      new THREE.Vector3(-2, -2, -2),
      new THREE.Vector3(2, 2, 2),
    ),
    maxDepth: 1,
    particlesPerLeaf: 8,
  },
  tags: ['boid'],
  particleAffectors: [
    {
      sourceTags: 'hazard',
      tags: ['boid'],
      distance: 1,
    },
  ],
  alignmentWeight: 0,
  cohesionWeight: 0,
  separationWeight: 0,
  affectorWeight: 1,
  speed: 1,
  steering: 1,
});
const particleAffectorSystem = new ParticleSystem({
  emitters: [],
  renderers: [],
  modules: [],
});

particleAffectorSystem.particles.push(particleAffectorBoid, particleAffectorSource);
particleAffectorBoids.prepare(particleAffectorBoids.beginExecution(particleAffectorSystem, 0));
particleAffectorBoids.modify([particleAffectorBoid], 1, particleAffectorBoids.executionContext);

assert.ok(particleAffectorBoid.velocity.x < -0.99);

const particleTargetBoid = new Particle({
  lifetime: 10,
  position: new THREE.Vector3(0, 0, 0),
  velocity: new THREE.Vector3(0, 1, 0),
  tags: ['boid'],
});
const particleTargetSource = new Particle({
  lifetime: 10,
  position: new THREE.Vector3(1, 0, 0),
  velocity: new THREE.Vector3(),
  scale: new THREE.Vector3(0.25, 0.25, 0.25),
  tags: ['friend', 'leader'],
});
const particleTargetBoids = new Boids({
  octreeOptions: {
    bounds: new THREE.Box3(
      new THREE.Vector3(-2, -2, -2),
      new THREE.Vector3(2, 2, 2),
    ),
    maxDepth: 1,
    particlesPerLeaf: 8,
  },
  tags: ['boid'],
  particleAffectors: [
    {
      sourceTags: ['friend', 'leader'],
      tags: ['boid'],
      weight: Boids.BoidAffector.Weight.Target,
      distance: 1,
    },
  ],
  alignmentWeight: 0,
  cohesionWeight: 0,
  separationWeight: 0,
  affectorWeight: 1,
  speed: 1,
  steering: 1,
});
const particleTargetSystem = new ParticleSystem({
  emitters: [],
  renderers: [],
  modules: [],
});

particleTargetSystem.particles.push(particleTargetBoid, particleTargetSource);
particleTargetBoids.prepare(particleTargetBoids.beginExecution(particleTargetSystem, 0));
particleTargetBoids.modify([particleTargetBoid], 1, particleTargetBoids.executionContext);

assert.ok(particleTargetBoid.velocity.x > 0.99);

const taggedParticleAffectorPrey = new Particle({
  lifetime: 10,
  position: new THREE.Vector3(0, 0, 0),
  velocity: new THREE.Vector3(0, 1, 0),
  tags: ['prey'],
});
const taggedParticleAffectorIgnored = new Particle({
  lifetime: 10,
  position: new THREE.Vector3(0.1, 0, 0),
  velocity: new THREE.Vector3(0, 1, 0),
  tags: ['ignored'],
});
const taggedParticleAffectorSource = new Particle({
  lifetime: 10,
  position: new THREE.Vector3(1, 0, 0),
  velocity: new THREE.Vector3(),
  scale: new THREE.Vector3(0.25, 0.25, 0.25),
  tags: ['hazard'],
});
const taggedParticleAffectorBoids = new Boids({
  octreeOptions: {
    bounds: new THREE.Box3(
      new THREE.Vector3(-2, -2, -2),
      new THREE.Vector3(2, 2, 2),
    ),
    maxDepth: 1,
    particlesPerLeaf: 8,
  },
  tags: ['prey', 'ignored'],
  particleAffectors: [
    {
      sourceTags: 'hazard',
      tags: ['prey'],
      distance: 1,
    },
  ],
  alignmentWeight: 0,
  cohesionWeight: 0,
  separationWeight: 0,
  affectorWeight: 1,
  speed: 1,
  steering: 1,
});
const taggedParticleAffectorSystem = new ParticleSystem({
  emitters: [],
  renderers: [],
  modules: [],
});

taggedParticleAffectorSystem.particles.push(
  taggedParticleAffectorPrey,
  taggedParticleAffectorIgnored,
  taggedParticleAffectorSource,
);
taggedParticleAffectorBoids.prepare(taggedParticleAffectorBoids.beginExecution(taggedParticleAffectorSystem, 0));
taggedParticleAffectorBoids.modify([
  taggedParticleAffectorPrey,
  taggedParticleAffectorIgnored,
], 1, taggedParticleAffectorBoids.executionContext);

assert.ok(taggedParticleAffectorPrey.velocity.x < -0.99);
assert.deepEqual(taggedParticleAffectorIgnored.velocity.toArray(), [0, 1, 0]);
