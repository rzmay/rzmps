import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  createSceneParticleRoot, disposeSceneParticleRoot, retainSceneParticleRoot,
} from '../../examples/utils/particleRoot.js';

test('scene replacement preserves system attachment while normal cleanup still releases the root', () => {
  const scene = new THREE.Scene(), root = createSceneParticleRoot(scene), system = new THREE.Group();
  root.add(system);
  let removed = 0;
  system.addEventListener('removed', () => { removed++; });
  const release = retainSceneParticleRoot(scene);
  disposeSceneParticleRoot(scene, root);
  const replacement = createSceneParticleRoot(scene, [0, 2, 0]);
  assert.equal(replacement, root);
  assert.equal(system.parent, root);
  assert.equal(root.parent, scene);
  assert.equal(removed, 0);
  assert.equal(root.position.y, 2);
  release();
  disposeSceneParticleRoot(scene, root);
  assert.equal(root.parent, null);
  assert.equal(scene.userData.__rzmps_particleRoot, undefined);
});

test('overlapping scene replacements retain the root until both scopes finish', () => {
  const scene = new THREE.Scene(), root = createSceneParticleRoot(scene);
  const first = retainSceneParticleRoot(scene), second = retainSceneParticleRoot(scene);
  first(); first();
  disposeSceneParticleRoot(scene, root);
  assert.equal(root.parent, scene);
  second();
  disposeSceneParticleRoot(scene, root);
  assert.equal(root.parent, null);
});
