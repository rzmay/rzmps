import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { DecalRenderer, Particle, ParticleSystem, Renderer, SurfaceRenderer } from '../../build/index.mjs';

function fixture(options = {}, target = new THREE.PlaneGeometry(30, 30)) {
  const decal = new DecalRenderer(new THREE.MeshStandardMaterial({ opacity: 0.2, roughness: 0.1 }), options);
  const system = new ParticleSystem({ emitters: [], renderers: [decal] });
  const scene = new THREE.Scene(), receiver = new THREE.Mesh(target, new THREE.MeshBasicMaterial());
  receiver.rotation.x = -Math.PI / 2;
  scene.add(receiver, system); scene.updateMatrixWorld(true);
  const particle = new Particle({ position: new THREE.Vector3(0, 0.5, 0), lifetime: 10 });
  return { decal, system, receiver, particle };
}

function dimensions(decal) {
  const geometry = decal.decals[0].geometry;
  return new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position')).getSize(new THREE.Vector3());
}
// Recover the actual UV footprint; clipping geometry also includes transparent projector coverage.
function footprintMatrix(decal) {
  const geometry = decal.decals[0].geometry;
  const a = geometry.getAttribute('decalWarp0').array;
  const b = geometry.getAttribute('decalWarp1').array;
  return new THREE.Matrix3().set(a[0], a[1], 0, a[2], a[3], 0, b[0], b[1], 1).invert();
}

function footprintPoint(matrix, x, y) {
  const p = new THREE.Vector3(x, y, 1).applyMatrix3(matrix);
  return new THREE.Vector2(p.x / p.z, p.y / p.z);
}

function footprintWidth(decal) {
  const matrix = footprintMatrix(decal);
  return footprintPoint(matrix, 0.5, 0).x - footprintPoint(matrix, -0.5, 0).x;
}

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-4, `${a} != ${b}`);

test('renderer conditions precede grouping/children and do not expire persistent output', () => {
  class Capture extends Renderer {
    setup() {} clear() {} destroy() {} _update(particles) { this.particles = particles; }
  }
  const system = new ParticleSystem({ emitters: [], renderers: [] });
  const particles = [0, 1, 2, 3].map(x => new Particle({ position: new THREE.Vector3(x, 0, 0) }));
  const capture = new Capture({ condition: p => p.position.x >= 2, count: 1, children: { count: 2 } });
  capture.update(particles, system);
  assert.equal(capture.particles.length, 3);
  assert.ok(capture.particles.every(p => p.position.x >= 2));
  assert.equal(capture.particles[0].contribution, 2);
  system.destroy();

  let eligible = false, rays = 0;
  const f = fixture({ condition: () => eligible, direction: () => { rays++; return new THREE.Vector3(0, -1, 0); } });
  f.system._notifySpawn(f.particle);
  assert.equal(rays, 0); assert.equal(f.decal.count, 0); assert.equal(f.decal.batchDiagnostics.batchCount, 0);
  eligible = true; f.system._notifySpawn(f.particle);
  eligible = false; f.decal.update([f.particle], f.system, 0.5);
  assert.equal(f.decal.count, 1); assert.equal(rays, 1);
  f.system.destroy();
});

test('warp helpers bound the rectangular projector without deforming the receiver surface', () => {
  for (const [warp, x, y] of [
    [undefined, 1, 1], [DecalRenderer.Warp.FromRay(), 1, 1],
    [DecalRenderer.Warp.Scale(new THREE.Vector2(2, 1)), 2, 1],
    [DecalRenderer.Warp.Combine(DecalRenderer.Warp.Scale(new THREE.Vector2(2, 1)),
      DecalRenderer.Warp.Rotate(Math.PI / 2)), 1, 2],
    [DecalRenderer.Warp.Skew(new THREE.Vector2(0.5, 0)), 1.5, 1],
    [DecalRenderer.Warp.Perspective(new THREE.Vector2(0.5, 0)), 16 / 15, 4 / 3],
  ]) {
    const f = fixture({ warp }); f.system._notifySpawn(f.particle);
    assert.equal(f.decal.count, 1);
    const size = dimensions(f.decal); near(size.x, x); near(size.y, y);
    const geometry = f.decal.decals[0].geometry;
    for (const name of ['position', 'decalWarp0', 'decalWarp1']) {
      assert.ok(geometry.getAttribute(name).array.every(Number.isFinite));
    }
    // The local receiver is a plane: warping changes UVs/projector coverage, never its clipped Z.
    near(size.z, 0);
    f.system.destroy();
  }
});

