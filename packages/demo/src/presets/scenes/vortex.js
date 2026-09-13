import * as THREE from 'three';
import {
  ExternalForces,
  ParticleForceField,
  ParticleForceFieldHelper,
  ParticleSystem,
} from '@rzmps/rzmps';

export default function createVortex(scene) {
  const root = new THREE.Group();
  root.name = 'Vortex Scene';

  /*
   * VORTEX
   *
   * Pulls particles toward its center while accelerating them
   * tangentially around the Y axis.
   */
  const vortex = ParticleForceField.Sphere({
    rotationSpeed: 1,
    rotationAttraction: 1,
    drag: 0.3,
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
    0.4,
  );

  root.add(ambient);

  const light = new THREE.DirectionalLight(
    0xffffff,
    2,
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
  let frameId;
  let removeExternalForcesModule = () => {};
  const refreshExternalForcesModule = () => {
    let particleSystem;
    scene.traverse((obj) => {
      if (obj instanceof ParticleSystem) particleSystem = obj;
    });

    if (!particleSystem.modules.some((module) => module instanceof ExternalForces)) {
      const externalForces = new ExternalForces({});

      particleSystem.addModule(externalForces);

      removeExternalForcesModule = () => particleSystem.removeModule(externalForces);
    }

    frameId = requestAnimationFrame(refreshExternalForcesModule);
  }

  refreshExternalForcesModule()

  return () => {
    cancelAnimationFrame(frameId);
    removeExternalForcesModule();

    scene.remove(root);

    vortexHelper.dispose();

    ground.geometry.dispose();
    ground.material.dispose();
  };
}
