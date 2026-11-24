import * as THREE from 'three';
import { acceleratedRaycast } from 'three-mesh-bvh';
import getDecalReceiverGeometry from './getDecalReceiverGeometry';

const proxy = new THREE.Mesh();

/** CPU query only: preserve source triangle order and reuse/refit one indirect BVH per dense geometry. */
export default function raycastDecalTargets(raycaster: THREE.Raycaster, targets: THREE.Mesh[]): THREE.Intersection[] {
  const hits: THREE.Intersection[] = [];
  for (const target of targets) {
    if (!target.layers.test(raycaster.layers)) continue;
    const source = target.geometry;
    const position = source.getAttribute('position');
    const count = source.index?.count ?? position.count;
    // Respect custom picking and morph deformation; tiny meshes are cheaper to query directly.
    if (target.raycast !== THREE.Mesh.prototype.raycast || target.morphTargetInfluences?.length || count < 192) {
      raycaster.intersectObject(target, false, hits);
      continue;
    }

    const geometry = source.boundsTree ? source : getDecalReceiverGeometry(source);

    // A query proxy supplies receiver material/transform without replacing its raycast or boundsTree.
    proxy.geometry = geometry;
    proxy.material = target.material;
    proxy.matrixWorld.copy(target.matrixWorld);
    const start = hits.length;
    acceleratedRaycast.call(proxy, raycaster, hits);
    for (let i = start; i < hits.length; i++) hits[i].object = target;
  }
  // Release the last receiver's resources; retained geometry cache entries are weakly owned.
  proxy.geometry = emptyGeometry;
  proxy.material = emptyMaterial;
  return hits.sort((a, b) => a.distance - b.distance);
}

const emptyGeometry = proxy.geometry;
const emptyMaterial = proxy.material;