test('actual oblique/grazing placement rays stretch finitely; singular footprints are rejected', () => {
  for (const direction of [new THREE.Vector3(1, -1, 0), new THREE.Vector3(1, -0.001, 0)]) {
    let seen;
    const incidence = DecalRenderer.Warp.FromRay();
    const f = fixture({ direction, maxDistance: 2000, warp: (particle, ray, hit) => {
      seen = ray.clone(); return incidence(particle, ray, hit);
    } }, new THREE.PlaneGeometry(5000, 5000));
    f.system._notifySpawn(f.particle);
    assert.equal(f.decal.count, 1);
    near(seen.direction.dot(direction.clone().normalize()), 1);
    const size = dimensions(f.decal); assert.ok(size.x > 1.3 && size.x <= 10.001);
    f.system.destroy();
  }
  for (const warp of [DecalRenderer.Warp.Scale(0),
    DecalRenderer.Warp.Perspective(new THREE.Vector2(3, 0))]) {
    const f = fixture({ warp }); f.system._notifySpawn(f.particle);
    assert.equal(f.decal.count, 0); assert.equal(f.decal.batchDiagnostics.batchCount, 0);
    f.system.destroy();
  }
});

test('batches share material/geometry storage, preserve independent warp/fade and recycle slots', () => {
  const f = fixture({ maxDecals: 1000, lifetime: 1, opacity: age => 1 - age,
    warp: p => DecalRenderer.Warp.Scale(p.scale.x) });
  for (let i = 0; i < 100; i++) {
    f.particle.position.x = (i % 10) * 0.1;
    f.particle.scale.setScalar(i % 2 ? 1 : 1.2);
    f.system._notifySpawn(f.particle);
  }
  assert.equal(f.decal.count, 100); assert.equal(f.decal.batchDiagnostics.batchCount, 1);
  assert.equal(new Set(f.decal.decals.map(d => d.mesh)).size, 1);
  assert.equal(f.receiver.children.length, 0, 'marks are batch instances, not child meshes');
  const first = f.decal.decals[0], before = new THREE.Matrix4();
  first.mesh.getMatrixAt(first.slot.instance, before);
  f.receiver.position.x += 3; f.decal.update([], f.system, 0.5);
  const after = new THREE.Matrix4(); first.mesh.getMatrixAt(first.slot.instance, after);
  near(after.elements[12] - before.elements[12], 3);
  const rgba = new THREE.Vector4(); first.mesh.getColorAt(first.slot.instance, rgba); near(rgba.w, 0.1);
  const reserved = f.decal.batchDiagnostics.reservedGeometryVertices;
  f.decal.update([], f.system, 0.5); assert.equal(f.decal.count, 0);
  for (let i = 0; i < 100; i++) f.system._notifySpawn(f.particle);
  assert.equal(f.decal.batchDiagnostics.reservedGeometryVertices, reserved);
  assert.ok(f.decal.batchDiagnostics.batchRepacks > 0);
  f.system.destroy();
});


test('curved and edge receivers retain Three.js clipping under projective warps', () => {
  for (const target of [new THREE.SphereGeometry(1, 16, 12), new THREE.BoxGeometry(2, 1, 2)]) {
    const f = fixture({ maxDistance: 4, depth: 1, warp: DecalRenderer.Warp.Combine(
      DecalRenderer.Warp.Scale(new THREE.Vector2(1.8, 0.8)),
      DecalRenderer.Warp.Perspective(new THREE.Vector2(0.4, 0.1))), offset: 0 }, target);
    f.particle.position.set(0.7, 2, 0);
    f.system._notifySpawn(f.particle);
    assert.equal(f.decal.count, 1);
    target.computeBoundingBox();
    const bounds = target.boundingBox.clone().expandByScalar(1e-5);
    const positions = f.decal.decals[0].geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) {
      assert.ok(bounds.containsPoint(new THREE.Vector3().fromBufferAttribute(positions, i)));
    }
    f.system.destroy(); target.dispose();
  }
});

