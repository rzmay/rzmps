import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

type Geometry = THREE.BufferGeometry & { boundsTree: MeshBVH };
interface Entry {
  geometry: Geometry;
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  positionVersion: number;
  index: THREE.BufferAttribute | null;
  indexVersion: number;
  count: number;
  ranges: string;
}
const trees = new WeakMap<THREE.BufferGeometry, Map<boolean, Entry>>();
const observed = new WeakSet<THREE.BufferGeometry>();

/** Shared indirect CPU acceleration; never adds an index or reorders triangles on the receiver. */
export default function getDecalReceiverGeometry(source: THREE.BufferGeometry, allTriangles = false): Geometry {
  const position = source.getAttribute('position');
  const count = source.index?.count ?? position.count;
  const version = 'version' in position ? position.version : position.data.version;
  // DecalGeometry ignores material groups/drawRange, unlike raycasting. Preserve both query semantics.
  const ignoreRanges = allTriangles && (source.groups.length > 0
    || source.drawRange.start !== 0 || source.drawRange.count !== Infinity);
  const ranges = ignoreRanges ? '' : `${source.drawRange.start}:${source.drawRange.count}:`
    + source.groups.map(group => `${group.start}:${group.count}:${group.materialIndex}`).join('|');
  let entries = trees.get(source);
  if (!entries) {
    entries = new Map();
    trees.set(source, entries);
    if (!observed.has(source)) {
      observed.add(source);
      source.addEventListener('dispose', () => trees.delete(source));
    }
  }
  let entry = entries.get(ignoreRanges);

  if (!entry || entry.position !== position || entry.index !== source.index
    || entry.indexVersion !== (source.index?.version ?? 0) || entry.count !== count || entry.ranges !== ranges) {
    // This view owns BVH/index/bounds metadata while sharing the receiver's vertex attributes.
    const geometry = new THREE.BufferGeometry() as Geometry;
    geometry.attributes = source.attributes;
    geometry.setIndex(source.index);
    if (!ignoreRanges) {
      geometry.groups = source.groups.map(group => ({ ...group }));
      geometry.drawRange = { ...source.drawRange };
    }
    geometry.boundsTree = new MeshBVH(geometry, { indirect: true });
    entry = { geometry, position, positionVersion: version, index: source.index,
      indexVersion: source.index?.version ?? 0, count, ranges };
    entries.set(ignoreRanges, entry);
  } else if (entry.positionVersion !== version) {
    entry.geometry.boundsTree.refit();
    entry.positionVersion = version;
  }

  entry.geometry.attributes = source.attributes;
  return entry.geometry;
}
