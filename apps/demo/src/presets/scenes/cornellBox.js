import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { LightProbeGrid } from 'three/addons/lighting/LightProbeGrid.js';
import { LightProbeGridWebGL } from 'three/addons/lighting/LightProbeGridWebGL.js';
import { LightProbeGridHelper } from 'three/addons/helpers/LightProbeGridHelper.js';
import { LightProbeGridHelperWebGL } from 'three/addons/helpers/LightProbeGridHelperWebGL.js';
import { LiveCubemap } from '@rzmps/rzmps';
import {
  createSceneParticleRoot,
  disposeSceneParticleRoot,
} from './particleRoot';

let rectAreaLightsInitialized = false;

function initializeRectAreaLights() {
  if (rectAreaLightsInitialized) return;
  RectAreaLightUniformsLib.init();
  rectAreaLightsInitialized = true;
}

function createProbeGrid(renderer, ...args) {
  if (renderer.isWebGPURenderer) {
    return {
      probes: new LightProbeGrid(...args),
      createHelper: (probes) => new LightProbeGridHelper(probes),
    };
  }

  return {
    probes: new LightProbeGridWebGL(...args),
    createHelper: (probes) => new LightProbeGridHelperWebGL(probes),
  };
}

function bakeProbeGrid(probes, renderer, scene, options) {
  probes.bake(renderer, scene, options);
}