test('liquid warps project the existing anisotropic kernel onto the contact plane', () => {
  const surface = new SurfaceRenderer(), particle = new Particle();
  const receiver = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
  receiver.updateMatrixWorld();
  const hit = { object: receiver, point: new THREE.Vector3(), face: { normal: new THREE.Vector3(0, 0, 1) } };
  const sampler = surface.decalWarp();
  surface.decalSamples.samples.set(particle, { normal: new THREE.Vector3(0, 1, 0),
    axes: new THREE.Matrix3().set(4, 0, 0, 0, 1, 0, 0, 0, 1) });
  const stretched = sampler(particle, new THREE.Ray(), hit);
  near(stretched.scale.x, 2); near(stretched.scale.y, 1);
  hit.face.normal.set(1, 0, 0);
  const perpendicular = sampler(particle, new THREE.Ray(), hit);
  near(perpendicular.scale.x, 1); near(perpendicular.scale.y, 1);
  surface.destroy(); receiver.geometry.dispose(); receiver.material.dispose();
});


test('color/opacity-only template differences share a batch while genuine render states split', () => {
  const red = new THREE.MeshBasicMaterial({ color: 'red', opacity: 0.2 });
  const blue = new THREE.MeshBasicMaterial({ color: 'blue', opacity: 0.5 });
  const additive = new THREE.MeshBasicMaterial({ color: 'red', blending: THREE.AdditiveBlending });
  const f = fixture({ materialIndex: time => time });
  f.decal.material = [red, blue, additive];
  for (const time of [0, 1, 2]) { f.particle.time = time; f.system._notifySpawn(f.particle); }
  assert.equal(f.decal.count, 3); assert.equal(f.decal.batchDiagnostics.batchCount, 2);
  assert.equal(f.decal.decals[0].mesh, f.decal.decals[1].mesh);
  assert.notEqual(f.decal.decals[0].mesh, f.decal.decals[2].mesh);
  const first = new THREE.Vector4(), second = new THREE.Vector4();
  f.decal.decals[0].mesh.getColorAt(f.decal.decals[0].slot.instance, first);
  f.decal.decals[1].mesh.getColorAt(f.decal.decals[1].slot.instance, second);
  near(first.x, 1); near(first.w, 0.2); near(second.z, 1); near(second.w, 0.5);
  f.system.destroy(); red.dispose(); blue.dispose(); additive.dispose();
});

test('recent-contact suppression resets cleanly and never replaces separated footprints', () => {
  const f = fixture({ duplicateDistance: 0.1, duplicateInterval: 0.2, lifetime: 10 });
  f.system._notifySpawn(f.particle); f.system._notifySpawn(f.particle);
  assert.equal(f.decal.count, 1);
  f.particle.position.x += 0.5; f.system._notifySpawn(f.particle);
  assert.equal(f.decal.count, 2);
  f.decal.clear(); f.system._notifySpawn(f.particle);
  assert.equal(f.decal.count, 1, 'clearing removes the old suppression history');
  f.decal.update([], f.system, 0.3); f.system._notifySpawn(f.particle);
  assert.equal(f.decal.count, 2, 'old contact history does not permanently suppress new marks');
  f.system.destroy();
});

