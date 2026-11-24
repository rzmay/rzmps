import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import path from 'node:path';
import * as THREE from 'three';
import { createServer } from 'vite';

// Load the actual preset through Vite for its asset imports, without a browser or factory setup.
const demo = path.resolve(import.meta.dirname, '..');
const server = await createServer({ root: demo, configFile: path.join(demo, 'vite.config.mjs'),
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const { createHeatLaserSweep } = await server.ssrLoadModule('/@fs' +
  path.resolve(demo, '../../examples/presets/heatLaser.js'));
const { decalWarps: Warp, sampleDecalWarp } = await server.ssrLoadModule('/@fs' +
  path.resolve(demo, '../../packages/rzmps/src/rendering/decals/decalWarp.utils.ts'));

function footprintWidth(warp, ray, hit) {
  const matrix = sampleDecalWarp(warp, { rotation: new THREE.Vector3() }, ray, hit);
  const edge = x => {
    const point = new THREE.Vector3(x, 0, 1).applyMatrix3(matrix);
    return point.x / point.z;
  };
  return edge(0.5) - edge(-0.5);
}

function fixture() {
  const sweep = createHeatLaserSweep();
  const receiver = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
  after(() => { receiver.geometry.dispose(); receiver.material.dispose(); });
  const hit = (x, object = receiver) => ({ object, point: new THREE.Vector3(x, 0, 0),
    face: { normal: new THREE.Vector3(0, 0, 1) } });
  return { sweep, receiver, hit };
}

function decal(receiver, x) {
  return { receiver, emissionTransform: new THREE.Matrix4().makeTranslation(x, 0, 0) };
}

test('sweep bridges the last accepted decal despite rejected/intermediate contacts', () => {
  const { sweep, receiver, hit } = fixture();
  sweep.contact(hit(0));
  const marks = [decal(receiver, 0)];
  const low = Warp.FromPoints(sweep.from, sweep.to, 64, 1);
  const high = Warp.FromPoints(sweep.from, sweep.to, 64, 1.25);
  for (let i = 0; i < 10; i++) {
    sweep.advance(1 / 60); sweep.contact(hit(0.05), marks);
    assert.equal(sweep.from.x, 0);
    assert.ok(Math.abs(footprintWidth(low, new THREE.Ray(), hit(0.05)) - 1) < 1e-6);
    assert.ok(Math.abs(footprintWidth(high, new THREE.Ray(), hit(0.05)) - 1.25) < 1e-6);
  }
  marks.push(decal(receiver, 0.05));
  sweep.contact(hit(0.08), marks);
  assert.equal(sweep.from.x, 0.05, 'only an accepted mark advances the anchor');
  assert.equal(sweep.to.x, 0.08);
});

test('reheating selects an older mark until the next accepted mark and follows receiver motion', () => {
  const { sweep, receiver, hit } = fixture();
  const older = decal(receiver, 0), newer = decal(receiver, 2), marks = [older, newer];
  sweep.contact(hit(0), marks, older);
  sweep.contact(hit(0.2), marks);
  assert.equal(sweep.from.x, 0, 'a reheat overrides the newest-created mark');
  receiver.position.x = 1;
  sweep.contact(hit(1.2), marks);
  assert.equal(sweep.from.x, 1, 'the surface-local mark anchor follows the receiver');
  const accepted = decal(receiver, 0.2); marks.push(accepted);
  sweep.contact(hit(1.4), marks);
  assert.equal(sweep.from.x, 1.2);
  marks.length = 0;
  sweep.contact(hit(2), marks);
  assert.equal(sweep.from.distanceTo(sweep.to), 0, 'expired/cleared marks cannot anchor another warp');
});

test('receiver changes, gaps, disable and scene resets never bridge marks', () => {
  for (const [interrupt, changeReceiver] of [
    [sweep => sweep.advance(0.101), false],
    [sweep => sweep.advance(1 / 60, false), false],
    [sweep => sweep.reset(), false],
    [() => {}, true],
  ]) {
    const { sweep, receiver, hit } = fixture(), marks = [decal(receiver, 0)];
    sweep.contact(hit(0)); sweep.contact(hit(0.05), marks);
    interrupt(sweep);
    sweep.contact(hit(10, changeReceiver ? new THREE.Object3D() : receiver), marks);
    assert.equal(sweep.from.distanceTo(sweep.to), 0);
  }
});
