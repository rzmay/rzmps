import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { DecalRenderer, DECAL_RENDERER_USER_DATA_KEY, Particle, ParticleSystem, Emitter, EmissionShape, Collision, ThreeCollisionBackend } from '../build/index.mjs';

const source = () => new Particle({ position: new THREE.Vector3(0, 1, 0), lifetime: 0.1 });
function fixture(options = {}, material = new THREE.MeshBasicMaterial()) {
  const renderer = new DecalRenderer(material, options);
  const system = new ParticleSystem({ emitters: [], renderers: [renderer], gravityModifier: 0 });
  const scene = new THREE.Scene();
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor, system);
  scene.updateMatrixWorld(true);
  return { renderer, system, scene, floor, material };
}
const mark = (floor) => floor.children.find((child) => child.userData[DECAL_RENDERER_USER_DATA_KEY]);
const bounds = (mesh) => new THREE.Box3().setFromBufferAttribute(mesh.geometry.getAttribute('position'));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, `${a} != ${b}`);

test('color shortcuts and per-axis sizes support dynamic inputs without mutating them', () => {
  for (const color of ['red', 0xff0000, () => new Set(['red']), ['red', 0xff0000]]) {
    const size = new THREE.Vector3(2, 3, 99);
    const { system, floor } = fixture({ color, size: () => size, distanceAffectsSize: 0.5 });
    system._notifySpawn(source());
    const decal = mark(floor);
    assert.ok(decal.material.color.equals(new THREE.Color('red')));
    const dimensions = bounds(decal).getSize(new THREE.Vector3());
    near(dimensions.x, 1.5);
    near(dimensions.y, 2.25);
    assert.deepEqual(size.toArray(), [2, 3, 99]);
    system.destroy();
  }
  for (const size of [new THREE.Vector3(0, 1, 1), new THREE.Vector3(1, NaN, 1)]) {
    const { renderer, system } = fixture({ size });
    system._notifySpawn(source());
    assert.equal(renderer.count, 0);
    system.destroy();
  }
});

test('ratio selects the same particles for events and continuous placement', () => {
  const { renderer, system } = fixture({ ratio: 0.5, onDeath: true, continuousRate: 2 });
  const selected = source(), excluded = source();
  selected.id = 'selected';
  excluded.id = 'zzzzzz';
  for (const p of [excluded, selected]) system._notifySpawn(p);
  assert.equal(renderer.count, 1);
  selected.realtime = excluded.realtime = 500;
  renderer.update([selected, excluded], system, 0.5);
  assert.equal(renderer.count, 2);
  for (const p of [excluded, selected]) system._notifyDeath(p);
  assert.equal(renderer.count, 3);
  renderer.ratio = 0;
  system._notifySpawn(selected);
  renderer.update([], system, 0.1);
  assert.equal(renderer.count, 3, 'disabling new projections preserves existing decals');
  system.destroy();
  for (const [ratio, expected] of [[undefined, 1], [-1, 0], [2, 1]]) {
    const f = fixture({ ratio });
    assert.equal(f.renderer.ratio, expected);
    f.system._notifySpawn(source());
    assert.equal(f.renderer.count, expected);
    f.system.destroy();
  }
});

test('selectors have independent defaults, stable order, counts, and do not mutate inputs', () => {
  const particle = source();
  const hits = [5, 1, 3, 2, 4].map((distance) => ({ distance }));
  for (const [selector, order, defaultCount] of [
    [DecalRenderer.Nearest, [1, 2, 3, 4, 5], 1],
    [DecalRenderer.Farthest, [5, 4, 3, 2, 1], 1],
    [DecalRenderer.All, [5, 1, 3, 2, 4], 5],
  ]) {
    assert.deepEqual(selector(hits, particle).map((h) => h.distance), order.slice(0, defaultCount));
    assert.deepEqual(selector(hits, particle, 4).map((h) => h.distance), order.slice(0, 4));
    assert.equal(selector(hits, particle, -1).length, 5);
    assert.equal(selector(hits, particle, 0).length, 0);
    assert.deepEqual(selector([], particle), []);
  }
  assert.deepEqual(hits.map((h) => h.distance), [5, 1, 3, 2, 4]);
});