test('velocity warps follow incoming particle motion and respect its simulation frame', () => {
  const f = fixture({ warp: DecalRenderer.Warp.FromVelocity() });
  f.particle.velocity.set(2, -1, 0);
  f.system._notifySpawn(f.particle);
  near(footprintWidth(f.decal), 3);
  assert.deepEqual(f.particle.velocity.toArray(), [2, -1, 0]);
  f.system.destroy();

  const rotated = fixture({ warp: DecalRenderer.Warp.FromVelocity() });
  rotated.system.rotation.z = Math.PI / 2;
  rotated.system.updateWorldMatrix(true, false);
  rotated.particle.position.set(0.5, 0, 0);
  rotated.particle.velocity.set(1, 0, 0);
  rotated.system._notifySpawn(rotated.particle);
  // Local X is world Y: a perpendicular impact must stay round, not stretch tangentially.
  near(dimensions(rotated.decal).x, 1); near(dimensions(rotated.decal).y, 1);
  rotated.system.destroy();

  const still = fixture({ warp: DecalRenderer.Warp.FromVelocity() });
  still.particle.velocity.set(1, -0.001, 0); still.particle.speed = 0;
  still.system._notifySpawn(still.particle);
  near(dimensions(still.decal).x, 1);
  still.system.destroy();
});

test('incidence factories cap their own stretch without limiting custom warps', () => {
  for (const factory of [DecalRenderer.Warp.FromRay, DecalRenderer.Warp.FromVelocity]) {
    for (const [limit, expected] of [[undefined, 4], [2, 2], [1, 1], [0, 1], [NaN, 4], [20, 20]]) {
      const f = fixture({
        direction: new THREE.Vector3(1, -0.001, 0), maxDistance: 2000,
        warp: factory(limit),
      }, new THREE.PlaneGeometry(5000, 5000));
      f.particle.velocity.set(100, -0.1, 0);
      f.system._notifySpawn(f.particle);
      assert.equal(f.decal.count, 1);
      const size = dimensions(f.decal);
      if (factory === DecalRenderer.Warp.FromVelocity) near(footprintWidth(f.decal), expected);
      else { near(size.x, expected); near(size.y, 1); }
      f.system.destroy();
    }
  }
  const f = fixture({ warp: () => ({ scale: new THREE.Vector2(25, 1) }) });
  f.system._notifySpawn(f.particle);
  near(dimensions(f.decal).x, 25);
  f.system.destroy();
});


test('velocity stretch retains speed and exposes a factor independent of ray incidence', () => {
  for (const [speed, multiplier, factor, expected] of [
    [2, 1, 0.5, 2], [4, 1, 0.5, 3], [2, 2, 0.5, 3],
    [4, 1, 0, 1], [4, 1, -1, 1], [100, 1, 0.5, 10],
  ]) {
    const f = fixture({ warp: DecalRenderer.Warp.FromVelocity(10, factor) });
    f.particle.velocity.set(speed, -speed / 2, 0);
    f.particle.speed = multiplier;
    f.system._notifySpawn(f.particle);
    near(footprintWidth(f.decal), expected);
    assert.deepEqual(f.particle.velocity.toArray(), [speed, -speed / 2, 0]);
    f.system.destroy();
  }
});

// Reconstruct the physical inverse including translation folded into geometry UVs.
function bridgeFootprint(decal, rotation = 0, size = new THREE.Vector2(1, 1)) {
  const geometry = decal.decals[0].geometry, uv = geometry.getAttribute('uv');
  const positions = geometry.getAttribute('position');
  const values = geometry.getAttribute('decalWarp1').array;
  const point = new THREE.Vector2(positions.getX(0), positions.getY(0))
    .rotateAround(new THREE.Vector2(), -rotation).divide(size);
  const shift = new THREE.Vector2((uv.getX(0) - 0.5) * values[2], (uv.getY(0) - 0.5) * values[3]).sub(point);
  return footprintMatrix(decal).invert()
    .multiply(new THREE.Matrix3().set(1, 0, shift.x, 0, 1, shift.y, 0, 0, 1)).invert();
}

test('point-to-point bridges fit the gap, extend both ends for overlap, and honor stretch caps', () => {
  for (const [distance, overlap, expected] of [[0, 1.2, 1], [0.5, 1.2, 1.2], [2, 1, 2],
    [2, 1.25, 2.5], [20, 1.25, 4], [2, 0, 2]]) {
    const from = new THREE.Vector3(), to = new THREE.Vector3(distance, 10, 0);
    const original = [from.toArray(), to.toArray()];
    const f = fixture({ warp: DecalRenderer.Warp.FromPoints(from, to, 4, overlap) });
    f.particle.velocity.set(-100, -1, 100);
    f.system._notifySpawn(f.particle);
    const matrix = bridgeFootprint(f.decal);
    const left = footprintPoint(matrix, -0.5, 0), right = footprintPoint(matrix, 0.5, 0);
    near(right.x - left.x, expected);
    near((right.x + left.x) / 2, distance / 2);
    near(dimensions(f.decal).y, 1);
    assert.deepEqual([from.toArray(), to.toArray()], original);
    f.system.destroy();
  }
});

