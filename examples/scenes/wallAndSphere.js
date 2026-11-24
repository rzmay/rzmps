import * as THREE from 'three';
import { createSceneParticleRoot, disposeSceneParticleRoot } from '../utils/particleRoot.js';

/** Three ordinary receivers, usable by any particle system and either collision backend. */
export default function wallAndSphere(scene) {
  const particleRoot = createSceneParticleRoot(scene, [0, 0, 0]);
  const root = new THREE.Group();
  root.name = 'Wall and Sphere';
  const previousBackground = scene.background, previousView = scene.userData.cameraView;
  const view = { position: [-6, 3.6, 8], target: [0, 1.5, 0] };
  const background = new THREE.Color('#20242a');
  scene.userData.cameraView = view;
  scene.background = background;

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(14, 12),
    new THREE.MeshStandardMaterial({ color: '#62676c', roughness: 0.9 }));
  floor.name = 'Receiver Floor';
  floor.rotation.x = -Math.PI / 2;
  floor.position.z = 2;
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(14, 7),
    new THREE.MeshStandardMaterial({ color: '#929392', roughness: 0.9 }));
  wall.name = 'Receiver Wall';
  wall.position.set(0, 3.5, -3);
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(1.6, 32, 20),
    new THREE.MeshStandardMaterial({ color: '#d7d5cd', roughness: 0.75 }));
  sphere.name = 'Receiver Sphere';
  sphere.position.set(0.8, 1.7, 0);
  const ambient = new THREE.HemisphereLight('#e4ebff', '#5b534b', 0.8);
  const key = new THREE.DirectionalLight('#fff1dd', 2.2);
  key.position.set(-3, 7, 5);
  root.add(floor, wall, sphere, ambient, key, key.target);
  scene.add(root);

  // A stable base position keeps manual edits independent of the optional motion offset.
  const position = sphere.position.clone();
  const controls = { automaticMotion: false, amplitude: 1.2, period: 8 };
  let elapsed = 0;
  const update = deltaTime => {
    elapsed += deltaTime;
    sphere.position.copy(position);
    if (controls.automaticMotion) {
      sphere.position.x += Math.sin(elapsed * Math.PI * 2 / controls.period) * controls.amplitude;
    }
    root.updateMatrixWorld(true);
  };
  update(0);
  const data = { root, receivers: [floor, wall, sphere], floor, wall, sphere };
  scene.userData.wallAndSphere = data;

  return {
    update,
    gui: folder => {
      const sphereFolder = folder.addFolder('Sphere');
      for (const axis of ['x', 'y', 'z']) {
        sphereFolder.add(position, axis, axis === 'y' ? 1.6 : -3, axis === 'y' ? 5 : 3, 0.05)
          .onChange(() => update(0));
      }
      sphereFolder.add(controls, 'automaticMotion').onChange(() => update(0));
      sphereFolder.add(controls, 'amplitude', 0, 3, 0.1);
      sphereFolder.add(controls, 'period', 2, 20, 0.5);
    },
    cleanup: () => {
      disposeSceneParticleRoot(scene, particleRoot);
      root.removeFromParent();
      for (const mesh of data.receivers) { mesh.geometry.dispose(); mesh.material.dispose(); }
      ambient.dispose(); key.dispose();
      if (scene.userData.cameraView === view) scene.userData.cameraView = previousView;
      if (scene.background === background) scene.background = previousBackground;
      if (scene.userData.wallAndSphere === data) delete scene.userData.wallAndSphere;
    },
  };
}

wallAndSphere.description = 'A floor, wall and movable sphere with optional automatic motion.';
wallAndSphere.metadata = { id: 'wallAndSphere', title: 'Wall and Sphere', author: 'rzmay' };
