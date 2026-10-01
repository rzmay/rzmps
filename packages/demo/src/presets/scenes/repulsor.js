import * as THREE from 'three';
import {
  ExternalForces,
  ParticleSystem,
} from '@rzmps/rzmps';
import {
  createSceneParticleRoot,
  disposeSceneParticleRoot,
} from './particleRoot';

export default function createRepulsorAttractor(scene) {
  const root = new THREE.Group();
  root.name = 'Repulsor and Attractor Scene';
  const particleRoot = createSceneParticleRoot(scene);

  /*
   * REPULSOR
   *
   * Negative gravity pushes particles away from the field center.
   */
  const repulsor = ExternalForces.ParticleForceField.Sphere({
    gravity: -8,
  }, 4);

  repulsor.name = 'Repulsor';
  repulsor.position.set(0, 3, -4);

  const repulsorHelper = new ExternalForces.ParticleForceFieldHelper(
    repulsor,
    0xff655e,
  );

  root.add(
    repulsor,
    repulsorHelper,
  );

  /*
   * ATTRACTOR
   *
   * Positive gravity pulls particles into the field center.
   */
  const attractor = ExternalForces.ParticleForceField.Sphere({
    gravity: 8,
  }, 4);

  attractor.name = 'Attractor';
  attractor.position.set(0, 3, 4);

  const attractorHelper = new ExternalForces.ParticleForceFieldHelper(
    attractor,
    0x65ff5e,
  );

  root.add(
    attractor,
    attractorHelper,
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

  /*
   * Add ExternalForces specifically for this scene.
   *
   * The module doesn't explicitly reference any of the fields below;
   * it discovers ParticleForceFields from the scene automatically.
   */
  const configureParticleSystemKey = '__rzmps_configureParticleSystem';
  const sceneExternalForces = new Map();

  scene.userData[configureParticleSystemKey] = (particleSystem) => {
    if (
      !(particleSystem instanceof ParticleSystem)
      || particleSystem.isSubSystem
      || sceneExternalForces.has(particleSystem)
      || particleSystem.modules.some((module) => module instanceof ExternalForces)
    ) {
      return;
    }

    const externalForces = new ExternalForces();
    particleSystem.addModule(externalForces);
    sceneExternalForces.set(particleSystem, externalForces);
  };

  return {
    gui: (folder) => {
      const repulsorFolder = folder.addFolder('Repulsor');
      repulsorFolder.add(repulsor, 'gravity', -50, 50, 0.01).name('Gravity').onChange(() => repulsorHelper.update());
      repulsorFolder.add(repulsor, 'inverted').name('Inverted').onChange(() => repulsorHelper.update());
      repulsorFolder.add(repulsor.position, 'x', -10, 10, 0.1).name('X').onChange(() => repulsorHelper.update());
      repulsorFolder.add(repulsor.position, 'y', -4, 10, 0.1).name('Y').onChange(() => repulsorHelper.update());
      repulsorFolder.add(repulsor.position, 'z', -10, 10, 0.1).name('Z').onChange(() => repulsorHelper.update());
      repulsorFolder.add(repulsorHelper, 'visible').name('Show Helper');

      const attractorFolder = folder.addFolder('Attractor');
      attractorFolder.add(attractor, 'gravity', -50, 50, 0.01).name('Gravity').onChange(() => attractorHelper.update());
      attractorFolder.add(attractor, 'inverted').name('Inverted').onChange(() => attractorHelper.update());
      attractorFolder.add(attractor.position, 'x', -10, 10, 0.1).name('X').onChange(() => attractorHelper.update());
      attractorFolder.add(attractor.position, 'y', -4, 10, 0.1).name('Y').onChange(() => attractorHelper.update());
      attractorFolder.add(attractor.position, 'z', -10, 10, 0.1).name('Z').onChange(() => attractorHelper.update());
      attractorFolder.add(attractorHelper, 'visible').name('Show Helper');
    },

    cleanup: () => {
      disposeSceneParticleRoot(scene, particleRoot);
      sceneExternalForces.forEach((externalForces, particleSystem) => {
        particleSystem.removeModule(externalForces);
      });
      sceneExternalForces.clear();
      delete scene.userData[configureParticleSystemKey];

      scene.remove(root);

      repulsorHelper.dispose();
      attractorHelper.dispose();

      ground.geometry.dispose();
      ground.material.dispose();
    },
  };
}

createRepulsorAttractor.author = "rzmay";
g