test('point-to-point bridges read updated endpoints and fit independently of ray incidence', () => {
  const from = new THREE.Vector3(), to = new THREE.Vector3();
  const warp = DecalRenderer.Warp.FromPoints(from, to, 4, 1.25);
  to.set(2, 0, 0);
  for (const direction of [new THREE.Vector3(0, -1, 0), new THREE.Vector3(-0.8, -1, 0.2)]) {
    const f = fixture({ direction, warp });
    f.system._notifySpawn(f.particle);
    const box = new THREE.Box3().setFromBufferAttribute(f.decal.decals[0].geometry.getAttribute('position'));
    near(box.min.x, -0.25); near(box.max.x, 2.25);
    near(box.min.y, -0.5); near(box.max.y, 0.5);
    f.system.destroy();
  }
  from.copy(to);
  const stopped = fixture({ warp });
  stopped.system._notifySpawn(stopped.particle);
  near(footprintWidth(stopped.decal), 1);
  stopped.system.destroy();
});

test('point-to-point world endpoints remain fixed when a placement callback shifts the projector', () => {
  const f = fixture({
    onSpawn: (_hit, _source, parameters) => { parameters.position.x = 3; },
    warp: DecalRenderer.Warp.FromPoints(new THREE.Vector3(), new THREE.Vector3(2, 0, 0), 4, 1.25),
  });
  f.system._notifySpawn(f.particle);
  const box = new THREE.Box3().setFromBufferAttribute(f.decal.decals[0].geometry.getAttribute('position'));
  near(box.min.x, -0.25); near(box.max.x, 2.25);
  f.system.destroy();
});

test('point-to-point fitting preserves randomized rotation, rectangular width and translated UV lookup', () => {
  for (const rotation of [0.23, 1.17, 2.41]) {
    const size = new THREE.Vector2(1.7, 0.8);
    const from = new THREE.Vector3(-1, 0, 0), to = new THREE.Vector3(2, 0, 0);
    const f = fixture({ rotation, size: new THREE.Vector3(size.x, size.y, 1),
      warp: DecalRenderer.Warp.FromPoints(from, to, 4, 1.2) });
    f.system._notifySpawn(f.particle);
    const matrix = bridgeFootprint(f.decal, rotation, size), box = new THREE.Box2();
    for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) {
      box.expandByPoint(footprintPoint(matrix, x, y).multiply(size).rotateAround(new THREE.Vector2(), rotation));
    }
    near(box.min.x, -1.3); near(box.max.x, 2.3);
    near(box.getSize(new THREE.Vector2()).y, Math.abs(Math.sin(rotation)) * size.x
      + Math.abs(Math.cos(rotation)) * size.y);
    f.system.destroy();
  }
});


test('velocity splats anchor impact/rear extent and stretch only the forward footprint', () => {
  for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI / 4]) {
    const u = new THREE.Vector2(Math.cos(angle), Math.sin(angle));
    const f = fixture({ warp: DecalRenderer.Warp.FromVelocity(3, 1) });
    // Receiver projector axes are world X and -Z on this horizontal plane.
    f.particle.velocity.set(2 * u.x, -1, -2 * u.y);
    f.system._notifySpawn(f.particle);
    const matrix = footprintMatrix(f.decal);
    near(footprintPoint(matrix, 0, 0).length(), 0);
    const support = (Math.abs(u.x) + Math.abs(u.y)) / 2;
    const rear = footprintPoint(matrix, -support * u.x, -support * u.y);
    const front = footprintPoint(matrix, support * u.x, support * u.y);
    near(rear.dot(u), -support);
    near(front.dot(u), 5 * support);
    near(front.clone().sub(rear).dot(u), 6 * support);
    // The back half stays close to its original scale; forward deformation is substantially greater.
    const backQuarter = footprintPoint(matrix, -0.25 * u.x, -0.25 * u.y).length();
    const frontQuarter = footprintPoint(matrix, 0.25 * u.x, 0.25 * u.y).length();
    assert.ok(backQuarter < 0.4 && frontQuarter > backQuarter);
    const inverse = matrix.clone().invert();
    for (const x of [-0.5, 0, 0.5]) for (const y of [-0.5, 0, 0.5]) {
      const projected = footprintPoint(matrix, x, y);
      const restored = footprintPoint(inverse, projected.x, projected.y);
      near(restored.x, x); near(restored.y, y);
    }
    f.system.destroy();
  }
});

