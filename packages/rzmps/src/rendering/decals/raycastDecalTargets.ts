import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

type Geometry = THREE.BufferGeometry & { boundsTree?: MeshBVH };
interface Entry {
  geometry: Geometry;
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  positionVersion: number;
  index: THREE.BufferAttribute | null;
  indexVersion: number;
  count: number;
  groups: string;
}
const trees = new WeakMap<THREE.BufferGeometry, Entry>();
const proxy = new THREE.Mesh();

/** CPU query only: preserve source triangle order and reuse/refit one indirect BVH per dense geometry. */
export default function raycastDecalTargets(raycaster: THREE.Raycaster, targets: THREE.Mesh[]): THREE.Intersection[] {
  const hits: THREE.Intersection[] = [];
  for (const target of targets) {
    if (!target.layers.test(raycaster.layers)) continue;
    const source = target.geometry as Geometry;
    const position = source.getAttribute('position');
    const count = source.index?.count ?? position.count;
    // Respect custom picking and morph deformation; tiny meshes are cheaper to query directly.
    if (target.raycast !== THREE.Mesh.prototype.raycast || target.morphTargetInfluences?.length || count < 192) {
      raycaster.intersectObject(target, false, hits);
      continue;
    }

    let geometry = source;
    if (!source.boundsTree) {
      const version = 'version' in position ? position.version : position.data.version;
      const groups =
        `${source.drawRange.start}:${source.drawRange.count}:` +
        source.groups.map(group => `${group.start}:${group.count}:${group.materialIndex}`).join('|');
      let entry = trees.get(source);
      if (
        !entry ||
        entry.position !== position ||
        entry.index !== source.index ||
        entry.indexVersion !== (source.index?.version ?? 0) ||
        entry.count !== count ||
        entry.groups !== groups
      ) {
        // The lightweight geometry view shares attributes but owns its index/BVH/bounds metadata.
        // In particular, BVH construction must not add an index or reorder the caller's geometry.
        geometry = Object.create(source) as Geometry;
        geometry.boundsTree = new MeshBVH(geometry, { indirect: true });
        entry = {
          geometry,
          position,
          positionVersion: version,
          index: source.index,
          indexVersion: source.index?.version ?? 0,
          count,
          groups,
        };
        trees.set(source, entry);
      } else if (entry.positionVersion !== version) {
        entry.geometry.boundsTree!.refit();
        entry.positionVersion = version;
      }
      geometry = entry.geometry;
    }

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