test('Fibonacci sampler returns independent, spherical unit vectors and validates counts', () => {
  for (const n of [1, 2, 24, 100]) {
    const sample = DecalRenderer.Radial(n);
    const directions = sample(source());
    assert.equal(directions.length, n);
    for (const direction of directions) near(direction.length(), 1);
    if (n > 2) assert.ok(new THREE.Vector3().addVectors(directions[0], directions.at(-1)).length() < 1);
    directions[0].set(0, 0, 0);
    near(sample(source())[0].length(), 1);
  }
  for (const [n, count] of [[0, 1], [-1, 1], [1.5, 1], [NaN, 1], [Infinity, 1]]) {
    assert.equal(DecalRenderer.Radial(n)(source()).length, count);
  }
});

test('spawn occurs once; independent opacity survives particle death; owned resources dispose', () => {
  const { renderer, system, floor, material } = fixture({ lifetime: 2, opacity: (t) => 1 - t });
  let sharedDisposals = 0;
  material.addEventListener('dispose', () => sharedDisposals++);
  const p = source();
  system._notifySpawn(p);
  assert.equal(renderer.count, 1);
  const decal = mark(floor);
  assert.notEqual(decal.material, material);
  assert.equal(decal.name, '');
  let geometryDisposals = 0, materialDisposals = 0;
  decal.geometry.addEventListener('dispose', () => geometryDisposals++);
  decal.material.addEventListener('dispose', () => materialDisposals++);
  p.kill();
  system._notifyDeath(p);
  renderer.update([], system, 0.5);
  near(decal.material.opacity, 0.75);
  assert.equal(renderer.count, 1);
  renderer.update([], system, 1.5);
  assert.equal(renderer.count, 0);
  assert.equal(floor.children.length, 0);
  assert.equal(geometryDisposals, 1);
  assert.equal(materialDisposals, 1);
  system.destroy();
  assert.equal(sharedDisposals, 0);
  assert.equal(system._spawnListeners.length, 0);
  assert.equal(system._deathListeners.length, 0);
  assert.equal(system._collisionListeners.length, 0);
});

test('direction callbacks preserve state, invalid vectors skip safely, custom selection receives maxHits', () => {
  const fixed = new THREE.Vector3(0, -7, 0);
  let observed;
  const { system, renderer, floor } = fixture({
    direction: (p) => { assert.equal(p.position.y, 1); return [new THREE.Vector3(), new THREE.Vector3(NaN, 0, 0), fixed, fixed, fixed]; },
    hitSelection: (hits, p, maxHits) => { observed = { hits, p, maxHits }; return [null, {}, ...hits]; },
    maxHits: 2,
  });
  const p = source();
  system._notifySpawn(p);
  assert.equal(renderer.count, 2);
  assert.equal(observed.hits.length, 3);
  assert.equal(observed.p, p);
  assert.equal(observed.maxHits, 2);
  assert.equal(fixed.y, -7);
  assert.equal(p.position.y, 1);
  assert.equal(floor.children.length, 2);
  system.destroy();
});

test('direct selectors work through projection; same mesh can receive multiple hits', () => {
  for (const [hitSelection, maxHits, count] of [
    [DecalRenderer.Nearest, undefined, 1], [DecalRenderer.Nearest, 4, 4],
    [DecalRenderer.All, undefined, 5], [DecalRenderer.All, 4, 4],
    [DecalRenderer.Farthest, undefined, 1], [DecalRenderer.All, -1, 5], [DecalRenderer.All, 0, 0],
  ]) {
    const options = { direction: () => Array.from({ length: 5 }, (_, i) => new THREE.Vector3(i * 0.1, -1, 0)), hitSelection };
    if (maxHits !== undefined) options.maxHits = maxHits;
    const { system, renderer } = fixture(options);
    system._notifySpawn(source());
    assert.equal(renderer.count, count);
    system.destroy();
  }
});

