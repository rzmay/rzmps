import * as THREE from 'three';

export const DEFAULT_SCENE_BACKGROUND = '#17191c';

export function createDefaultSceneBackground() {
  return new THREE.Color(DEFAULT_SCENE_BACKGROUND);
}
