import * as THREE from 'three';
import {
  createSceneParticleRoot,
  disposeSceneParticleRoot,
} from './particleRoot';

export default function loadCheckerboard(scene) {
  const floorSize = 40;
  const checkerSquaresPerTexture = 2;
  const particleRoot = createSceneParticleRoot(scene);
  const ambient = new THREE.AmbientLight(0xffffff, 0.35);
  const point = new THREE.PointLight(0xffffff, 260);
  point.position.set(10, 20, 0);
  point.castShadow = true;
  const settings = { lightStrength: 1 };
  const setLightStrength = strength => {
    settings.lightStrength = Math.max(0, strength);
    ambient.intensity = 0.35 * settings.lightStrength;
    point.intensity = 260 * settings.lightStrength;
  };

  const pixels = new Uint8Array([
    230, 230, 230, 255,
    45, 45, 45, 255,
    45, 45, 45, 255,
    230, 230, 230, 255,
  ]);
  const checkerTexture = new THREE.DataTexture(pixels, 2, 2, THREE.RGBAFormat);
  checkerTexture.wrapS = THREE.RepeatWrapping;
  checkerTexture.wrapT = THREE.RepeatWrapping;
  checkerTexture.repeat.set(floorSize / checkerSquaresPerTexture, floorSize / checkerSquaresPerTexture);
  checkerTexture.magFilter = THREE.NearestFilter;
  checkerTexture.needsUpdate = true;

  const floorGeometry = new THREE.PlaneGeometry(floorSize, floorSize);
  const floorMaterial = new THREE.MeshStandardMaterial({
    map: checkerTexture,
    roughness: 0.9,
  });
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;

  scene.add(ambient, point, floor);

  return {
    setLightStrength,
    gui: folder => {
      folder.add(settings, 'lightStrength', 0, 2, 0.01).name('Light Strength').onChange(setLightStrength);
    },
    cleanup: () => {
      disposeSceneParticleRoot(scene, particleRoot);
      scene.remove(ambient, point, floor);
      floorGeometry.dispose();
      floorMaterial.dispose();
      checkerTexture.dispose();
    },
  };
}

loadCheckerboard.author = "rzmay";
