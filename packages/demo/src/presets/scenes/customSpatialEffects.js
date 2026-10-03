import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import {
  Module,
  SpatialEffect,
  SpatialEffectHelper,
} from '@rzmps/rzmps';
import suzanneModel from '../../assets/models/suzanne.glb?url';
import {
  createSceneParticleRoot,
  disposeSceneParticleRoot,
} from './particleRoot';

const CONFIGURER_KEY = '__rzmps_configureParticleSystem';

async function loadSuzanneGeometry() {
  const gltf = await new GLTFLoader().loadAsync(suzanneModel);
  let geometry = null;

  gltf.scene.traverse((child) => {
    if (!geometry && child.isMesh) {
      geometry = child.geometry.clone();
      geometry.rotateX(-Math.PI / 2);
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
    }
  });

  if (!geometry) {
    throw new Error('suzanne.glb does not contain a mesh');
  }

  return geometry;
}

export default async function createCustomSpatialEffects(scene) {
  const root = new THREE.Group();
  root.name = 'Custom Spatial Effects Scene';
  const particleRoot = createSceneParticleRoot(scene, [0, 2, 0]);
  const suzanneGeometry = await loadSuzanneGeometry();

  const warmColor = new THREE.Color('#ffd166');
  const warmScale = new THREE.Vector3(1.15, 1.15, 1.15);
  const warmSettings = {
    speedMultiplier: 1.65,
  };
  const warmRegion = SpatialEffect.Sphere((particle) => {
    particle.color.copy(warmColor);
    particle.scale.copy(warmScale);
    particle.speed *= warmSettings.speedMultiplier;
    particle.velocity.multiplyScalar(warmSettings.speedMultiplier);
  }, {
    position: new THREE.Vector3(-5, 2.4, 0),
    feather: 1.35,
    priority: Module.Priority.PreMovementTransient,
  }, 2.7, 32, 16);
  warmRegion.name = 'Warm Glow Size Region';

  const coolColor = new THREE.Color('#70d6ff');
  const coolScale = new THREE.Vector3(0.55, 0.55, 0.55);
  const coolSettings = {
    speedMultiplier: 0.92,
  };
  const coolRegion = SpatialEffect.Box((particle) => {
    particle.color.lerp(coolColor, 0.08);
    particle.scale.lerp(coolScale, 0.08);
    particle.speed *= coolSettings.speedMultiplier;
    particle.velocity.multiplyScalar(coolSettings.speedMultiplier);
  }, {
    position: new THREE.Vector3(5, 2.4, 0),
    priority: Module.Priority.Permanent,
  }, 4, 4, 4);
  coolRegion.name = 'Cool Shrink Region';
  coolRegion.rotation.y = Math.PI * 0.18;

  const suzanneColor = new THREE.Color('#f78cff');
  const suzanneScale = new THREE.Vector3(0.9, 0.9, 0.9);
  const suzanneSettings = {
    speedMultiplier: 1.25,
  };
  const suzanneRegion = new SpatialEffect((particle) => {
    particle.color.copy(suzanneColor);
    particle.scale.copy(suzanneScale);
    particle.speed *= suzanneSettings.speedMultiplier;
    particle.velocity.multiplyScalar(suzanneSettings.speedMultiplier);
  }, {
    geometry: suzanneGeometry,
    position: new THREE.Vector3(0, 2.7, -5),
    scale: new THREE.Vector3(1.45, 1.45, 1.45),
    feather: 0.85,
    priority: Module.Priority.PreMovementTransient,
  });
  suzanneRegion.name = 'Suzanne Feather Region';
  suzanneRegion.rotation.y = -Math.PI * 0.2;

  const warmHelper = new SpatialEffectHelper(warmRegion, 0xffd166);
  const coolHelper = new SpatialEffectHelper(coolRegion, 0x70d6ff);
  const suzanneHelper = new SpatialEffectHelper(suzanneRegion, 0xf78cff);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 18),
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
    warmRegion,
    coolRegion,
    suzanneRegion,
    warmHelper,
    coolHelper,
    suzanneHelper,
    ground,
    ambient,
    light,
  );
  scene.add(root);

  const previousConfigurer = scene.userData[CONFIGURER_KEY];
  const configureSpatialEffects = (particleSystem) => {
    previousConfigurer?.(particleSystem);
    particleSystem.useSpatialEffects = true;
  };
  scene.userData[CONFIGURER_KEY] = configureSpatialEffects;

  return {
    gui: (folder) => {
      const warmFolder = folder.addFolder('Warm Region');
      warmFolder.add(warmRegion.position, 'x', -12, 12, 0.1).name('X');
      warmFolder.add(warmRegion.position, 'y', -2, 10, 0.1).name('Y');
      warmFolder.add(warmRegion.position, 'z', -12, 12, 0.1).name('Z');
      warmFolder.add(warmSettings, 'speedMultiplier', 0.1, 3, 0.01).name('Speed');
      warmFolder.add(warmRegion, 'feather', 0, 4, 0.05).name('Feather').onChange(() => warmHelper.update());
      warmFolder.add(warmHelper, 'visible').name('Show Helper');

      const coolFolder = folder.addFolder('Cool Region');
      coolFolder.add(coolRegion.position, 'x', -12, 12, 0.1).name('X');
      coolFolder.add(coolRegion.position, 'y', -2, 10, 0.1).name('Y');
      coolFolder.add(coolRegion.position, 'z', -12, 12, 0.1).name('Z');
      coolFolder.add(coolRegion.rotation, 'y', -Math.PI, Math.PI, 0.01).name('Yaw');
      coolFolder.add(coolSettings, 'speedMultiplier', 0.1, 3, 0.01).name('Speed');
      coolFolder.add(coolHelper, 'visible').name('Show Helper');

      const suzanneFolder = folder.addFolder('Suzanne Region');
      suzanneFolder.add(suzanneRegion.position, 'x', -12, 12, 0.1).name('X');
      suzanneFolder.add(suzanneRegion.position, 'y', -2, 10, 0.1).name('Y');
      suzanneFolder.add(suzanneRegion.position, 'z', -12, 12, 0.1).name('Z');
      suzanneFolder.add(suzanneRegion.rotation, 'y', -Math.PI, Math.PI, 0.01).name('Yaw');
      suzanneFolder.add(suzanneRegion.scale, 'x', 0.25, 4, 0.01).name('Scale').onChange((value) => {
        suzanneRegion.scale.setScalar(value);
      });
      suzanneFolder.add(suzanneSettings, 'speedMultiplier', 0.1, 3, 0.01).name('Speed');
      suzanneFolder.add(suzanneRegion, 'feather', 0, 3, 0.05).name('Feather').onChange(() => suzanneHelper.update());
      suzanneFolder.add(suzanneHelper, 'visible').name('Show Helper');
    },

    cleanup: () => {
      disposeSceneParticleRoot(scene, particleRoot);
      scene.remove(root);

      if (scene.userData[CONFIGURER_KEY] === configureSpatialEffects) {
        if (previousConfigurer) scene.userData[CONFIGURER_KEY] = previousConfigurer;
        else delete scene.userData[CONFIGURER_KEY];
      }

      warmHelper.dispose();
      coolHelper.dispose();
      suzanneHelper.dispose();
      suzanneGeometry.dispose();
      ground.geometry.dispose();
      ground.material.dispose();
    },
  };
}

createCustomSpatialEffects.author = "rzmay";
createCustomSpatialEffects.description = "Plain SpatialEffect regions that tint, resize, speed, and slow particles, including a feathered Suzanne mesh.";