export default async function loadCornellBox(scene, renderer) {
  initializeRectAreaLights();

  const root = new THREE.Group();
  root.name = 'Cornell Box Scene';
  const particleRoot = createSceneParticleRoot(scene);

  const roomSize = 10;
  const half = roomSize / 2;

  const white = new THREE.MeshStandardMaterial({
    color: '#d8d4c8',
    roughness: 0.78,
  });

  const red = new THREE.MeshStandardMaterial({
    color: '#b64a42',
    roughness: 0.82,
  });

  const green = new THREE.MeshStandardMaterial({
    color: '#4f8b58',
    roughness: 0.82,
  });

  const metal = new THREE.MeshStandardMaterial({
    color: '#d7d9dc',
    metalness: 1,
    roughness: 0.18,
    envMapIntensity: 1.4,
  });

  const matte = new THREE.MeshStandardMaterial({
    color: '#cfc8b8',
    metalness: 0,
    roughness: 0.55,
  });

  const lightPanelMaterial = new THREE.MeshBasicMaterial({
    color: '#fff7e8',
  });

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(roomSize, roomSize),
    white,
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0;

  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(roomSize, roomSize),
    white,
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = roomSize;

  const back = new THREE.Mesh(
    new THREE.PlaneGeometry(roomSize, roomSize),
    white,
  );
  back.position.z = -half;
  back.position.y = half;

  const left = new THREE.Mesh(
    new THREE.PlaneGeometry(roomSize, roomSize),
    red,
  );
  left.rotation.y = Math.PI / 2;
  left.position.x = -half;
  left.position.y = half;

  const right = new THREE.Mesh(
    new THREE.PlaneGeometry(roomSize, roomSize),
    green,
  );
  right.rotation.y = -Math.PI / 2;
  right.position.x = half;
  right.position.y = half;

  const metalSphere = new THREE.Mesh(
    new THREE.SphereGeometry(1.1, 48, 32),
    metal,
  );
  metalSphere.position.set(-1.8, 1.1, -1.6);
  metalSphere.castShadow = true;
  metalSphere.receiveShadow = true;

  const matteBox = new THREE.Mesh(
    new THREE.BoxGeometry(1.9, 2.8, 1.9),
    matte,
  );
  matteBox.position.set(1.6, 1.4, -2.2);
  matteBox.rotation.y = -0.38;
  matteBox.castShadow = true;
  matteBox.receiveShadow = true;

  [floor, ceiling, back, left, right].forEach((wall) => {
    wall.receiveShadow = true;
  });

  const lightPanel = new THREE.Mesh(
    new THREE.PlaneGeometry(3, 3),
    lightPanelMaterial,
  );
  lightPanel.position.set(0, roomSize - 0.02, -1.2);
  lightPanel.rotation.x = Math.PI / 2;

  const areaLight = new THREE.RectAreaLight(
    0xffffff,
    8.5,
    3.6,
    3.6,
  );
  areaLight.position.copy(lightPanel.position);
  areaLight.position.y -= 0.04;
  areaLight.lookAt(0, 1, -1.2);

  const point = new THREE.PointLight(
    0xfff3df,
    34,
    14,
    2,
  );
  point.position.copy(areaLight.position);
  point.position.y -= 0.2;
  point.castShadow = true;
  point.shadow.mapSize.set(512, 512);
  point.shadow.radius = 6;
  point.shadow.bias = -0.001;

  const ambient = new THREE.AmbientLight(
    0xffffff,
    0.08,
  );

  const metalCubemap = new LiveCubemap({
    fps: 24,
    resolutionScale: 1 / 32,
    intensity: 1,
    excludeParent: true,
  });

  const bakeOptions = {
    cubemapSize: 32,
    near: 0.05,
    far: 20,
    bounces: 0,
  };

  const { probes, createHelper } = createProbeGrid(
    renderer,
    9.6,
    9.6,
    9.6,
    6,
    6,
    6,
  );

  probes.position.set(0, half, 0);
  probes.visible = false;

  const controls = {
    liveCubemap: true,
    lightProbes: true,
    showProbeHelper: false,
  };

  metalCubemap.setup(metalSphere);

  root.add(
    floor,
    ceiling,
    back,
    left,
    right,
    metalSphere,
    matteBox,
    lightPanel,
    areaLight,
    point,
    ambient,
  );

  scene.add(root);

  // Bake first. The WebGPU helper binds probes.texture in its constructor,
  // and that texture is created during bake().
  bakeProbeGrid(
    probes,
    renderer,
    scene,
    bakeOptions,
  );

  probes.visible = controls.lightProbes;

  const probeHelper = createHelper(probes);
  probeHelper.visible = controls.showProbeHelper;
  probeHelper.update?.();

  root.add(
    probes,
    probeHelper,
  );

  const update = (deltaTime) => {
    if (controls.liveCubemap) {
      metalCubemap.update(
        scene,
        renderer,
        deltaTime,
      );
    }

    if (metal.envMap !== metalCubemap.map) {
      metal.envMap = metalCubemap.map ?? null;
      metal.envMapIntensity = metalCubemap.intensity;
      metal.needsUpdate = true;
    } else if (
      metal.envMapIntensity !== metalCubemap.intensity
    ) {
      metal.envMapIntensity = metalCubemap.intensity;
    }
  };

  return {
    update,

    gui: (folder) => {
      folder
        .add(controls, 'liveCubemap')
        .name('Live Cubemap');

      folder
        .add(
          metalCubemap,
          'fps',
          1,
          120,
          1,
        )
        .name('Cubemap FPS');

      folder
        .add(
          metalCubemap,
          'resolutionScale',
          0.01,
          1,
          0.01,
        )
        .name('Cubemap Scale');

      folder
        .add(
          metalCubemap,
          'intensity',
          0,
          5,
          0.01,
        )
        .name('Reflection Intensity');

      folder
        .add(
          controls,
          'lightProbes',
        )
        .name('Light Probes')
        .onChange((value) => {
          probes.visible = value;
        });

      folder
        .add(
          controls,
          'showProbeHelper',
        )
        .name('Show Probe Helper')
        .onChange((value) => {
          probeHelper.visible = value;
        });
    },

    cleanup: () => {
      disposeSceneParticleRoot(
        scene,
        particleRoot,
      );

      scene.remove(root);

      probes.dispose();
      probeHelper.dispose();

      [
        floor,
        ceiling,
        back,
        left,
        right,
        metalSphere,
        matteBox,
        lightPanel,
      ].forEach((mesh) => {
        mesh.geometry.dispose();
      });

      [
        white,
        red,
        green,
        metal,
        matte,
        lightPanelMaterial,
      ].forEach((material) => {
        material.dispose();
      });

      metalCubemap.dispose();
    },
  };
}

loadCornellBox.author = 'rzmay';
