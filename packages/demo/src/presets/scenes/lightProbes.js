import * as THREE from 'three';
import { LightProbeGrid } from 'three/examples/jsm/lighting/LightProbeGrid.js';
import { LightProbeGridHelper } from 'three/examples/jsm/helpers/LightProbeGridHelper.js';
import {
  createSceneParticleRoot,
  disposeSceneParticleRoot,
} from './particleRoot';

function disposeMaterial(material) {
  if (Array.isArray(material)) {
    material.forEach(disposeMaterial);
    return;
  }

  material.dispose();
}

function addMesh(root, mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  root.add(mesh);
  return mesh;
}

export default async function createLightProbeScene(scene, renderer) {
  const root = new THREE.Group();
  root.name = 'Light Probe Volume Scene';
  const particleRoot = createSceneParticleRoot(scene);

  scene.background = new THREE.Color(0x111111);

  const wallMaterial = new THREE.MeshStandardMaterial({
    color: 0xcccccc,
    side: THREE.BackSide,
  });
  const whiteMaterial = new THREE.MeshStandardMaterial({ color: 0xeeeeee });
  const dividerMaterial = new THREE.MeshStandardMaterial({ color: 0xcccccc });
  const redMaterial = new THREE.MeshStandardMaterial({ color: 0xdd2200 });
  const blueMaterial = new THREE.MeshStandardMaterial({ color: 0x0044ff });
  const tableMaterial = new THREE.MeshStandardMaterial({ color: 0x886644 });
  const sphereMaterial = new THREE.MeshStandardMaterial({
    color: 0xffd700,
    metalness: 0.3,
    roughness: 0.4,
  });
  const torusMaterial = new THREE.MeshStandardMaterial({
    color: 0xff44aa,
    metalness: 0.2,
    roughness: 0.5,
  });

  const room = addMesh(root, new THREE.Mesh(
    new THREE.BoxGeometry(16, 5, 8),
    wallMaterial,
  ));
  room.position.set(0, 2.5, 0);

  const redWall = addMesh(root, new THREE.Mesh(
    new THREE.PlaneGeometry(8, 5),
    redMaterial,
  ));
  redWall.rotation.y = Math.PI / 2;
  redWall.position.set(-7.99, 2.5, 0);

  const blueWall = addMesh(root, new THREE.Mesh(
    new THREE.PlaneGeometry(8, 5),
    blueMaterial,
  ));
  blueWall.rotation.y = -Math.PI / 2;
  blueWall.position.set(7.99, 2.5, 0);

  const doorwayHalfGap = 1.25;
  const dividerDepth = 4 - doorwayHalfGap;

  const dividerLeft = addMesh(root, new THREE.Mesh(
    new THREE.BoxGeometry(0.3, 5, dividerDepth),
    dividerMaterial,
  ));
  dividerLeft.position.set(0, 2.5, -(doorwayHalfGap + dividerDepth / 2));

  const dividerRight = addMesh(root, new THREE.Mesh(
    new THREE.BoxGeometry(0.3, 5, dividerDepth),
    dividerMaterial,
  ));
  dividerRight.position.set(0, 2.5, doorwayHalfGap + dividerDepth / 2);

  const lintel = addMesh(root, new THREE.Mesh(
    new THREE.BoxGeometry(0.3, 1.2, doorwayHalfGap * 2),
    dividerMaterial,
  ));
  lintel.position.set(0, 4.4, 0);

  const columnGeometry = new THREE.CylinderGeometry(0.3, 0.3, 4, 16);
  const tableLegGeometry = new THREE.BoxGeometry(0.1, 1, 0.1);

  for (const x of [-6, -2, 2, 6]) {
    for (const z of [-2.5, 2.5]) {
      const column = addMesh(root, new THREE.Mesh(columnGeometry, whiteMaterial));
      column.position.set(x, 2, z);
    }
  }

  const tableTop = addMesh(root, new THREE.Mesh(
    new THREE.BoxGeometry(2.4, 0.12, 1.4),
    tableMaterial,
  ));
  tableTop.position.set(-4, 1, 0);

  for (const x of [-5.05, -2.95]) {
    for (const z of [-0.55, 0.55]) {
      const leg = addMesh(root, new THREE.Mesh(tableLegGeometry, tableMaterial));
      leg.position.set(x, 0.5, z);
    }
  }

  const sphere = addMesh(root, new THREE.Mesh(
    new THREE.SphereGeometry(0.35, 32, 32),
    sphereMaterial,
  ));
  sphere.position.set(-4, 1.41, 0);

  const step1 = addMesh(root, new THREE.Mesh(
    new THREE.BoxGeometry(1.5, 0.5, 1),
    whiteMaterial,
  ));
  step1.position.set(-7, 0.25, 0);

  const step2 = addMesh(root, new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    whiteMaterial,
  ));
  step2.position.set(-7, 0.5, 0);

  const step3 = addMesh(root, new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 1.5, 1),
    whiteMaterial,
  ));
  step3.position.set(-7, 0.75, 0);

  const pedestal = addMesh(root, new THREE.Mesh(
    new THREE.BoxGeometry(0.8, 1.2, 0.8),
    whiteMaterial,
  ));
  pedestal.position.set(4, 0.6, 0);

  const torusKnot = addMesh(root, new THREE.Mesh(
    new THREE.TorusKnotGeometry(0.3, 0.1, 64, 16),
    torusMaterial,
  ));
  torusKnot.position.set(4, 1.65, 0);

  const sculpture = addMesh(root, new THREE.Mesh(
    new THREE.ConeGeometry(0.4, 2.5, 5),
    whiteMaterial,
  ));
  sculpture.position.set(6.5, 1.25, -1.5);

  const warmLight = new THREE.PointLight(0xffaa44, 30);
  warmLight.position.set(-4, 4.5, 0);
  warmLight.castShadow = true;
  warmLight.shadow.mapSize.setScalar(256);
  warmLight.shadow.radius = 12;
  warmLight.shadow.bias = -0.002;

  const coolLight = new THREE.PointLight(0x88bbff, 30);
  coolLight.position.set(4, 4.5, 0);
  coolLight.castShadow = true;
  coolLight.shadow.mapSize.setScalar(256);
  coolLight.shadow.radius = 12;
  coolLight.shadow.bias = -0.002;

  root.add(warmLight, coolLight);
  scene.add(root);

  const bakeOptions = {
    cubemapSize: 32,
    near: 0.05,
    far: 20,
  };
  const controls = {
    lightProbes: true,
    showHelpers: false,
    animateSculpture: true,
    cubemapSize: bakeOptions.cubemapSize,
    rebake: () => {
      bakeOptions.cubemapSize = Number(controls.cubemapSize);
      probesLeft.bake(renderer, scene, bakeOptions);
      probesRight.bake(renderer, scene, bakeOptions);
    },
  };
  const resolution = 6;

  const probesLeft = new LightProbeGrid(7.8, 4.7, 7.6, resolution, resolution, resolution);
  probesLeft.position.set(-3.9, 2.45, 0);
  probesLeft.bake(renderer, scene, bakeOptions);
  probesLeft.visible = true;

  const probesRight = new LightProbeGrid(7.8, 4.7, 7.6, resolution, resolution, resolution);
  probesRight.position.set(3.9, 2.45, 0);
  probesRight.bake(renderer, scene, bakeOptions);
  probesRight.visible = true;

  const probesHelperLeft = new LightProbeGridHelper(probesLeft);
  probesHelperLeft.visible = controls.showHelpers;

  const probesHelperRight = new LightProbeGridHelper(probesRight);
  probesHelperRight.visible = controls.showHelpers;

  root.add(
    probesLeft,
    probesRight,
    probesHelperLeft,
    probesHelperRight,
  );

  let elapsed = 0;

  return {
    update: (deltaTime) => {
      elapsed += deltaTime;
      if (controls.animateSculpture) {
        torusKnot.rotation.x = elapsed * 0.4;
        torusKnot.rotation.y = elapsed * 0.65;
      }
    },

    gui: (folder) => {
      folder.add(controls, 'lightProbes').name('Light Probes').onChange((value) => {
        probesLeft.visible = value;
        probesRight.visible = value;
      });
      folder.add(controls, 'showHelpers').name('Show Probe Helpers').onChange((value) => {
        probesHelperLeft.visible = value;
        probesHelperRight.visible = value;
      });
      folder.add(controls, 'animateSculpture').name('Animate Sculpture');
      folder.add(controls, 'cubemapSize', [16, 32, 64, 128]).name('Probe Cubemap Size');
      folder.add(controls, 'rebake').name('Rebake Probes');
      folder.add(warmLight, 'intensity', 0, 80, 0.1).name('Warm Light');
      folder.add(coolLight, 'intensity', 0, 80, 0.1).name('Cool Light');
    },

    cleanup: () => {
      disposeSceneParticleRoot(scene, particleRoot);
      scene.remove(root);

      probesLeft.dispose();
      probesRight.dispose();
      probesHelperLeft.dispose();
      probesHelperRight.dispose();

      const geometries = new Set();
      const materials = new Set();

      root.traverse((object) => {
        if (object === probesHelperLeft || object === probesHelperRight) return;
        if (!(object instanceof THREE.Mesh)) return;

        geometries.add(object.geometry);
        if (Array.isArray(object.material)) {
          object.material.forEach((material) => materials.add(material));
        } else {
          materials.add(object.material);
        }
      });

      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach(disposeMaterial);
    },
  };
}

createLightProbeScene.author = "mrdoob";
