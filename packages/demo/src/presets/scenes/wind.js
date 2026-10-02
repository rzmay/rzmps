import * as THREE from 'three';
import {
  ParticleForceField,
  ParticleForceFieldHelper,
} from '@rzmps/rzmps';
import {
  createSceneParticleRoot,
  disposeSceneParticleRoot,
} from './particleRoot';

export default function createWind(scene) {
  const root = new THREE.Group();
  root.name = 'Wind Scene';
  const particleRoot = createSceneParticleRoot(scene);

  /*
   * WIND TUNNEL
   *
   * A rectangular region applying a directional force.
   */
  const wind = ParticleForceField.Box(
    {
      direction: new THREE.Vector3(36, 12, 0),
      drag: 0.6,
    },
    4, 4, 6
  );

  wind.name = 'Wind';
  wind.position.set(4, 3, 0);

  const windHelper = new ParticleForceFieldHelper(
    wind,
    0x5edcff,
  );

  root.add(
    wind,
    windHelper,
  );

  /*
   * Ground plane to make particle movement easier to read.
   */
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 18),
    new THREE.MeshStandardMaterial({
      color: 0x25252c,
      roughness: 0.85,
      metalness: 0,
    }),
  );

  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -2;
  ground.receiveShadow = true;

  root.add(ground);

  const ambient = new THREE.AmbientLight(
    0xffffff,
    0.55,
  );

  root.add(ambient);

  const light = new THREE.DirectionalLight(
    0xffffff,
    3,
  );

  light.position.set(5, 10, 5);
  root.add(light);

  scene.add(root);

  return {
    gui: (folder) => {
      const direction = folder.addFolder('Wind Direction');
      direction.add(wind.direction, 'x', -120, 120, 0.1).name('X').onChange(() => windHelper.update());
      direction.add(wind.direction, 'y', -120, 120, 0.1).name('Y').onChange(() => windHelper.update());
      direction.add(wind.direction, 'z', -120, 120, 0.1).name('Z').onChange(() => windHelper.update());

      const position = folder.addFolder('Wind Position');
      position.add(wind.position, 'x', -10, 10, 0.1).name('X').onChange(() => windHelper.update());
      position.add(wind.position, 'y', -4, 10, 0.1).name('Y').onChange(() => windHelper.update());
      position.add(wind.position, 'z', -10, 10, 0.1).name('Z').onChange(() => windHelper.update());

      folder.add(wind, 'drag', 0, 12, 0.01).name('Drag').onChange(() => windHelper.update());
      folder.add(wind, 'inverted').name('Inverted').onChange(() => windHelper.update());
      folder.add(windHelper, 'visible').name('Show Helper');
    },

    cleanup: () => {
      disposeSceneParticleRoot(scene, particleRoot);
      scene.remove(root);

      windHelper.dispose();

      ground.geometry.dispose();
      ground.material.dispose();
    },
  };
}

createWind.author = "rzmay";
