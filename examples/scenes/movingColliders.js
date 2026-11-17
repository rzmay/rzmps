import * as THREE from 'three';
import { createSceneParticleRoot, disposeSceneParticleRoot } from '../utils/particleRoot.js';

/** Ordinary meshes: particle and fluid collision discover the same moving objects automatically. */
export default function createMovingColliders(scene) {
  const root = new THREE.Group();
  root.name = 'Moving Colliders Scene';
  const particleRoot = createSceneParticleRoot(scene, [0, 1, 0]);
  const shapes = [
    new THREE.SphereGeometry(0.55, 20, 12),
    new THREE.BoxGeometry(1.2, 0.5, 0.8),
    new THREE.CylinderGeometry(0.32, 0.45, 1.5, 16),
    new THREE.IcosahedronGeometry(0.65, 0),
  ];
  const colors = ['#4cb8dc', '#e58b50', '#d0c65c', '#997ce0'];
  const objects = shapes.map((geometry, index) => {
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
      color: colors[index], roughness: 0.35, metalness: 0.15,
    }));
    mesh.name = ['Orbiting Sphere', 'Rotating Box', 'Sweeping Cylinder', 'Orbiting Polyhedron'][index];
    mesh.castShadow = mesh.receiveShadow = true;
    root.add(mesh);
    return mesh;
  });
  const floor = new THREE.Mesh(new THREE.BoxGeometry(18, 0.2, 14),
    new THREE.MeshStandardMaterial({ color: '#303039', roughness: 0.9 }));
  floor.name = 'Moving Colliders Floor';
  floor.position.y = -0.55;
  floor.receiveShadow = true;
  root.add(floor, new THREE.HemisphereLight('#edf7ff', '#75504a', 1.25));
  const key = new THREE.DirectionalLight('#fff2dc', 3.4);
  key.position.set(-5, 9, 6);
  root.add(key);
  scene.background = new THREE.Color('#17191c');
  scene.add(root);

  // Distinct three-dimensional paths intersect the emitter/plume without deforming geometry.
  let time = 0;
  const update = (deltaTime) => {
    time += deltaTime;
    objects.forEach((mesh, index) => {
      const phase = time * (0.35 + index * 0.09) + index * Math.PI / 2;
      mesh.position.set(Math.sin(phase) * (1.1 + index * 0.2),
        1.7 + Math.sin(phase * 1.7 + index) * 0.8, Math.cos(phase * 0.8) * 1.2);
      mesh.rotation.set(phase * 0.7, phase * 1.1, Math.sin(phase) * 0.65);
    });
  };
  update(0);

  return {
    update,
    cleanup: () => {
      disposeSceneParticleRoot(scene, particleRoot);
      root.removeFromParent();
      [...objects, floor].forEach(mesh => { mesh.geometry.dispose(); mesh.material.dispose(); });
    },
  };
}

createMovingColliders.description = 'Independent rigid meshes translating and rotating through the particle region.';
createMovingColliders.metadata = { id: 'movingColliders', title: 'Moving Colliders', author: 'rzmay' };
