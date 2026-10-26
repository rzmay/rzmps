import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { FluidCollider } from '@rzmps/rzmps';
import teapotModel from '../../assets/models/utah_teapot_quad.obj?url';
import {
  createSceneParticleRoot,
  disposeSceneParticleRoot,
} from './particleRoot';

function createTeapotColliderGeometry(source) {
  // Collision only needs positions; UV and normal seams must not prevent welding.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', source.getAttribute('position').clone());
  return mergeVertices(geometry, 1e-4);
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
    const collider = new FluidCollider({
      geometry: createTeapotColliderGeometry(teapotGeometry),
      surfaceThickness: 0.02,
      gridOccupancy: true,
      bakedFieldResolution: 48,
      particleCollision: true,
    });
    collider.name = 'Utah Teapot Fluid Collider';
    collider.position.copy(teapot.position);
    collider.quaternion.copy(teapot.quaternion);
    collider.scale.copy(teapot.scale);
    root.add(collider);
  }

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
