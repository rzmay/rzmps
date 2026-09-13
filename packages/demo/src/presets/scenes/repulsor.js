import * as THREE from 'three';
import {
  ExternalForces,
  ParticleForceField,
  ParticleForceFieldHelper,
  ParticleSystem,
} from 'rzmps';

export default function createRepulsorAttractor(scene) {
  const root = new THREE.Group();
  root.name = 'Repulsor and Attractor Scene';

  /*
   * REPULSOR
   *
   * Negative gravity pushes particles away from the field center.
   */
  const repulsor = ParticleForceField.Sphere({
    gravity: -0.1,
  }, 4);

  repulsor.name = 'Repulsor';
  repulsor.position.set(0, 3, -4);

  const repulsorHelper = new ParticleForceFieldHelper(
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
  const attractor = ParticleForceField.Sphere({
    gravity: 0.1,
  }, 4);

  attractor.name = 'Attractor';
  attractor.position.set(0, 3, 4);

  const attractorHelper = new ParticleForceFieldHelper(
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

    repulsorHelper.dispose();
    attractorHelper.dispose();

    ground.geometry.dispose();
    ground.material.dispose();
  };
}
