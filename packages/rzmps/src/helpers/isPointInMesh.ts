import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

export const POINT_IN_MESH_DIRECTIONS = [
  new THREE.Vector3(1, 0.371, 0.529).normalize(),
  new THREE.Vector3(-0.277, 1, 0.413).normalize(),
  new THREE.Vector3(0.193, -0.337, 1).normalize(),
  new THREE.Vector3(-1, 0.211, 0.617).normalize(),
  new THREE.Vector3(0.431, -1, 0.173).normalize(),
];

const ray = new THREE.Ray();

export function countDistinctRayHits(
  point: THREE.Vector3,
  direction: THREE.Vector3,
  bvh: MeshBVH,
  epsilon: number,
): number {
  ray.set(point, direction);
  const distances = bvh.raycast(ray, THREE.DoubleSide)
    .map(({ distance }) => distance)
    .sort((a, b) => a - b);
  let count = 0;
  let previous = -Infinity;
  distances.forEach((distance) => {
    if (distance - previous > epsilon) {
      count += 1;
      previous = distance;
    }
  });
  return count;
}

/** Majority parity avoids making containment depend on one arbitrary ray. */
export default function isPointInMesh(
  point: THREE.Vector3,
  bvh: MeshBVH,
  boundsDiagonal: number,
): boolean {
  const epsilon = Math.max(boundsDiagonal, Number.EPSILON) * 1e-7;
  let insideVotes = 0;
  const requiredVotes = Math.floor(POINT_IN_MESH_DIRECTIONS.length / 2) + 1;

  for (let index = 0; index < POINT_IN_MESH_DIRECTIONS.length; index += 1) {
    insideVotes += countDistinctRayHits(
      point,
      POINT_IN_MESH_DIRECTIONS[index],
      bvh,
      epsilon,
    ) % 2;
    if (insideVotes >= requiredVotes) return true;
    if (insideVotes + POINT_IN_MESH_DIRECTIONS.length - index - 1 < requiredVotes) return false;
  }

  return false;
}
