import * as THREE from 'three';

export const SCENE_PARTICLE_ROOT_KEY = '__rzmps_particleRoot';

export function createSceneParticleRoot(scene, position = [0, 1, 0]) {
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
  root.removeFromParent();

  if (scene.userData[SCENE_PARTICLE_ROOT_KEY] === root) {
    delete scene.userData[SCENE_PARTICLE_ROOT_KEY];
  }
}