test('collision contact bypasses sampling and respects simulation-space transforms', () => {
  for (const simulationSpace of ['world', 'local']) {
    const { system, renderer, floor, scene } = fixture({ onSpawn: false, onCollision: true, direction: () => { throw Error('Unexpected recast'); } });
    system.simulationSpace = simulationSpace;
    system.position.set(2, 3, 4);
    system.rotation.z = 0.4;
    system.scale.set(2, 3, 1);
    scene.updateMatrixWorld(true);
    const p = source();
    const point = new THREE.Vector3();
    const normal = new THREE.Vector3(0, 1, 0);
    if (simulationSpace === 'local') {
      point.applyMatrix4(system.matrixWorld.clone().invert());
      normal.transformDirection(system.matrixWorld.clone().invert());
    }
    system._notifySpawn(p);
    assert.equal(renderer.count, 0);
    system.notifyCollision(p, { point, normal, object: floor, impulse: new THREE.Vector3() });
    assert.equal(renderer.count, 1);
    const decal = mark(floor);
    const worldBounds = bounds(decal).applyMatrix4(floor.matrixWorld);
    near(worldBounds.getCenter(new THREE.Vector3()).y, 0.001);
    system.destroy();
  }
});

test('wall collisions use the contact normal with and without mesh identity in either simulation space', () => {
  for (const simulationSpace of ['world', 'local']) {
    for (const knownTarget of [true, false]) {
      const { system, renderer, floor: wall, scene } = fixture({
        onSpawn: false, onCollision: true,
        direction: () => { throw Error('Collision must not use the downward sampler'); },
      });
      wall.rotation.set(0, Math.PI / 2, 0);
      system.simulationSpace = simulationSpace;
      system.position.set(2, 3, 4);
      system.rotation.z = 0.4;
      system.scale.set(2, 3, 1);
      scene.updateMatrixWorld(true);
      const p = source();
      p.position.set(0.5, 0, 0);
      const point = new THREE.Vector3();
      const normal = new THREE.Vector3(3, 0, 0);
      if (simulationSpace === 'local') {
        const inverse = system.matrixWorld.clone().invert();
        p.position.applyMatrix4(inverse);
        point.applyMatrix4(inverse);
        normal.transformDirection(inverse);
      }
      const originalNormal = normal.clone();
      system.notifyCollision(p, {
        point, normal, impulse: new THREE.Vector3(), object: knownTarget ? wall : undefined,
      });
      assert.equal(renderer.count, 1, `${simulationSpace}, target known: ${knownTarget}`);
      const worldBounds = bounds(mark(wall)).applyMatrix4(wall.matrixWorld);
      near(worldBounds.getCenter(new THREE.Vector3()).x, 0.001);
      near(worldBounds.getSize(new THREE.Vector3()).y, 1);
      near(worldBounds.getSize(new THREE.Vector3()).z, 1);
      assert.ok(normal.equals(originalNormal), 'projection must not mutate the collision normal');
      system.destroy();
    }
  }
});

test('death and contact-without-target use bounded fallback; depth is independent of ray range', () => {
  for (const depth of [0.01, 4]) {
    const { system, renderer } = fixture({ onSpawn: false, onDeath: true, onCollision: true, maxDistance: 0.5, depth });
    system._notifyDeath(source());
    system.notifyCollision(source(), { point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), impulse: new THREE.Vector3() });
    assert.equal(renderer.count, 0);
    const p = source(); p.position.y = 0.25;
    system._notifyDeath(p);
    assert.equal(renderer.count, 1);
    system.destroy();
  }
});

test('inheritance matches subsystem multiplication at zero, half and full, with independent materials', () => {
  for (const amount of [0, 0.5, 1]) {
    const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.8, 0.6, 0.4), opacity: 0.8 });
    const { system, floor } = fixture({ size: 2, color: new THREE.Color(0.5, 0.5, 0.5), inheritScale: amount, inheritColor: amount, inheritAlpha: amount }, material);
    const p = source(); p.scale.set(2, 4, 8); p.color.setRGB(0.2, 0.4, 0.6); p.alpha = 0.25;
    system._notifySpawn(p);
    const decal = mark(floor);
    const extent = bounds(decal).getSize(new THREE.Vector3());
    near(extent.x, 2 * THREE.MathUtils.lerp(1, 2, amount));
    near(extent.y, 2 * THREE.MathUtils.lerp(1, 4, amount));
    near(decal.material.color.r, 0.8 * 0.5 * THREE.MathUtils.lerp(1, 0.2, amount));
    near(decal.material.opacity, 0.8 * THREE.MathUtils.lerp(1, 0.25, amount));
    p.color.setRGB(1, 1, 1); p.alpha = 1;
    system._notifySpawn(p);
    assert.notEqual(floor.children[0].material, floor.children[1].material);
    near(floor.children[1].material.opacity, 0.8);
    near(material.opacity, 0.8);
    system.destroy();
  }
});

