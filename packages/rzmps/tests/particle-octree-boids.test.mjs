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

octreeParticles[0].tags = ['included'];
octreeParticles[1].tags = ['excluded'];

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
boids.prepare(system);
boids.modify([boid], 1, system);

assert.ok(boid.velocity.y > 0);

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
quickTurnBoids.prepare(quickTurnSystem);
quickTurnBoids.modify([quickTurnBoid], 0.1, quickTurnSystem);

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
autoBoundsBoids.prepare(autoBoundsSystem);
autoBoundsBoids.modify([distantBoid], 1, autoBoundsSystem);

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
neutralSpeedBoids.prepare(neutralSpeedSystem);
neutralSpeedBoids.modify([neutralSpeedBoid], 1, neutralSpeedSystem);

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
neutralNoMaintainBoids.prepare(neutralNoMaintainSystem);
neutralNoMaintainBoids.modify([neutralNoMaintainBoid], 1, neutralNoMaintainSystem);

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
opposingBoids.prepare(opposingSystem);
opposingBoids.modify([opposingBoid], 1, opposingSystem);

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
targetBoids.prepare(targetSystem);
targetBoids.modify([targetBoid], 1, targetSystem);

assert.ok(targetBoid.velocity.x > 0.99);
assert.ok(Math.abs(targetBoid.velocity.y) < Number.EPSILON);

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
excludedBoids.prepare(excludedSystem);
excludedBoids.modify([excludedBoid], 1, excludedSystem);

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
conditionedBoids.prepare(conditionedSystem);
conditionedBoids.modify([conditionedBoid, unconditionedBoid], 1, conditionedSystem);

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
particleAffectorBoids.prepare(particleAffectorSystem);
particleAffectorBoids.modify([particleAffectorBoid], 1, particleAffectorSystem);

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
particleTargetBoids.prepare(particleTargetSystem);
particleTargetBoids.modify([particleTargetBoid], 1, particleTargetSystem);

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
taggedParticleAffectorBoids.prepare(taggedParticleAffectorSystem);
taggedParticleAffectorBoids.modify([
  taggedParticleAffectorPrey,
  taggedParticleAffectorIgnored,
], 1, taggedParticleAffectorSystem);

assert.ok(taggedParticleAffectorPrey.velocity.x < -0.99);
assert.deepEqual(taggedParticleAffectorIgnored.velocity.toArray(), [0, 1, 0]);
