import * as THREE from 'three';
import debugUrl from '../../assets/images/uv_debug.jpg?url';
import { createSceneParticleRoot, disposeSceneParticleRoot } from './particleRoot';

/** A separate environment so any particle preset can exercise the same UV charts. */
export default async function createUVDebugScene(scene) {
  const root = createSceneParticleRoot(scene);
  const map = await new THREE.TextureLoader().loadAsync(debugUrl);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(2, 2);

  const material = new THREE.MeshStandardMaterial({ map, roughness: 0.75, metalness: 0 });
  const group = new THREE.Group();
  group.name = 'UV debug';

  const light = new THREE.DirectionalLight(0xffffff, 2);
  light.position.set(5, 10, 5);
  group.add(new THREE.AmbientLight(0xffffff, 0.65), light);

  const floor = new THREE.Mesh(new THREE.BoxGeometry(12, 0.2, 10), material);
  floor.position.y = -0.1;
  group.add(floor);

  const wall = new THREE.Mesh(new THREE.BoxGeometry(12, 5, 0.2), material);
  wall.position.set(0, 2.5, -5);
  group.add(wall);

  // A tilted chart exercises non-horizontal contacts and world-space texture density.
  const ramp = new THREE.Mesh(new THREE.BoxGeometry(3, 0.2, 4), material);
  ramp.position.set(0, 0.8, 0);
  ramp.rotation.z = 0.25;
  group.add(ramp);
  scene.add(group);

  return {
    cleanup: () => {
      disposeSceneParticleRoot(scene, root);
      group.removeFromParent();
      group.children.forEach(object => {
        if (object instanceof THREE.Mesh) object.geometry.dispose();
      });
      material.dispose();
      map.dispose();
    },
  };
}

createUVDebugScene.author = 'rzmay';
