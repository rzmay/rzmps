import * as THREE from 'three';
import { storage } from 'three/tsl';
import { StorageBufferAttribute, StorageBufferNode } from 'three/webgpu';

interface OctreeNode {
  box: THREE.Box3;
  bounds: THREE.Box3;
  subTrees?: OctreeNode[];
  triangles?: THREE.Triangle[];
}

export interface FlattenedOctree {
  nodes: StorageBufferNode<"vec4">;
  triangles: StorageBufferNode<"vec3">;
}

export function flattenThreeOctree(rootOctree: OctreeNode): FlattenedOctree {
  const flatNodes: number[] = [];
  const flatTriangles: number[] = [];

  function traverse(node: OctreeNode): number {
    const nodeIndex = flatNodes.length / 16;
    const offset = flatNodes.length;
    for (let i = 0; i < 16; i++) flatNodes.push(0);

    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    node.box.getCenter(center);
    node.box.getSize(size);
    const halfExtent = size.x * 0.5;

    // vec4 0
    flatNodes[offset + 0] = center.x;
    flatNodes[offset + 1] = center.y;
    flatNodes[offset + 2] = center.z;
    flatNodes[offset + 3] = halfExtent;

    // vec4 1
    if (node.triangles && node.triangles.length > 0) {
      flatNodes[offset + 4] = flatTriangles.length / 9;
      flatNodes[offset + 5] = node.triangles.length;
      node.triangles.forEach((triangle) => {
        flatTriangles.push(
          triangle.a.x, triangle.a.y, triangle.a.z,
          triangle.b.x, triangle.b.y, triangle.b.z,
          triangle.c.x, triangle.c.y, triangle.c.z,
        );
      });
    } else {
      flatNodes[offset + 4] = -1;
      flatNodes[offset + 5] = 0;
    }
    flatNodes[offset + 6] = 0;
    flatNodes[offset + 7] = 0;

    // vec4 2 & 3: Sparse children mapping initialization (-1)
    for (let i = 8; i < 16; i++) flatNodes[offset + i] = -1;

    if (node.subTrees && node.subTrees.length > 0) {
      for (const childNode of node.subTrees) {
        const childCenter = new THREE.Vector3();
        childNode.box.getCenter(childCenter);

        const bitX = childCenter.x > center.x ? 1 : 0;
        const bitY = childCenter.y > center.y ? 2 : 0;
        const bitZ = childCenter.z > center.z ? 4 : 0;
        const octantIndex = bitX + bitY + bitZ;

        const childFlatIndex = traverse(childNode);
        flatNodes[offset + 8 + octantIndex] = childFlatIndex;
      }
    }
    return nodeIndex;
  }

  traverse(rootOctree);

  // The nodes array is parsed in groups of 4 floats (vec4)
  const nodeAttribute = new StorageBufferAttribute(new Float32Array(flatNodes), 4);

  // The triangles array is parsed in groups of 3 floats (vec3 vertex positions)
  const triangleAttribute = new StorageBufferAttribute(new Float32Array(flatTriangles), 3);

  // Convert into Read-Only TSL Storage Nodes
  const nodes = storage(nodeAttribute, 'vec4', nodeAttribute.count).toReadOnly();
  const triangles = storage(triangleAttribute, 'vec3', triangleAttribute.count).toReadOnly();

  return {
    nodes,
    triangles,
  };
}

export function updateFlattenedOctree(
  current: FlattenedOctree | undefined,
  next: FlattenedOctree,
): FlattenedOctree {
  if (!current) return next;

  const currentNodes = current.nodes.value as StorageBufferAttribute;
  const currentTriangles = current.triangles.value as StorageBufferAttribute;
  const nextNodes = next.nodes.value as StorageBufferAttribute;
  const nextTriangles = next.triangles.value as StorageBufferAttribute;
  if (
    currentNodes.array.length !== nextNodes.array.length
    || currentTriangles.array.length !== nextTriangles.array.length
  ) return next;

  currentNodes.array.set(nextNodes.array);
  currentTriangles.array.set(nextTriangles.array);
  currentNodes.needsUpdate = true;
  currentTriangles.needsUpdate = true;
  return current;
}
