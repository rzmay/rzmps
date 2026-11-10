import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { AudioRenderer, DecalRenderer, Particle, ParticleSystem } from '../../build/index.mjs';

function fixture(renderer) {
  const system = new ParticleSystem({ emitters: [], renderers: renderer, gravityModifier: 0 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshBasicMaterial());
  floor.rotation.x = -Math.PI / 2;
  const scene = new THREE.Scene();
  scene.add(system, floor);
  scene.updateMatrixWorld(true);
  return { system, floor };
}
const particle = () => new Particle({ position: new THREE.Vector3(0, 1, 0), lifetime: 10 });
const contact = floor => ({ object: floor, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
  impulse: new THREE.Vector3(0, 4, 0) });

test('decal collision callbacks transform evaluated impulse defaults once and can cancel', () => {
  let calls = 0;
  const view = new DecalRenderer(new THREE.MeshBasicMaterial({ color: 'red' }), {
    onSpawn: false, impulseAffectsSize: 0.5, impulseAffectsOpacity: 0.5, impulseAffectsLifetime: 0.5,
    size: 0.25, lifetime: 2,
    onCollision: (hit, source, parameters) => {
      calls++;
      assert.equal(hit.impulse.length(), 4);
      assert.equal(source.position.y, 1);
      assert.equal(parameters.size.x, 0.5);
      assert.equal(parameters.opacity, 2);
      assert.equal(parameters.lifetime, 4);
      return { size: parameters.size.clone().multiplyScalar(2), opacity: 0.4, color: new THREE.Color('blue') };
    },
  });
  const { system, floor } = fixture(view);
  const p = particle();
  system.notifyCollision(p, contact(floor));
  assert.equal(view.count, 1);
  assert.equal(view.decals[0].mesh.material.opacity, 0.4);
  assert.ok(view.decals[0].mesh.material.color.equals(new THREE.Color('blue')));
  const bounds = new THREE.Box3().setFromBufferAttribute(view.decals[0].mesh.geometry.getAttribute('position'));
  assert.ok(Math.abs(bounds.getSize(new THREE.Vector3()).x - 1) < 1e-5);
  view.update([], system, 0.1);
  assert.equal(calls, 1, 'the local event batch must not replay a synchronous collision hook');
  view.onEvent('collision', () => false);
  system.notifyCollision(p, contact(floor));
  assert.equal(view.count, 1);
  system.destroy(); floor.geometry.dispose(); floor.material.dispose();
});

test('decal custom events use registered sources and do not mutate source or template parameters', () => {
  const view = new DecalRenderer(new THREE.MeshBasicMaterial({ color: 'red' }), { onSpawn: false, size: 0.5,
    emissionTags: ['mark-output'] });
  const { system, floor } = fixture(view);
  const source = system.registerEmissionSource({ transform: new THREE.Matrix4().makeTranslation(0, 1, 0) });
  let calls = 0;
  view.onEvent('paint', (data, origin, parameters) => {
    calls++;
    assert.equal(origin, source);
    return { position: parameters.position.clone().add(new THREE.Vector3(2, 0, 0)),
      size: parameters.size.clone().multiplyScalar(data.scale), lifetime: 3,
      color: new THREE.Color('green') };
  });
  source.emitEvent('paint', { scale: 2 });
  view.update([], system, 0.1);
  assert.equal(calls, 1);
  assert.equal(view.count, 1);
  assert.equal(view.decals[0].lifetime, 3);
  assert.ok(Math.abs(view.decals[0].source.metadata.surface.uv.x - 0.6) < 1e-6);
  assert.ok(Math.abs(view.decals[0].source.position.x - 2) < 1e-6);
  assert.ok(view.decals[0].mesh.material.color.equals(new THREE.Color('green')));
  assert.equal(view.size, 0.5);
  assert.ok(view.material.color.equals(new THREE.Color('red')));
  assert.deepEqual(source.position.toArray(), [0, 1, 0]);
  view.update([], system, 0.1);
  assert.equal(calls, 1);
  system.destroy(); floor.geometry.dispose(); floor.material.dispose();
});

test('audio callbacks transform evaluated cue parameters and built-in aliases share a subscription', () => {
  const clip = {};
  const view = new AudioRenderer({ sound: clip, onSpawn: false, volume: 2, impulseAffectsVolume: 0.5,
    onCollision: (hit, source, parameters) => {
      assert.equal(source.position.y, 1);
      assert.equal(hit.impulse.length(), 4);
      assert.equal(parameters.volume, 4);
      return { volume: 0.25, pitch: 1.5, highPass: 100, lowPass: 1000 };
    } });
  const { system, floor } = fixture(view);
  const cues = [];
  view._playOneShot = parameters => cues.push(parameters);
  const p = particle();
  system.notifyCollision(p, contact(floor));
  assert.equal(cues.length, 1);
  assert.equal(cues[0].volume, 0.25);
  assert.equal(cues[0].sound, clip);
  assert.equal(cues[0].pitch, 1.5);
  assert.equal(cues[0].highPass, 100);
  view.update([], system, 0.1);
  assert.equal(cues.length, 1);
  view.onEvent('collision', () => false);
  system.notifyCollision(p, contact(floor));
  assert.equal(cues.length, 1);
  system.destroy(); floor.geometry.dispose(); floor.material.dispose();
});

test('audio custom events and lifecycle aliases both receive registered sources', () => {
  const clip = {};
  const view = new AudioRenderer({ sound: clip, onSpawnSound: clip });
  const { system, floor } = fixture(view);
  const cues = [];
  view._playOneShot = parameters => cues.push(parameters);
  const source = system.registerEmissionSource({ transform: new THREE.Matrix4().makeTranslation(1, 2, 3) });
  view.update([], system, 0.1);
  assert.equal(cues.length, 1, 'source registration dispatches the named spawn cue');
  cues.length = 0;
  view.onEvent('chime', (data, origin, parameters) => {
    assert.equal(origin, source);
    return { volume: data.gain, position: parameters.position.clone().add(new THREE.Vector3(1, 0, 0)) };
  });
  source.emitEvent('chime', { gain: 0.2 });
  view.update([], system, 0.1);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].volume, 0.2);
  assert.deepEqual(cues[0].position.toArray(), [2, 2, 3]);
  assert.deepEqual(source.position.toArray(), [1, 2, 3]);
  system.destroy(); floor.geometry.dispose(); floor.material.dispose();
});