test('rotated/nonuniform mesh normals align geometry; rigid movement follows target', () => {
  const { floor, scene, system, renderer } = fixture({ onSpawn: false, onCollision: true });
  floor.rotation.set(0.4, 0.7, 0.3); floor.scale.set(2, 3, 0.5); floor.position.set(1, 2, 3);
  scene.updateMatrixWorld(true);
  const normal = new THREE.Vector3(0, 0, 1).applyMatrix3(new THREE.Matrix3().getNormalMatrix(floor.matrixWorld)).normalize();
  system.notifyCollision(source(), { object: floor, point: floor.position.clone(), normal, impulse: new THREE.Vector3() });
  assert.equal(renderer.count, 1);
  const decal = mark(floor);
  const positions = decal.geometry.getAttribute('position');
  for (let i = 0; i < positions.count; i++) {
    const world = new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(floor.matrixWorld);
    near(world.sub(floor.position).dot(normal), 0.001);
  }
  scene.updateMatrixWorld(true);
  const first = new THREE.Vector3().fromBufferAttribute(positions, 0).applyMatrix4(decal.matrixWorld);
  floor.position.x += 5; scene.updateMatrixWorld(true);
  const moved = new THREE.Vector3().fromBufferAttribute(positions, 0).applyMatrix4(decal.matrixWorld);
  near(moved.x - first.x, 5);
  system.destroy();
});

test('capacity, repeated clear/setup/reset/destroy, tag filtering, unsupported targets and GPU aging', () => {
  const { system, renderer, floor } = fixture({ maxDecals: 2, tags: 'mark' });
  const p = source();
  system._notifySpawn(p); assert.equal(renderer.count, 0);
  p.tags = ['mark'];
  renderer.setup(system); renderer.setup(system);
  assert.equal(system._spawnListeners.length, 1);
  for (let cycle = 0; cycle < 3; cycle++) {
    system._notifySpawn(p);
    const oldest = mark(floor);
    let disposed = false; oldest.geometry.addEventListener('dispose', () => disposed = true);
    system._notifySpawn(p); system._notifySpawn(p);
    assert.equal(renderer.count, 2); assert.ok(disposed);
    renderer.clear(); assert.equal(floor.children.length, 0);
  }
  system._notifySpawn(p);
  renderer.updateGPU({}, system, 9);
  assert.equal(renderer.count, 0);
  system._notifySpawn(p); renderer.reset(); assert.equal(renderer.count, 0);
  renderer.destroy(); renderer.destroy();
  system._notifySpawn(p); assert.equal(renderer.count, 0);
  system.destroy();
  for (const target of [new THREE.SkinnedMesh(new THREE.PlaneGeometry()), new THREE.InstancedMesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial(), 1)]) {
    const f = fixture({ direction: new THREE.Vector3() });
    f.scene.remove(f.floor); f.scene.add(target);
    f.system._notifySpawn(source()); assert.equal(f.renderer.count, 0); f.system.destroy();
  }
});

test('scene queries ignore decal and particle renderer geometry; backend raycasts honor membership', () => {
  const { system, scene, floor, renderer } = fixture();
  const ignored = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  ignored.rotation.x = -Math.PI / 2; ignored.position.y = 0.5;
  ignored.userData.__rzmps_particleRendererObject = true;
  scene.add(ignored); scene.updateMatrixWorld(true);
  system._notifySpawn(source()); assert.equal(renderer.count, 1); assert.ok(mark(floor));
  const backend = new ThreeCollisionBackend({ world: scene, staticObjects: [], dynamicObjects: [] });
  system.addModule(new Collision({ backend }));
  system._notifySpawn(source()); assert.equal(renderer.count, 1);
  backend.staticObjects = [floor]; backend.update(0);
  system._notifySpawn(source()); assert.equal(renderer.count, 2);
  const raycaster = new THREE.Raycaster(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0), 0, 2);
  assert.equal(backend.raycast(raycaster).filter((h) => h.object !== floor).length, 0);
  system.destroy();
});

