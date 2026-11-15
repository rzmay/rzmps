import * as THREE from 'three';

export const SCENE_PARTICLE_ROOT_KEY = '__rzmps_particleRoot';
const retainedRoots = new WeakMap();

export function createSceneParticleRoot(scene, position = [0, 1, 0]) {
  const existing = scene.userData[SCENE_PARTICLE_ROOT_KEY];
  if (existing && retainedRoots.has(existing)) {
    existing.position.set(...position);
    return existing;
  }

  const root = new THREE.Group();
  root.name = 'RZMPS Particle Root';
  root.position.set(...position);
  scene.add(root);
  scene.userData[SCENE_PARTICLE_ROOT_KEY] = root;
  return root;
}

export function getSceneParticleRoot(scene) {
  return scene?.userData?.[SCENE_PARTICLE_ROOT_KEY] ?? scene;
}

export function disposeSceneParticleRoot(scene, root) {
  if (retainedRoots.has(root)) return;
  root.removeFromParent();

  if (scene.userData[SCENE_PARTICLE_ROOT_KEY] === root) {
    delete scene.userData[SCENE_PARTICLE_ROOT_KEY];
  }
}

/** Keep live systems attached while replacing scene-owned geometry, lights and collision objects. */
export function retainSceneParticleRoot(scene) {
  const root = scene.userData[SCENE_PARTICLE_ROOT_KEY];
  if (!root) return () => {};
  retainedRoots.set(root, (retainedRoots.get(root) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = retainedRoots.get(root) - 1;
    if (remaining > 0) retainedRoots.set(root, remaining);
    else retainedRoots.delete(root);
  };
}
