import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { LiveCubemap } from '@rzmps/rzmps';

let rectAreaLightsInitialized = false;

function initializeRectAreaLights() {
  if (rectAreaLightsInitialized) {
    return;
  }

  RectAreaLightUniformsLib.init();
  rectAreaLightsInitialized = true;
}

export default function loadCornellBox(scene, renderer) {
  initializeRectAreaLights();

  const root = new THREE.Group();
  root.name = 'Cornell Box Scene';

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

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(roomSize, roomSize), white);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0;

  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(roomSize, roomSize), white);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = roomSize;

  const back = new THREE.Mesh(new THREE.PlaneGeometry(roomSize, roomSize), white);
  back.position.z = -half;
  back.position.y = half;

  const left = new THREE.Mesh(new THREE.PlaneGeometry(roomSize, roomSize), red);
  left.rotation.y = Math.PI / 2;
  left.position.x = -half;
  left.position.y = half;

  const right = new THREE.Mesh(new THREE.PlaneGeometry(roomSize, roomSize), green);
  right.rotation.y = -Math.PI / 2;
  right.position.x = half;
  right.position.y = half;

  const metalSphere = new THREE.Mesh(new THREE.SphereGeometry(1.1, 48, 32), metal);
  metalSphere.position.set(-1.8, 1.1, -1.6);
  metalSphere.castShadow = true;
  metalSphere.receiveShadow = true;

  const matteBox = new THREE.Mesh(new THREE.BoxGeometry(1.9, 2.8, 1.9), matte);
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

  const areaLight = new THREE.RectAreaLight(0xffffff, 8, 3, 3);
  areaLight.position.copy(lightPanel.position);
  areaLight.position.y -= 0.04;
  areaLight.lookAt(0, 1, -1.2);

  const point = new THREE.PointLight(0xffffff, 35, 14, 2);
  point.position.copy(areaLight.position);
  point.position.y -= 0.2;
  point.castShadow = true;
  point.shadow.mapSize.set(1024, 1024);

  const ambient = new THREE.AmbientLight(0xffffff, 0.12);
  const metalCubemap = new LiveCubemap({
    fps: 24,
    resolutionScale: 0.125,
    intensity: 1,
    excludeParent: true,
  });

  metalCubemap.setup(metalSphere);

  let lastFrame = performance.now() / 1000;
  let frameId;

  const animate = () => {
    const now = performance.now() / 1000;
    const dt = now - lastFrame;

    metalCubemap.update(scene, renderer, dt);
    if (metal.envMap !== metalCubemap.map) {
      metal.envMap = metalCubemap.map ?? null;
      metal.envMapIntensity = metalCubemap.intensity;
      metal.needsUpdate = true;
    }

    lastFrame = now;

    frameId = requestAnimationFrame(animate);
  }

  animate();

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

  return () => {
    scene.remove(root);
    cancelAnimationFrame(frameId);

    [floor, ceiling, back, left, right, metalSphere, matteBox, lightPanel].forEach((mesh) => {
      mesh.geometry.dispose();
    });

    [white, red, green, metal, matte, lightPanelMaterial].forEach((material) => {
      material.dispose();
    });

    metalCubemap.dispose();
  };
}
