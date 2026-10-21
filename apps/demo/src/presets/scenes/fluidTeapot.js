import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { FluidCollider } from '@rzmps/rzmps';
import teapotModel from '../../assets/models/utah_teapot.obj?url';
import {
  createSceneParticleRoot,
  disposeSceneParticleRoot,
} from './particleRoot';

function addTeapotColliders(root) {
  const wallCount = 32;
  const radius = 1.2;
  for (let index = 0; index < wallCount; index += 1) {
    const angle = index / wallCount * Math.PI * 2;
    const collider = FluidCollider.Box({ surfaceThickness: 0.015 }, 0.3, 2, 0.2);
    collider.name = `Teapot Wall Collider ${index + 1}`;
    collider.position.set(Math.sin(angle) * radius, 0.5, Math.cos(angle) * radius);
    collider.rotation.y = angle;
    root.add(collider);
  }

  const bottom = FluidCollider.Box({ surfaceThickness: 0.015 }, 2.45, 0.28, 2.45);
  bottom.name = 'Teapot Bottom Collider';
  bottom.position.y = -0.38;
  root.add(bottom);
}

export default async function createFluidTeapot(scene) {
  const root = new THREE.Group();
  root.name = 'Fluid Teapot Scene';
  const particleRoot = createSceneParticleRoot(scene, [0, 2.55, 0]);
  const material = new THREE.MeshPhysicalMaterial({
    color: '#cbd5dc',
    roughness: 0.22,
    metalness: 0.15,
    clearcoat: 0.45,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const floorMaterial = new THREE.MeshStandardMaterial({
    color: '#25272b',
    roughness: 0.88,
  });

  const teapot = await new OBJLoader().loadAsync(teapotModel);
  teapot.name = 'Lidless Utah Teapot';
  teapot.scale.setScalar(0.76);
  teapot.position.y = -0.43;
  let teapotGeometry;
  teapot.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    teapotGeometry ??= object.geometry;
    object.material = material;
    object.castShadow = true;
    object.receiveShadow = true;
  });
  root.add(teapot);
  if (teapotGeometry) {
    const surfaceCollider = new FluidCollider({
      geometry: teapotGeometry,
      surfaceThickness: 0.02,
      gridOccupancy: false,
      particleCollision: true,
    });
    surfaceCollider.name = 'Teapot Surface Collider';
    surfaceCollider.position.copy(teapot.position);
    surfaceCollider.quaternion.copy(teapot.quaternion);
    surfaceCollider.scale.copy(teapot.scale);
    root.add(surfaceCollider);
  }
  addTeapotColliders(root);

  const floor = new THREE.Mesh(new THREE.BoxGeometry(18, 0.2, 14), floorMaterial);
  floor.name = 'Fluid Studio Floor';
  floor.position.y = -0.62;
  floor.receiveShadow = true;
  root.add(floor);
  const floorCollider = FluidCollider.Box({ surfaceThickness: 0.015 }, 18, 2, 14);
  floorCollider.name = 'Fluid Studio Floor Collider';
  floorCollider.position.set(floor.position.x, floor.position.y - 0.9, floor.position.z);
  root.add(floorCollider);

  const hemisphere = new THREE.HemisphereLight('#edf7ff', '#75504a', 1.3);
  const key = new THREE.DirectionalLight('#fff2dc', 3.5);
  key.position.set(-5, 9, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  const rim = new THREE.PointLight('#61b9ff', 55, 14, 2);
  rim.position.set(4.5, 4, 3.5);
  root.add(hemisphere, key, rim);

  scene.background = new THREE.Color('#17191c');
  scene.add(root);

  return () => {
    disposeSceneParticleRoot(scene, particleRoot);
    root.removeFromParent();
    const geometries = new Set();
    root.traverse((object) => {
      if (object instanceof THREE.Mesh) geometries.add(object.geometry);
      if (object instanceof FluidCollider && object.geometry) geometries.add(object.geometry);
    });
    geometries.forEach((geometry) => geometry.dispose());
    material.dispose();
    floorMaterial.dispose();
  };
}

createFluidTeapot.author = "rzmay";
createFluidTeapot.description = "A lidless Utah teapot filled from above by the FLIP liquid preset.";
