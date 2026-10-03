import * as THREE from 'three';
import {
  ParticleForceField,
  ParticleForceFieldHelper,
} from '@rzmps/rzmps';
import {
  createSceneParticleRoot,
  disposeSceneParticleRoot,
} from './particleRoot';

export default function createVortex(scene) {
  const root = new THREE.Group();
  root.name = 'Vortex Scene';
  const particleRoot = createSceneParticleRoot(scene);

  /*
   * VORTEX
   *
   * Pulls particles toward its center while accelerating them
   * tangentially around the Y axis.
   */
  const vortex = ParticleForceField.Sphere({
    rotationSpeed: 18,
    rotationAttraction: 10,
    drag: 1.2,
  }, 4);

  vortex.name = 'Vortex';
  vortex.position.set(0, 0, 0);

  const vortexHelper = new ParticleForceFieldHelper(
    vortex,
    0xa66cff,
  );


  root.add(
    vortex,
    vortexHelper,
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
      const position = folder.addFolder('Vortex Position');
      position.add(vortex.position, 'x', -10, 10, 0.1).name('X').onChange(() => vortexHelper.update());
      position.add(vortex.position, 'y', -4, 10, 0.1).name('Y').onChange(() => vortexHelper.update());
      position.add(vortex.position, 'z', -10, 10, 0.1).name('Z').onChange(() => vortexHelper.update());

      folder.add(vortex, 'rotationSpeed', -80, 80, 0.01).name('Rotation Speed').onChange(() => vortexHelper.update());
      folder.add(vortex, 'rotationAttraction', -80, 80, 0.01).name('Center Pull').onChange(() => vortexHelper.update());
      folder.add(vortex, 'drag', 0, 12, 0.01).name('Drag').onChange(() => vortexHelper.update());
      folder.add(vortex, 'inverted').name('Inverted').onChange(() => vortexHelper.update());
      folder.add(vortexHelper, 'visible').name('Show Helper');
    },

    cleanup: () => {
      disposeSceneParticleRoot(scene, particleRoot);
      scene.remove(root);

      vortexHelper.dispose();

      ground.geometry.dispose();
      ground.material.dispose();
    },
  };
}

createVortex.author = "rzmay";