test('dynamic creation values snapshot age; invalid lifetime and dimensions create nothing', () => {
  for (const lifetime of [0, -1, NaN, Infinity]) {
    const { system, renderer } = fixture({ lifetime }); system._notifySpawn(source());
    assert.equal(renderer.count, 0); system.destroy();
  }
  const observed = [];
  const { system, renderer, floor } = fixture({ lifetime: (t) => { observed.push(t); return 2; }, size: (t) => 1 + t });
  const p = source(); p.time = 0.5;
  system._notifySpawn(p); p.time = 1;
  near(bounds(mark(floor)).getSize(new THREE.Vector3()).x, 1.5);
  renderer.update([], system, 1); assert.deepEqual(observed, [0.5]);
  renderer.update([], system, 1); assert.equal(renderer.count, 0); system.destroy();
});

test('actual emitter, collision, pause, stop, reset, and system removal lifecycle', () => {
  const { scene, system, floor, renderer } = fixture({ lifetime: 10, onSpawn: false, onCollision: true });
  system.addEmitter(new Emitter({ source: EmissionShape.Sphere(0.001), radialSpeed: 0, rate: 0, bursts: [{ time: 0, count: 1 }], initialValues: {
    position: new THREE.Vector3(0, 0.3, 0), velocity: new THREE.Vector3(0, -3, 0), scale: new THREE.Vector3(0.1, 0.1, 0.1), lifetime: 1,
  } }));
  system.addModule(new Collision({ lifetimeLoss: 1 }));
  system.advanceFrames(20, 1 / 60);
  assert.ok(renderer.count > 0);
  const opacity = mark(floor).material.opacity;
  system.pause(); system.advanceFrames(20, 1 / 60); near(mark(floor).material.opacity, opacity);
  system.stop(false); system.advanceFrames(1, 1 / 60); assert.ok(renderer.count > 0);
  scene.remove(system); assert.equal(renderer.count, 0);
  scene.add(system); system.reset(); system.advanceFrames(20, 1 / 60); assert.ok(renderer.count > 0);
  system.stop(true); assert.equal(renderer.count, 0);
  system.destroy();
});

test('depth controls projector Z clipping, independently of collision distance', () => {
  for (const [depth, thickness] of [[0.1, 0], [2, 1]]) {
    const { system, renderer, floor } = fixture({ onSpawn: false, onCollision: true, depth, maxDistance: 0.01 });
    floor.geometry = new THREE.BoxGeometry(4, 4, 1);
    floor.rotation.set(0, 0, 0); floor.updateMatrixWorld(true);
    system.notifyCollision(source(), { object: floor, point: new THREE.Vector3(0, 0, 0.5), normal: new THREE.Vector3(0, 0, 1), impulse: new THREE.Vector3() });
    assert.equal(renderer.count, 1);
    near(bounds(mark(floor)).getSize(new THREE.Vector3()).z, thickness);
    system.destroy();
  }
});

test('raycast normals on transformed meshes and backside hits retain outgoing orientation', () => {
  const { system, floor, renderer } = fixture();
  floor.rotation.set(0.4, 0.7, 0.3); floor.scale.set(2, 3, 0.5);
  floor.updateMatrixWorld(true);
  const normal = new THREE.Vector3(0, 0, 1).applyMatrix3(new THREE.Matrix3().getNormalMatrix(floor.matrixWorld)).normalize();
  renderer.direction = normal.clone().negate();
  const p = source(); p.position.copy(normal);
  system._notifySpawn(p);
  assert.equal(renderer.count, 1);
  const decal = mark(floor);
  const first = new THREE.Vector3().fromBufferAttribute(decal.geometry.getAttribute('position'), 0).applyMatrix4(floor.matrixWorld);
  near(first.dot(normal), 0.001);
  renderer.direction = normal.clone(); p.position.copy(normal).negate();
  system._notifySpawn(p);
  assert.equal(renderer.count, 2);
  const back = floor.children[1];
  const world = new THREE.Vector3().fromBufferAttribute(back.geometry.getAttribute('position'), 0).applyMatrix4(floor.matrixWorld);
  near(world.dot(normal), 0.001);
  system.destroy();
});

