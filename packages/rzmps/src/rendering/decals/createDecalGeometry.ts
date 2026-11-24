import * as THREE from 'three';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';
import getDecalReceiverGeometry from './getDecalReceiverGeometry';

/** Limit dense receivers to nearby triangles, retaining Three.js projection, clipping and normals. */
export default function createDecalGeometry(
  target: THREE.Mesh,
  position: THREE.Vector3,
  orientation: THREE.Euler,
  size: THREE.Vector3,
): THREE.BufferGeometry {
  const source = target.geometry;
  if (!source.attributes.position || (source.index?.count ?? source.attributes.position.count) < 192) {
    return new DecalGeometry(target, position, orientation, size);
  }

  // Enclose the world-space projector in receiver space, including nonuniform scale and sheared parents.
  const projector = new THREE.Matrix4().makeRotationFromEuler(orientation).setPosition(position);
  const localProjector = target.matrixWorld.clone().invert().multiply(projector);
  const half = size.clone().multiplyScalar(0.5);
  const bounds = new THREE.Box3(half.clone().negate(), half).applyMatrix4(localProjector);
  bounds.expandByScalar(1e-7 * Math.max(1, bounds.getSize(new THREE.Vector3()).length()));
  const accelerated = getDecalReceiverGeometry(source, true);
  const triangles: number[] = [];
  accelerated.boundsTree.shapecast({
    intersectsBounds: box => bounds.intersectsBox(box),
    intersectsTriangle: (triangle, index) => {
      if (bounds.intersectsTriangle(triangle)) triangles.push(index);
      return false;
    },
  });
  // Keep source order so clipped triangles and transparent rendering remain deterministic.
  triangles.sort((a, b) => a - b);

  const indices = new Uint32Array(triangles.length * 3);
  for (let i = 0; i < triangles.length; i++) {
    for (let corner = 0; corner < 3; corner++) {
      const vertex = triangles[i] * 3 + corner;
      indices[i * 3 + corner] = source.index ? source.index.getX(vertex) : vertex;
    }
  }
  // Share vertex attributes; only the selected index list is temporary. Nothing is uploaded to the GPU.
  const selected = new THREE.BufferGeometry();
  selected.attributes = source.attributes;
  selected.setIndex(new THREE.BufferAttribute(indices, 1));
  const receiver = new THREE.Mesh(selected, target.material);
  receiver.matrixWorld.copy(target.matrixWorld);
  try {
    return new DecalGeometry(receiver, position, orientation, size);
  } finally {
    selected.dispose();
  }
}
