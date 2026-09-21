import * as THREE from 'three';

export default function loadCheckerboard(scene) {
  const ambient = new THREE.AmbientLight(0xffffff, 0.35);
  const point = new THREE.PointLight(0xffffff, 260);
  point.position.set(10, 20, 0);
  point.castShadow = true;

  const pixels = new Uint8Array([
    230, 230, 230, 255,
    45, 45, 45, 255,
    45, 45, 45, 255,
    230, 230, 230, 255,
  ]);
  const checkerTexture = new THREE.DataTexture(pixels, 2, 2, THREE.RGBAFormat);
  checkerTexture.wrapS = THREE.RepeatWrapping;
  checkerTexture.wrapT = THREE.RepeatWrapping;
  checkerTexture.repeat.set(20, 20);
  checkerTexture.magFilter = THREE.NearestFilter;
  checkerTexture.needsUpdate = true;

  const floorGeometry = new THREE.PlaneGeometry(40, 40);
  const floorMaterial = new THREE.MeshStandardMaterial({
    map: checkerTexture,
    roughness: 0.9,
  });
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;

  scene.add(ambient, point, floor);

  return () => {
    scene.remove(ambient, point, floor);
    floorGeometry.dispose();
    floorMaterial.dispose();
    checkerTexture.dispose();
  };
}