test('distance attenuation favors near hits and custom selection may return fewer than cap', () => {
  for (const distance of [0.5, 1.5]) {
    const { system, floor } = fixture({ size: 2, maxDistance: 2, distanceAffectsSize: 1, distanceAffectsOpacity: 1, maxHits: 4,
      hitSelection: (hits, particle, count) => DecalRenderer.Nearest(hits, particle, 1),
    });
    const p = source(); p.position.y = distance;
    system._notifySpawn(p);
    assert.equal(floor.children.length, 1);
    near(mark(floor).material.opacity, 1 - distance / 2);
    near(bounds(mark(floor)).getSize(new THREE.Vector3()).x, 2 * (1 - distance / 2));
    system.destroy();
  }
});

test('continuousRate defaults to disabled and validates the configured rate', () => {
  const { system, renderer } = fixture({ onSpawn: false });
  const p = source();
  system._notifySpawn(p);
  p.realtime = 5000;
  renderer.update([p], system, 5);
  assert.equal(renderer.count, 0);
  system.destroy();
  for (const rate of [-1, NaN, Infinity]) {
    const renderer = new DecalRenderer(new THREE.MeshBasicMaterial(), { continuousRate: rate });
    assert.equal(renderer.continuousRate, 0);
    renderer.destroy();
  }
});

test('continuous projections follow each live particle age, tags and fractional intervals', () => {
  const { renderer, system } = fixture({ onSpawn: false, continuousRate: 2, tags: 'scorch' });
  const a = source(), b = source(), excluded = source();
  a.tags = b.tags = ['scorch'];
  for (const p of [a, b, excluded]) system._notifySpawn(p);
  a.realtime = b.realtime = excluded.realtime = 250;
  renderer.update([a, b, excluded], system, 0.25);
  assert.equal(renderer.count, 0);
  a.realtime = b.realtime = excluded.realtime = 500;
  renderer.update([a, b, excluded], system, 0.25);
  assert.equal(renderer.count, 2);
  // Reprocessing the same snapshot cannot duplicate an interval.
  renderer.update([a, b, excluded], system, 0);
  assert.equal(renderer.count, 2);
  a.realtime = 1500;
  b.kill(); system._notifyDeath(b);
  renderer.update([a, b, excluded], system, 1);
  assert.equal(renderer.count, 4);
  assert.equal(renderer.continuousTicks.size, 1);
  renderer.clear();
  renderer.update([a], system, 0);
  assert.equal(renderer.count, 0, 'clear must not replay earlier particle ages');
  a.realtime = 2000;
  renderer.update([a], system, 0.5);
  assert.equal(renderer.count, 1);
  renderer.destroy();
  assert.equal(renderer.continuousTicks.size, 0);
  system.destroy();
});

test('continuous projections work through simulation, pause, stop and reset', () => {
  const { renderer, system } = fixture({ continuousRate: 4, onSpawn: false, lifetime: 5 });
  system.addEmitter(new Emitter({
    source: EmissionShape.Sphere(0.001), radialSpeed: 0, rate: 0,
    bursts: [{ time: 0, count: 1 }],
    initialValues: { position: new THREE.Vector3(0, 1, 0), lifetime: 2 },
  }));
  system.advanceFrames(2, 0.25);
  assert.equal(renderer.count, 2);
  system.pause(); system.advanceFrames(4, 0.25);
  assert.equal(renderer.count, 2);
  system.stop(false); system.advanceFrames(2, 0.25);
  assert.equal(renderer.count, 4, 'retained particles keep projecting after emission stops');
  system.reset(); assert.equal(renderer.count, 0);
  system.advanceFrames(1, 0.25); assert.equal(renderer.count, 1);
  system.stop(true); assert.equal(renderer.count, 0);
  assert.equal(renderer.continuousTicks.size, 0);
  system.destroy();
});

test('GPU continuous mode uses updateCPUFromGPU without a rate cap or double-aging decals', async () => {
  const { renderer, system, floor } = fixture({ onSpawn: false, continuousRate: 20, lifetime: 2, opacity: t => 1 - t });
  const p = source(); system._notifySpawn(p);
  const requests = [];
  system.selectiveReadback = async (limit, fields) => {
    requests.push({ limit, fields });
    return [{ valid: true, particle: p }];
  };
  for (let i = 1; i <= 6; i++) {
    p.realtime = i * 50;
    renderer.updateGPU({ count: 1 }, system, 0.05);
    await new Promise(setImmediate);
  }
  assert.equal(requests.length, 6, 'each completed readback permits another on the next update');
  assert.equal(renderer.count, 6);
  near(floor.children[0].material.opacity, 1 - 0.25 / 2);
  assert.deepEqual(requests[0].fields, ['position', 'rotation', 'time', 'realtime', 'scale', 'color', 'alpha']);
  assert.equal(requests[0].limit, 1);
  system.destroy();
});

