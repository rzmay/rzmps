import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { ParticleSystem, Particle, Emitter, EmissionShape, SimulationSpace } from '../build/index.mjs';

const root = options => new ParticleSystem({ gravityModifier: 0, emitters: [], renderers: [], ...options });
const step = (parent, dt = 0.1) => { parent.deltaTime = dt; parent._updateSubSystems(); };
const near = (actual, expected, epsilon = 1e-6) => {
  assert.ok(actual.distanceTo(expected) < epsilon, `${actual.toArray()} != ${expected.toArray()}`);
};
function child(options = {}) {
  const shape = EmissionShape.Box(1, 1, 1);
  shape.getPoint = () => ({ position: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0) });
  return root({ duration: 1, simulationSpace: 'source', ...options, emitters: new Emitter({
    source: shape, radialSpeed: 0,
    bursts: [{ time: 0, count: 1 }, { time: 0.4, count: 1 }],
    initialValues: { lifetime: 10, position: new THREE.Vector3(1, 0, 0) },
  }) });
}
const pose = (x = 0, angle = 0, scale = 1) => new THREE.Matrix4().compose(
  new THREE.Vector3(x, 0, 0), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle),
  new THREE.Vector3(scale, scale, scale),
);

test('World, Local and root Source resolve their documented frames', () => {
  for (const mode of Object.values(SimulationSpace)) {
    const system = root({ simulationSpace: mode });
    system.position.x = 5;
    near(system.simulationToWorld(new THREE.Vector3(1, 0, 0)),
      new THREE.Vector3(['local', 'source'].includes(mode) ? 6 : 1, 0, 0));
    system.destroy();
  }
});

test('Transform accepts live Object3D and Matrix4 references, rebases state and uses identity by default', () => {
  const anchor = new THREE.Object3D(); anchor.position.x = 10;
  const system = root({ simulationSpace: 'transform', simulationSpaceTransform: anchor });
  system.position.x = 3;
  const particle = new Particle({ position: new THREE.Vector3(1, 0, 0), velocity: new THREE.Vector3(2, 0, 0) });
  system.addParticle(particle);
  near(system.simulationToWorld(particle.position.clone()), new THREE.Vector3(11, 0, 0));
  anchor.position.x = 20;
  near(system.simulationToWorld(particle.position.clone()), new THREE.Vector3(21, 0, 0));
  system.simulationSpace = 'world';
  near(particle.position, new THREE.Vector3(21, 0, 0));
  system.simulationSpace = 'transform';
  near(particle.position, new THREE.Vector3(1, 0, 0));
  const matrix = pose(30);
  system.simulationSpaceTransform = matrix;
  near(system.simulationToWorld(particle.position.clone()), new THREE.Vector3(21, 0, 0));
  matrix.makeTranslation(40, 0, 0);
  near(system.simulationToWorld(particle.position.clone()), new THREE.Vector3(31, 0, 0));
  system.simulationSpaceTransform = null;
  near(particle.position, new THREE.Vector3(31, 0, 0));
  system.destroy();
});

test('explicit child spaces survive parenting; unspecified Transform inherits its frame', () => {
  const anchor = new THREE.Object3D(); anchor.position.x = 7;
  const parent = root({ simulationSpace: 'transform', simulationSpaceTransform: anchor });
  const attached = child(), inherited = root(), independent = root({ simulationSpace: 'world' });
  parent.addSubSystem(attached, {}); parent.addSubSystem(inherited, {}); parent.addSubSystem(independent, {});
  assert.equal(attached.simulationSpace, 'source');
  near(inherited.simulationToWorld(new THREE.Vector3()), new THREE.Vector3(7, 0, 0));
  parent.simulationSpace = 'local';
  assert.equal(attached.simulationSpace, 'source');
  assert.equal(independent.simulationSpace, 'world');
  assert.equal(inherited.simulationSpace, 'local');
  parent.destroy();
});

for (const custom of [false, true]) test(`Source follows TRS in delayed ${custom ? 'custom' : 'spawn'} runs`, () => {
  const parent = root(), glow = child();
  parent.addSubSystem(glow, { inheritLifetime: 0, inheritScale: 1,
    ...(custom ? { onEvent: { pulse: () => ({}) } } : { emitOnSpawn: true }) });
  const source = parent.registerEmissionSource({ transform: pose(2) });
  if (custom) source.emitEvent('pulse');
  step(parent);
  assert.equal(glow.particles.length, 1);
  near(glow.particles[0].position, new THREE.Vector3(3, 0, 0));
  source.update({ transform: pose(4, Math.PI / 2, 2) });
  step(parent);
  near(glow.particles[0].position, new THREE.Vector3(4, 2, 0));
  near(glow.particles[0].scale, new THREE.Vector3(2, 2, 2));
  for (let i = 0; i < 4; i++) step(parent);
  assert.equal(glow.particles.length, 2);
  near(glow.particles[1].position, new THREE.Vector3(4, 2, 0));
  parent.destroy();
});

for (const sourceLoss of ['detach', 'kill']) test(`Source ${sourceLoss} handles source disposal and reuse`, () => {
  const parent = root(), glow = child({ sourceLoss });
  parent.addSubSystem(glow, { emitOnSpawn: true, inheritLifetime: 0 });
  const source = parent.registerEmissionSource({ transform: pose(2) });
  step(parent);
  const particle = glow.particles[0];
  source.dispose();
  parent.registerEmissionSource({ transform: pose(100) });
  step(parent);
  if (sourceLoss === 'kill') assert.equal(particle.alive, false);
  else near(particle.position, new THREE.Vector3(3, 0, 0));
  parent.reset();
  assert.equal(glow.particles.length, 0);
  assert.equal(glow._sourceFrames, undefined);
  parent.destroy();
});

