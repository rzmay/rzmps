import * as THREE from 'three';

const raycaster = new THREE.Raycaster();

const rayDirection = new THREE.Vector3(1, 0.371, 0.529).normalize();

export default function isPointInMesh(
  point: THREE.Vector3,
  mesh: THREE.Mesh,
): boolean {
  raycaster.set(point, rayDirection);

  const intersects = raycaster.intersectObject(
    mesh,
    false,
  );

  return intersects.length % 2 === 1;
}