test('GPU continuous readbacks cancel on clear, skip paused projection, and preserve custom sampler inputs', async () => {
  const { renderer, system } = fixture({ onSpawn: false, continuousRate: 2, direction: p => p.velocity });
  const p = source(); p.velocity.set(0, -1, 0); system._notifySpawn(p);
  let resolve, calls = 0;
  system.selectiveReadback = (limit, fields) => {
    calls++;
    assert.equal(fields, undefined, 'arbitrary samplers can access every particle attribute');
    return new Promise(done => { resolve = done; });
  };
  renderer.updateGPU({ count: 1 }, system, 0.1);
  renderer.updateGPU({ count: 1 }, system, 0.1);
  assert.equal(calls, 1, 'reuse the base renderer guard for in-flight readbacks');
  renderer.clear(); p.realtime = 500;
  resolve([{ valid: true, particle: p }]);
  await new Promise(setImmediate);
  assert.equal(renderer.count, 0);
  renderer.updateGPU({ count: 1 }, system, 0.1);
  system.pause();
  resolve([{ valid: true, particle: p }]);
  await new Promise(setImmediate);
  assert.equal(renderer.count, 0);
  system.destroy();
});

test('Forward uses particle +Y orientation and a local rotation offset without mutating inputs', () => {
  const p = source();
  const forward = DecalRenderer.Forward();
  assert.deepEqual(forward(p).toArray(), [0, 1, 0]);
  p.rotation.z = Math.PI / 2;
  assert.ok(forward(p).distanceTo(new THREE.Vector3(-1, 0, 0)) < 1e-6);
  const offset = new THREE.Vector3(Math.PI, 0, 0);
  const backward = DecalRenderer.Forward(offset);
  assert.ok(backward(p).distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-6);
  assert.deepEqual(offset.toArray(), [Math.PI, 0, 0]);
  near(p.rotation.z, Math.PI / 2);
  backward(p).set(0, 0, 0);
  near(backward(p).length(), 1);
  offset.set(0, 0, 0);
  assert.ok(backward(p).distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-6);
  const { system, renderer } = fixture({ direction: DecalRenderer.Forward(new THREE.Vector3(Math.PI, 0, 0)) });
  system._notifySpawn(source());
  assert.equal(renderer.count, 1);
  system.destroy();
});

test('decal options initialize public properties and clamp invalid numeric configuration', () => {
  const renderer = new DecalRenderer(new THREE.MeshBasicMaterial(), {
    maxDistance: -4, depth: 0, offset: NaN, maxDecals: -2, maxHits: 2.9, continuousRate: -1,
  });
  assert.equal('options' in renderer, false);
  assert.equal(renderer.maxDistance, Number.EPSILON);
  assert.equal(renderer.depth, Number.EPSILON);
  assert.equal(renderer.offset, 0.001);
  assert.equal(renderer.maxDecals, 0);
  assert.equal(renderer.maxHits, 2);
  assert.equal(renderer.continuousRate, 0);
  renderer.destroy();
  const fallback = new DecalRenderer(new THREE.MeshBasicMaterial(), {
    maxDistance: NaN, depth: Infinity, maxDecals: Infinity, maxHits: NaN,
  });
  assert.equal(fallback.maxDistance, 2);
  assert.equal(fallback.depth, 0.1);
  assert.equal(fallback.maxDecals, 256);
  assert.equal(fallback.maxHits, 0);
  fallback.destroy();
  const { renderer: live, system } = fixture({ onSpawn: false });
  live.onSpawn = true;
  live.size = 2;
  system._notifySpawn(source());
  assert.equal(live.count, 1);
  live.maxDecals = 0;
  system._notifySpawn(source());
  assert.equal(live.count, 1);
  system.destroy();
});