test('source-less coverage composition shares a masked reset and releases it without appearance atlases', () => {
  let receiverPosition;
  const options = { inheritMaterial: false, unionCoverage: true,
    materialCompositeGPU: (_source, dest, context) => {
      receiverPosition = context.receiverPositionLocal;
      return { color: dest.color };
    } };
  const f = fixture(options);
  f.system._notifySpawn(f.particle);
  assert.ok(receiverPosition);
  assert.equal(f.decal.appearance, undefined);
  const material = f.decal.decals[0].mesh.material;
  assert.equal(material.stencilRef, 0x80);
  assert.equal(material.stencilWriteMask, 0x80);
  assert.equal(material.stencilFuncMask, 0x80);
  assert.equal(material.stencilFunc, THREE.NotEqualStencilFunc);
  assert.equal(material.stencilZPass, THREE.ReplaceStencilOp);
  const scene = f.receiver.parent;
  assert.equal(scene.children.filter(object => object.name === 'Decal coverage reset').length, 1);
  const reset = scene.getObjectByName('Decal coverage reset');
  assert.throws(() => reset.onBeforeRender({ getRenderTarget: () => ({ stencilBuffer: false }) }),
    /requires a stencil-enabled framebuffer/);
  const other = new DecalRenderer(new THREE.MeshStandardMaterial(), options);
  const owner = new ParticleSystem({ emitters: [], renderers: [other] });
  scene.add(owner); scene.updateMatrixWorld(true);
  owner._notifySpawn(f.particle.clone());
  assert.equal(scene.children.filter(object => object.name === 'Decal coverage reset').length, 1);
  f.system.destroy();
  assert.ok(scene.getObjectByName('Decal coverage reset'));
  owner.destroy();
  assert.equal(scene.getObjectByName('Decal coverage reset'), undefined);
});

test('liquid decal kernel projection preserves rotated principal axes', () => {
  const surface = new SurfaceRenderer(), particle = new Particle();
  const receiver = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
  receiver.updateMatrixWorld();
  const hit = { object: receiver, point: new THREE.Vector3(), face: { normal: new THREE.Vector3(0, 0, 1) } };
  // A 2:1 ellipsoid with its major tangent axis rotated 45 degrees.
  surface.decalSamples.samples.set(particle, { normal: new THREE.Vector3(0, 0, 1),
    axes: new THREE.Matrix3().set(2.5, 1.5, 0, 1.5, 2.5, 0, 0, 0, 1) });
  const warp = surface.decalWarp()(particle, new THREE.Ray(), hit);
  near(warp.scale.x, 2); near(warp.scale.y, 1); near(warp.rotation, Math.PI / 4);
  particle.rotation.z = Math.PI / 4;
  const rolled = surface.decalWarp()(particle, new THREE.Ray(), hit);
  near(rolled.scale.x, 2); near(rolled.scale.y, 1); near(rolled.rotation, 0);
  surface.destroy(); receiver.geometry.dispose(); receiver.material.dispose();
});


