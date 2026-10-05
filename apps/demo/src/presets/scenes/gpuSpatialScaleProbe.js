import * as THREE from 'three';
import { float } from 'three/tsl';
import {
  Module,
  SpatialEffect,
  SpatialEffectHelper,
} from '@rzmps/rzmps';
import {
  createSceneParticleRoot,
  disposeSceneParticleRoot,
} from './particleRoot';

const CONFIGURER_KEY = '__rzmps_configureParticleSystem';

function createScaleEffect({ name, color, position, geometry }) {
  const effect = new SpatialEffect((particle) => {
    particle.scale.multiplyScalar(3);
  }, {
    geometry,
    position,
    feather: 0.75,
    priority: Module.Priority.Transient,
    modifyGPU: (particle, _deltaTime, _context, strength) => {
      particle.scale.assign(
        particle.scale.mul(float(1).add(strength.mul(2))),
      );
    },
  });
  effect.name = name;

  const helper = new SpatialEffectHelper(effect, color);

  return { effect, helper };
}

export default function createGPUSpatialScaleProbe(scene) {
  const root = new THREE.Group();
  root.name = 'GPU Spatial Scale Probe Scene';
  const particleRoot = createSceneParticleRoot(scene, [0, 2, 0]);

  const sphere = createScaleEffect({
    name: 'GPU Sphere Scale Probe',
    color: 0xffd166,
    position: new THREE.Vector3(-3.5, 2.5, 0),
    geometry: new THREE.SphereGeometry(2, 32, 16),
  });

  const box = createScaleEffect({
    name: 'GPU Box Scale Probe',
    color: 0x70d6ff,
    position: new THREE.Vector3(3.5, 2.5, 0),
    geometry: new THREE.BoxGeometry(3.5, 3.5, 3.5),
  });
  box.effect.rotation.y = Math.PI * 0.18;

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 16),
    new THREE.MeshStandardMaterial({
      color: 0x20252a,
      roughness: 0.88,
      metalness: 0,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  ground.receiveShadow = true;

  const ambient = new THREE.AmbientLight(0xffffff, 0.55);
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(6, 10, 5);

  root.add(
    sphere.effect,
    sphere.helper,
    box.effect,
    box.helper,
    ground,
    ambient,
    light,
  );
  scene.add(root);

  const previousConfigurer = scene.userData[CONFIGURER_KEY];
  const configureSpatialEffects = (particleSystem) => {
    previousConfigurer?.(particleSystem);
    particleSystem.useSpatialEffects = true;
    particleSystem.gpuProcessing = true;
  };
  scene.userData[CONFIGURER_KEY] = configureSpatialEffects;

  return {
    gui: (folder) => {
      const sphereFolder = folder.addFolder('Sphere Scale Probe');
      sphereFolder.add(sphere.effect.position, 'x', -10, 10, 0.1).name('X');
      sphereFolder.add(sphere.effect.position, 'y', -2, 8, 0.1).name('Y');
      sphereFolder.add(sphere.effect.position, 'z', -10, 10, 0.1).name('Z');
      sphereFolder.add(sphere.effect, 'feather', 0, 3, 0.05).name('Feather').onChange(() => sphere.helper.update());
      sphereFolder.add(sphere.helper, 'visible').name('Show Helper');

      const boxFolder = folder.addFolder('Box Scale Probe');
      boxFolder.add(box.effect.position, 'x', -10, 10, 0.1).name('X');
      boxFolder.add(box.effect.position, 'y', -2, 8, 0.1).name('Y');
      boxFolder.add(box.effect.position, 'z', -10, 10, 0.1).name('Z');
      boxFolder.add(box.effect.rotation, 'y', -Math.PI, Math.PI, 0.01).name('Yaw');
      boxFolder.add(box.effect, 'feather', 0, 3, 0.05).name('Feather').onChange(() => box.helper.update());
      boxFolder.add(box.helper, 'visible').name('Show Helper');
    },

    cleanup: () => {
      disposeSceneParticleRoot(scene, particleRoot);
      scene.remove(root);

      if (scene.userData[CONFIGURER_KEY] === configureSpatialEffects) {
        if (previousConfigurer) scene.userData[CONFIGURER_KEY] = previousConfigurer;
        else delete scene.userData[CONFIGURER_KEY];
      }

      sphere.helper.dispose();
      box.helper.dispose();
      sphere.effect.geometry?.dispose();
      box.effect.geometry?.dispose();
      ground.geometry.dispose();
      ground.material.dispose();
    },
  };
}

createGPUSpatialScaleProbe.author = "rzmay";
createGPUSpatialScaleProbe.description = "GPU-capable spatial effects that only scale particles, useful for isolating spatial test versus transform bugs.";