test('death-born Source particles retain the final snapshot without an attachment', () => {
  const parent = root(), glow = child({ sourceLoss: 'kill' });
  parent.addSubSystem(glow, { emitOnDeath: true, inheritLifetime: 0 });
  const source = parent.registerEmissionSource({ transform: pose(5) });
  source.dispose(); step(parent);
  near(glow.particles[0].position, new THREE.Vector3(6, 0, 0));
  step(parent);
  assert.equal(glow.particles[0].alive, true);
  parent.destroy();
});

test('Source local motion survives frame changes and independent parent/child spaces', () => {
  const parent = root({ simulationSpace: 'world' }); parent.position.x = 10;
  const glow = child(); parent.addSubSystem(glow, { emitOnSpawn: true, inheritLifetime: 0 });
  const source = parent.registerEmissionSource({ transform: pose(12) });
  step(parent);
  const p = glow.particles[0];
  near(glow.simulationToWorld(p.position.clone()), new THREE.Vector3(13, 0, 0));
  p.velocity.set(1, 0, 0); p.cache();
  step(parent, 0.2);
  near(glow.simulationToWorld(p.position.clone()), new THREE.Vector3(13.2, 0, 0));
  source.update({ transform: pose(12, Math.PI / 2) });
  step(parent, 0.2);
  near(glow.simulationToWorld(p.position.clone()), new THREE.Vector3(12, 1.4, 0));
  near(p.velocity, new THREE.Vector3(0, 1, 0));
  parent.destroy();
});

test('Source freezes singular frames, resumes on recovery, and clears ownership on mode change', () => {
  const parent = root(), glow = child();
  parent.addSubSystem(glow, { emitOnSpawn: true, inheritLifetime: 0 });
  const source = parent.registerEmissionSource({ transform: pose(2) });
  step(parent);
  const particle = glow.particles[0];
  source.update({ transform: pose(8, 0, 0) }); step(parent);
  near(particle.position, new THREE.Vector3(3, 0, 0));
  source.update({ transform: pose(4) }); step(parent);
  near(particle.position, new THREE.Vector3(5, 0, 0));
  glow.simulationSpace = 'world';
  source.update({ transform: pose(100) }); step(parent);
  near(particle.position, new THREE.Vector3(5, 0, 0));
  parent.destroy();
});


test('inherited Transform mode changes preserve child and nested world poses', () => {
  const anchor = new THREE.Object3D(); anchor.position.x = 7;
  const parent = root({ simulationSpace: 'transform', simulationSpaceTransform: anchor });
  const inherited = root(), nested = root();
  parent.addSubSystem(inherited, {}); inherited.addSubSystem(nested, {});
  for (const system of [inherited, nested]) system.addParticle(new Particle({ position: new THREE.Vector3(1, 0, 0) }));
  parent.simulationSpace = 'world';
  for (const system of [inherited, nested]) {
    near(system.particles[0].position, new THREE.Vector3(8, 0, 0));
  }
  parent.destroy();
});

test('CPU ownership grows with sources, including WebGL renderer contexts', () => {
  const parent = root(), glow = child();
  glow._renderer = { isWebGLRenderer: true };
  parent.addSubSystem(glow, { emitOnSpawn: true, inheritLifetime: 0 });
  const sources = Array.from({ length: 9 }, (_, index) => parent.registerEmissionSource({ transform: pose(index) }));
  step(parent);
  assert.equal(glow.particles.length, 9);
  for (const [index, source] of sources.entries()) source.update({ transform: pose(index + 10) });
  step(parent);
  glow.particles.slice().sort((a, b) => a.position.x - b.position.x)
    .forEach((p, index) => near(p.position, new THREE.Vector3(index + 11, 0, 0)));
  parent.destroy();
});


test('mixed CPU followers invalidate a GPU source when its slot generation changes', async () => {
  const parent = root(), glow = child({ sourceLoss: 'kill' });
  parent.addSubSystem(glow, { emitOnSpawn: true, inheritLifetime: 0 });
  const source = new Particle({ position: new THREE.Vector3(2, 0, 0), lifetime: 10 });
  source.id = 'gpu:0:1'; parent.addParticle(source); parent._notifySpawn(source); step(parent);
  const follower = glow.particles[0];
  parent._isGPUProcessingActive = true;
  parent._readbackGPUParticles = async () => [{ slot: 0, generation: 2, valid: false, particle: new Particle() }];
  glow._updateCPUSourceFrames();
  await new Promise(resolve => setImmediate(resolve));
  glow._updateCPUSourceFrames();
  assert.equal(follower.alive, false);
  parent._isGPUProcessingActive = false;
  parent.destroy();
});

test('World parents default children to World while explicit Local and Source children retain their modes', () => {
  const parent = root({ simulationSpace: 'world' });
  const inherited = root(), local = root({ simulationSpace: 'local' }), attached = child();
  parent.addSubSystem(inherited, {}); parent.addSubSystem(local, {}); parent.addSubSystem(attached, {});
  assert.equal(inherited.simulationSpace, 'world');
  assert.equal(local.simulationSpace, 'local');
  assert.equal(attached.simulationSpace, 'source');
  parent.simulationSpace = 'transform';
  assert.equal(inherited.simulationSpace, 'transform');
  assert.equal(local.simulationSpace, 'local');
  assert.equal(attached.simulationSpace, 'source');
  parent.destroy();
});
