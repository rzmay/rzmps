import * as THREE from 'three';
import {
  KillZone,
  SpatialEffect,
  SpatialEffectHelper,
} from '@rzmps/rzmps';
import {
  createSceneParticleRoot,
  disposeSceneParticleRoot,
} from './particleRoot';

const CONFIGURER_KEY = '__rzmps_configureParticleSystem';

function createZoneMesh(spatialEffect, color, opacity = 0.18) {
  const mesh = new THREE.Mesh(
    spatialEffect.geometry ?? new THREE.SphereGeometry(1, 16, 8),
    new THREE.MeshStandardMaterial({
      color,
      emissive: new THREE.Color(color).multiplyScalar(0.25),
      transparent: true,
      opacity,
      roughness: 0.58,
      metalness: 0,
      depthWrite: false,
    }),
  );

  mesh.position.copy(spatialEffect.position);
  mesh.rotation.copy(spatialEffect.rotation);
  mesh.scale.copy(spatialEffect.scale);
  mesh.renderOrder = 2;

  return mesh;
}

export default function createKillZoneScene(scene) {
  const root = new THREE.Group();
  root.name = 'Kill Zones Scene';
  const particleRoot = createSceneParticleRoot(scene, [0, 3, 0]);

  const sphereKillZone = KillZone.Sphere(
    null,
    {
      position: new THREE.Vector3(-3.5, 3, 0),
    },
    2.1,
    32,
    16,
  );
  sphereKillZone.name = 'Sphere KillZone';

  const planePosition = new THREE.Vector3(0, 0.7, 0);
  const planeKillZone = new KillZone({
    test: SpatialEffect.Plane({
      position: planePosition,
      normal: new THREE.Vector3(0, -1, 0),
    }),
  });
  planeKillZone.name = 'Plane KillZone';

  const planeMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(18, 12),
    new THREE.MeshStandardMaterial({
      color: 0xff4c5f,
      emissive: new THREE.Color('#601018'),
      emissiveIntensity: 0.35,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  planeMesh.rotation.x = -Math.PI / 2;
  planeMesh.position.y = 0.7;
  planeMesh.renderOrder = 1;

  const sphereMesh = createZoneMesh(sphereKillZone, '#ff6b6b', 0.2);
  const sphereHelper = new SpatialEffectHelper(sphereKillZone, 0xff6b6b);

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
    sphereKillZone,
    planeKillZone,
    sphereMesh,
    sphereHelper,
    planeMesh,
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

  const syncSphereMesh = () => {
    sphereMesh.position.copy(sphereKillZone.position);
  };

  return {
    gui: (folder) => {
      const sphereFolder = folder.addFolder('Sphere KillZone');
      sphereFolder.add(sphereKillZone.position, 'x', -12, 12, 0.1).name('X').onChange(syncSphereMesh);
      sphereFolder.add(sphereKillZone.position, 'y', -2, 10, 0.1).name('Y').onChange(syncSphereMesh);
      sphereFolder.add(sphereKillZone.position, 'z', -12, 12, 0.1).name('Z').onChange(syncSphereMesh);
      sphereFolder.add(sphereMesh, 'visible').name('Show Mesh');
      sphereFolder.add(sphereHelper, 'visible').name('Show Helper');

      const planeFolder = folder.addFolder('Plane KillZone');
      planeFolder.add(planeMesh.position, 'y', -2, 6, 0.1).name('Y').onChange((value) => {
        planePosition.y = value;
      });
      planeFolder.add(planeMesh, 'visible').name('Show Plane');
    },

    cleanup: () => {
      disposeSceneParticleRoot(scene, particleRoot);
      scene.remove(root);

      if (scene.userData[CONFIGURER_KEY] === configureSpatialEffects) {
        if (previousConfigurer) scene.userData[CONFIGURER_KEY] = previousConfigurer;
        else delete scene.userData[CONFIGURER_KEY];
      }

      sphereHelper.dispose();
      sphereMesh.material.dispose();
      planeMesh.geometry.dispose();
      planeMesh.material.dispose();
      ground.geometry.dispose();
      ground.material.dispose();
    },
  };
}

createKillZoneScene.author = "rzmay";
createKillZoneScene.description = "Scene-level KillZone spatial effects using geometry and an infinite plane test.";
