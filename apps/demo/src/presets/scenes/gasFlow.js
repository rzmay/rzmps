import * as THREE from 'three';
import { FluidCollider } from '@rzmps/rzmps';
import {
  createSceneParticleRoot,
  disposeSceneParticleRoot,
} from './particleRoot';

function addBoxCollider(root, size, position, material, name, rotationZ = 0) {
  const collider = FluidCollider.Box({}, ...size);
  collider.name = `${name} Collider`;
  collider.position.set(...position);
  collider.rotation.z = rotationZ;

  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.name = name;
  mesh.position.copy(collider.position);
  mesh.rotation.copy(collider.rotation);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  root.add(collider, mesh);
  return collider;
}

export default function createGasFlow(scene) {
  const root = new THREE.Group();
  root.name = 'Gas Flow Scene';
  const particleRoot = createSceneParticleRoot(scene, [0, 1, 0]);

  const colliderMaterial = new THREE.MeshStandardMaterial({
    color: '#c8d0d5',
    roughness: 0.26,
    metalness: 0.55,
  });
  const accentMaterial = new THREE.MeshStandardMaterial({
    color: '#e26d5a',
    roughness: 0.48,
    metalness: 0.08,
  });
  const floorMaterial = new THREE.MeshStandardMaterial({
    color: '#25272b',
    roughness: 0.9,
  });

  addBoxCollider(root, [5.8, 0.32, 4.2], [0, 3.25, 0], colliderMaterial, 'Gas Canopy');
  addBoxCollider(root, [0.38, 1.9, 3.2], [-1.55, 2.2, 0], accentMaterial, 'Left Baffle', -0.24);
  addBoxCollider(root, [0.38, 1.9, 3.2], [1.55, 2.2, 0], accentMaterial, 'Right Baffle', 0.24);

  const sphereCollider = FluidCollider.Sphere({
    position: new THREE.Vector3(0, 2.2, 0),
  }, 0.62, 24, 16);
  sphereCollider.name = 'Gas Splitter Collider';
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.62, 32, 20),
    colliderMaterial,
  );
  sphere.name = 'Gas Splitter';
  sphere.position.copy(sphereCollider.position);
  sphere.castShadow = true;
  root.add(sphereCollider, sphere);

  const floor = new THREE.Mesh(new THREE.BoxGeometry(18, 0.2, 14), floorMaterial);
  floor.name = 'Gas Lab Floor';
  floor.position.y = -0.55;
  floor.receiveShadow = true;
  root.add(floor);

  const hemisphere = new THREE.HemisphereLight('#edf7ff', '#75504a', 1.25);
  const key = new THREE.DirectionalLight('#fff2dc', 3.4);
  key.position.set(-5, 9, 6);
  key.castShadow = true;
  const rim = new THREE.PointLight('#69bfff', 65, 15, 2);
  rim.position.set(4.5, 4.5, 3.5);
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
    [colliderMaterial, accentMaterial, floorMaterial].forEach((material) => material.dispose());
  };
}

createGasFlow.author = "rzmay";
createGasFlow.description = "A solid-cell baffle course demonstrating Eulerian gas flow and collisions.";