test('renderer parameter subscriptions honor parent scope and transform source positions without mutation', () => {
  const clip = {};
  const audio = new AudioRenderer({ sound: clip, eventScope: 'parent', onSpawn: false,
    onEvent: { ping: (_data, source, parameters) => {
      assert.equal(source.position.x, 1);
      return { position: parameters.position.clone(), volume: 0.5 };
    } } });
  const parent = new ParticleSystem({ emitters: [], renderers: [], simulationSpace: 'local' });
  const child = new ParticleSystem({ emitters: [], renderers: audio, simulationSpace: 'local' });
  parent.addSubSystem(child);
  parent.position.x = 10;
  child.position.x = 2;
  parent.updateWorldMatrix(true, true);
  const cues = [];
  audio._playOneShot = parameters => cues.push(parameters);
  const source = parent.registerEmissionSource({ transform: new THREE.Matrix4().makeTranslation(1, 0, 0) });
  source.emitEvent('ping');
  audio.update([], child, 0.1);
  assert.equal(cues.length, 1);
  assert.ok(Math.abs(cues[0].position.x + 1) < 1e-6);
  const own = child.registerEmissionSource({ transform: new THREE.Matrix4() });
  own.emitEvent('ping');
  audio.update([], child, 0.1);
  assert.equal(cues.length, 1, 'parent scope must exclude local events');
  assert.equal(source.position.x, 1);
  parent.destroy();
});

test('runtime lifecycle callbacks subscribe to registered sources and unsubscribe when disabled', () => {
  const clip = {};
  const audio = new AudioRenderer({ sound: clip });
  const { system, floor } = fixture(audio);
  const cues = [];
  audio._playOneShot = parameters => cues.push(parameters);
  let calls = 0;
  audio.onSpawn = (_data, source, parameters) => {
    calls++;
    assert.equal(source.position.x, 3);
    return { volume: parameters.volume * 0.2 };
  };
  system.registerEmissionSource({ transform: new THREE.Matrix4().makeTranslation(3, 0, 0) });
  audio.update([], system, 0.1);
  assert.equal(calls, 1);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].volume, 0.2);

  audio.onSpawn = false;
  system.registerEmissionSource({ transform: new THREE.Matrix4() });
  audio.update([], system, 0.1);
  assert.equal(cues.length, 1);
  system.destroy(); floor.geometry.dispose(); floor.material.dispose();
});