test('forward splats clip their asymmetric footprint without shifting the impact UV', () => {
  const f = fixture({ warp: DecalRenderer.Warp.FromVelocity(3, 1), offset: 0 });
  f.particle.velocity.set(2, -1, 0);
  f.system._notifySpawn(f.particle);
  const geometry = f.decal.decals[0].geometry;
  geometry.computeBoundingBox();
  near(geometry.boundingBox.min.x, -0.5);
  near(geometry.boundingBox.max.x, 2.5);
  near(dimensions(f.decal).x, 3);
  // The source center still projects to the impact, even though clipping is centered farther forward.
  const positions = geometry.getAttribute('position'), uv = geometry.getAttribute('uv');
  const extents = new THREE.Vector2().fromArray(geometry.getAttribute('decalWarp1').array, 2);
  for (let i = 0; i < uv.count; i++) near((uv.getX(i) - 0.5) * extents.x, positions.getX(i));
  f.system.destroy();
});

test('renderer base rotation precedes incidence warping without changing the source particle', () => {
  const bounds = [];
  for (const rotation of [0, Math.PI / 2]) {
    const f = fixture({ rotation, warp: DecalRenderer.Warp.FromVelocity(4, 1) });
    f.particle.velocity.set(2, -1, 0);
    f.system._notifySpawn(f.particle);
    const matrix = footprintMatrix(f.decal);
    const orientation = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0))
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rotation));
    const box = new THREE.Box3();
    for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) {
      const point = footprintPoint(matrix, x, y);
      box.expandByPoint(new THREE.Vector3(point.x, point.y, 0).applyQuaternion(orientation));
    }
    bounds.push(box);
    near(f.particle.rotation.z, 0);
    f.system.destroy();
  }
  near(bounds[0].min.x, bounds[1].min.x);
  near(bounds[0].max.x, bounds[1].max.x);
  near(bounds[0].getSize(new THREE.Vector3()).z, bounds[1].getSize(new THREE.Vector3()).z);
});

test('arbitrary base rolls and rectangular projectors precede a fixed world-aligned ray warp', () => {
  const direction = new THREE.Vector3(0.6, -1, 0.4).normalize();
  const normal = new THREE.Vector3(0, 1, 0), axis = new THREE.Vector3(0, 0, 1);
  const frame = new THREE.Quaternion().setFromUnitVectors(axis, normal);
  const tangent = direction.clone().applyQuaternion(frame.clone().invert());
  const along = new THREE.Vector2(tangent.x, tangent.y).normalize();
  const stretch = 1 / Math.abs(direction.dot(normal));
  for (const roll of [0.23, 1.17, 2.41]) {
    const f = fixture({ rotation: roll, size: new THREE.Vector3(1.7, 0.8, 1),
      direction, warp: DecalRenderer.Warp.FromRay(4) });
    f.system._notifySpawn(f.particle);
    const warp = footprintMatrix(f.decal);
    for (const [x, y] of [[0.3, -0.2], [-0.4, 0.1], [0.2, 0.4]]) {
      // Rotate the original rectangle first, then stretch along the physical ray projection.
      const base = new THREE.Vector2(1.7 * x, 0.8 * y).rotateAround(new THREE.Vector2(), roll);
      const expected = base.clone().addScaledVector(along, (stretch - 1) * base.dot(along));
      const mapped = footprintPoint(warp, x, y).multiply(new THREE.Vector2(1.7, 0.8))
        .rotateAround(new THREE.Vector2(), roll);
      near(mapped.x, expected.x); near(mapped.y, expected.y);
    }
    f.system.destroy();
  }
});

test('static and combined warps also operate after randomized base rotation', () => {
  const roll = 0.67;
  const f = fixture({ rotation: roll, warp: DecalRenderer.Warp.Combine(
    DecalRenderer.Warp.Skew(new THREE.Vector2(0.4, 0)), DecalRenderer.Warp.Scale(new THREE.Vector2(2, 1))) });
  f.system._notifySpawn(f.particle);
  const point = new THREE.Vector2(0.3, 0.2), base = point.clone().rotateAround(new THREE.Vector2(), roll);
  const expected = new THREE.Vector2((base.x + 0.4 * base.y) * 2, base.y);
  const mapped = footprintPoint(footprintMatrix(f.decal), point.x, point.y)
    .rotateAround(new THREE.Vector2(), roll);
  near(mapped.x, expected.x); near(mapped.y, expected.y);
  f.system.destroy();
});
