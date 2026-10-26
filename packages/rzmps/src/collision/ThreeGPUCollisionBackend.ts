import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { Node } from 'three/webgpu';
// Use the focused entry point so unrelated WebGPU helper exports cannot collide.
// @ts-expect-error three-mesh-bvh does not publish declarations for deep imports.
import { BVHComputeData } from 'three-mesh-bvh/src/webgpu/BVHComputeData.js';
import type { CollisionQuery, ICollisionBackend } from '../interfaces/ICollisionBackend';
import { isIgnoredCollisionObject } from './CollisionSceneUtils';
import capsuleBVHCollisionNode, {
  CapsuleQuery,
} from './capsuleBVHCollisionNode';

export enum CollisionGeometryUpdatePolicy {
  Static = 'static',
  TransformDynamic = 'transform-dynamic',
  GeometryDynamic = 'geometry-dynamic',
  Auto = 'auto',
}

// This policy is GPU-specific: BLAS refits distinguish transform-only and vertex
// changes. ThreeCollisionBackend rebuilds CPU octrees and has no equivalent refit.

export interface ThreeGPUCollisionBackendOptions {
  /** Scene subtree scanned when explicit object lists are not sufficient. */
  world?: THREE.Object3D;
  /** Mesh roots whose transforms and geometry are treated as immutable. */
  staticObjects?: THREE.Object3D[];
  /** Mesh roots whose world transforms may change without vertex deformation. */
  dynamicObjects?: THREE.Object3D[];
  /** Mesh roots whose position attributes may change. */
  geometryDynamicObjects?: THREE.Object3D[];
  /** Filters every candidate mesh before classification. */
  objectFilter?: (object: THREE.Object3D) => boolean;
  /** Selects static meshes discovered below world. */
  staticObjectFilter?: (object: THREE.Object3D) => boolean;
  /** Selects transform-dynamic meshes discovered below world. */
  dynamicObjectFilter?: (object: THREE.Object3D) => boolean;
  /** Selects deforming meshes discovered below world. */
  geometryDynamicObjectFilter?: (object: THREE.Object3D) => boolean;
  /** Default classification for meshes not selected by a more specific list or filter. */
  updatePolicy?: CollisionGeometryUpdatePolicy | `${CollisionGeometryUpdatePolicy}`;
}

/** Runtime observability for rebuild cost, uploads, and update-policy tuning. */
export interface ThreeGPUCollisionBackendStats {
  objects: number;
  uniqueGeometries: number;
  fullBuilds: number;
  transformUpdates: number;
  geometryRefits: number;
  topologyRebuilds: number;
  uploadBytes: number;
}

// GPU tracking records attribute/topology revisions needed by BLAS refits. The CPU
// octree tracks whole-object membership instead, so sharing the record would conflate APIs.
type TrackedMesh = {
  mesh: THREE.Mesh;
  policy: CollisionGeometryUpdatePolicy;
  matrixWorld: THREE.Matrix4;
  geometry: THREE.BufferGeometry;
  positionAttribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  positionVersion: number;
  positionCount: number;
  indexAttribute: THREE.BufferAttribute | null;
  indexVersion: number;
  indexCount: number;
  drawRangeStart: number;
  drawRangeCount: number;
};

type BVHComputeDataRuntime = BVHComputeData & {
  objects: THREE.Object3D[];
  storage: Record<string, { proxyNode?: { value?: { array?: ArrayBufferView } } }>;
  updateTransforms(): void;
  dispose(): void;
};

/** GPU-only collision geometry owner backed by three-mesh-bvh's packed TLAS and BLAS. */
export default class ThreeGPUCollisionBackend implements ICollisionBackend {
  readonly supportsCPU = false;
  readonly supportsGPU = true;

  world?: THREE.Object3D;
  staticObjects?: THREE.Object3D[];
  dynamicObjects?: THREE.Object3D[];
  geometryDynamicObjects?: THREE.Object3D[];
  objectFilter?: (object: THREE.Object3D) => boolean;
  staticObjectFilter?: (object: THREE.Object3D) => boolean;
  dynamicObjectFilter?: (object: THREE.Object3D) => boolean;
  geometryDynamicObjectFilter?: (object: THREE.Object3D) => boolean;
  updatePolicy: CollisionGeometryUpdatePolicy;

  readonly stats: ThreeGPUCollisionBackendStats = {
    objects: 0,
    uniqueGeometries: 0,
    fullBuilds: 0,
    transformUpdates: 0,
    geometryRefits: 0,
    topologyRebuilds: 0,
    uploadBytes: 0,
  };

  private tracked = new Map<string, TrackedMesh>();
  private invalidatedGeometry = new Set<string>();
  private ownedGeometryBVHs = new Map<THREE.BufferGeometry, MeshBVH>();
  private data?: BVHComputeDataRuntime;
  private capsuleQuery?: ReturnType<typeof capsuleBVHCollisionNode>;
  private initialized = false;

  get hasGeometry(): boolean {
    return this.capsuleQuery !== undefined;
  }

  /** Creates an uninitialized GPU backend; call update before constructing query nodes. */
  constructor(options: ThreeGPUCollisionBackendOptions = {}) {
    this.world = options.world;
    this.staticObjects = options.staticObjects;
    this.dynamicObjects = options.dynamicObjects;
    this.geometryDynamicObjects = options.geometryDynamicObjects;
    this.objectFilter = options.objectFilter;
    this.staticObjectFilter = options.staticObjectFilter;
    this.dynamicObjectFilter = options.dynamicObjectFilter;
    this.geometryDynamicObjectFilter = options.geometryDynamicObjectFilter;
    this.updatePolicy = (options.updatePolicy as CollisionGeometryUpdatePolicy)
      ?? CollisionGeometryUpdatePolicy.Auto;
  }

  // ICollisionBackend's CPU query is synchronous, while this backend only exposes
  // TSL query nodes. A CPU MeshBVH backend could be added separately; replacing the
  // octree would trade its inexpensive scene rebuilds for faster triangle queries.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  collide(_query: CollisionQuery): null {
    return null;
  }

  /** Marks mutation that did not increment a Three.js attribute version. */
  invalidateGeometry(object?: THREE.Object3D): void {
    if (object) {
      object.traverse((child) => {
        if (child instanceof THREE.Mesh) this.invalidatedGeometry.add(child.uuid);
      });
    } else {
      this.tracked.forEach((_tracked, uuid) => this.invalidatedGeometry.add(uuid));
    }
  }

  /** Detects membership, topology, transform, and vertex changes and updates acceleration data. */
  update(): void {
    const next = this.collectMeshes();
    let topologyChanged = !this.initialized || next.size !== this.tracked.size;
    const addedGeometries = new Set<THREE.BufferGeometry>();
    const topologyGeometries = new Set<THREE.BufferGeometry>();
    const changedGeometries = new Set<THREE.BufferGeometry>();
    let transformChanged = false;

    next.forEach((entry, uuid) => {
      const previous = this.tracked.get(uuid);
      if (!previous || previous.geometry !== entry.geometry) {
        topologyChanged = true;
        addedGeometries.add(entry.geometry);
        return;
      }

      const indexChanged = entry.indexAttribute !== previous.indexAttribute
        || entry.indexCount !== previous.indexCount;
      const vertexCountChanged = entry.positionCount !== previous.positionCount;
      const topologyRevisionChanged = entry.indexVersion !== previous.indexVersion;
      const drawRangeChanged = entry.drawRangeStart !== previous.drawRangeStart
        || entry.drawRangeCount !== previous.drawRangeCount;
      if (indexChanged || vertexCountChanged || topologyRevisionChanged || drawRangeChanged) {
        topologyChanged = true;
        topologyGeometries.add(entry.geometry);
      } else if (
        (this.invalidatedGeometry.has(uuid) || (
          entry.policy === CollisionGeometryUpdatePolicy.GeometryDynamic
          || entry.policy === CollisionGeometryUpdatePolicy.Auto
        ))
        && (
          entry.positionAttribute !== previous.positionAttribute
          || entry.positionVersion !== previous.positionVersion
          || this.invalidatedGeometry.has(uuid)
        )
      ) {
        changedGeometries.add(entry.geometry);
      }

      if (
        entry.policy !== CollisionGeometryUpdatePolicy.Static
        && !entry.matrixWorld.equals(previous.matrixWorld)
      ) transformChanged = true;
    });

    this.releaseUnusedGeometryBVHs(next);
    this.tracked = next;
    this.invalidatedGeometry.clear();
    this.stats.objects = next.size;
    this.stats.uniqueGeometries = new Set(
      Array.from(next.values(), ({ geometry }) => geometry.uuid),
    ).size;

    addedGeometries.forEach((geometry) => this.ensureGeometryBVH(geometry));
    topologyGeometries.forEach((geometry) => this.rebuildGeometryBVH(geometry));
    changedGeometries.forEach((geometry) => this.ensureGeometryBVH(geometry).refit());

    if (next.size === 0) {
      this.disposeData();
      this.initialized = true;
      return;
    }

    if (topologyChanged || changedGeometries.size > 0 || !this.data) {
      this.rebuildData(topologyChanged, topologyGeometries.size, changedGeometries.size);
    } else if (transformChanged) {
      this.data.updateTransforms();
      this.stats.transformUpdates += 1;
      this.stats.uploadBytes += ThreeGPUCollisionBackend.storageByteLength(this.data, ['nodes', 'transforms']);
    }
    this.initialized = true;
  }

  /** Returns a TSL hit record for a swept capsule query. */
  queryCapsule(
    start: Node<'vec3'>,
    end: Node<'vec3'>,
    radius: Node<'float'>,
  ): Node {
    if (!this.capsuleQuery) {
      throw new Error('ThreeGPUCollisionBackend has no collision geometry. Call update() first.');
    }
    const query = (CapsuleQuery(start, end, radius) as unknown as Node<'vec3'>)
      .toVar('rzmpsCapsuleQuery');
    return (this.capsuleQuery(query) as unknown as Node<'vec3'>)
      .toVar('rzmpsCapsuleHit');
  }

  /** Supplies already-evaluated geometry without a GPU-to-CPU particle readback. */
  setEvaluatedGeometry(mesh: THREE.Mesh, geometry: THREE.BufferGeometry): void {
    mesh.geometry = geometry;
    this.invalidateGeometry(mesh);
  }

  /** Releases packed GPU data and BVHs created by this backend. */
  destroy(): void {
    this.disposeData();
    this.tracked.clear();
    this.invalidatedGeometry.clear();
    this.releaseOwnedGeometryBVHs();
    this.ownedGeometryBVHs.clear();
  }

  private rebuildData(
    topologyChanged: boolean,
    topologyGeometryCount: number,
    changedGeometryCount: number,
  ): void {
    const meshes = Array.from(this.tracked.values(), ({ mesh }) => mesh);
    new Set(meshes.map((mesh) => mesh.geometry)).forEach((geometry) => {
      this.ensureGeometryBVH(geometry);
    });
    if (this.data) {
      this.data.objects = meshes;
    } else {
      this.data = new BVHComputeData(meshes) as BVHComputeDataRuntime;
    }
    this.data.update();
    if (!this.capsuleQuery) {
      this.capsuleQuery = capsuleBVHCollisionNode(this.data as unknown as Parameters<
        typeof capsuleBVHCollisionNode
      >[0]);
    }
    this.stats.fullBuilds += 1;
    if (topologyChanged && this.initialized) {
      this.stats.topologyRebuilds += Math.max(topologyGeometryCount, 1);
    }
    this.stats.geometryRefits += changedGeometryCount;
    this.stats.uploadBytes += ThreeGPUCollisionBackend.storageByteLength(
      this.data,
      ['nodes', 'index', 'attributes', 'transforms'],
    );
  }

  private ensureGeometryBVH(geometry: THREE.BufferGeometry): MeshBVH {
    const withBVH = geometry as THREE.BufferGeometry & { boundsTree?: MeshBVH };
    if (!withBVH.boundsTree) {
      withBVH.boundsTree = new MeshBVH(geometry);
      this.ownedGeometryBVHs.set(geometry, withBVH.boundsTree);
    }
    return withBVH.boundsTree;
  }

  private rebuildGeometryBVH(geometry: THREE.BufferGeometry): void {
    const withBVH = geometry as THREE.BufferGeometry & { boundsTree?: MeshBVH };
    withBVH.boundsTree = new MeshBVH(geometry);
    this.ownedGeometryBVHs.set(geometry, withBVH.boundsTree);
  }

  private releaseUnusedGeometryBVHs(next: Map<string, TrackedMesh>): void {
    const retained = new Set(Array.from(next.values(), ({ geometry }) => geometry));
    this.ownedGeometryBVHs.forEach((owned, geometry) => {
      if (retained.has(geometry)) return;
      const withBVH = geometry as THREE.BufferGeometry & { boundsTree?: MeshBVH };
      if (withBVH.boundsTree === owned) delete withBVH.boundsTree;
      this.ownedGeometryBVHs.delete(geometry);
    });
  }

  private releaseOwnedGeometryBVHs(): void {
    this.ownedGeometryBVHs.forEach((owned, geometry) => {
      const withBVH = geometry as THREE.BufferGeometry & { boundsTree?: MeshBVH };
      if (withBVH.boundsTree === owned) delete withBVH.boundsTree;
    });
  }

  private collectMeshes(): Map<string, TrackedMesh> {
    const result = new Map<string, TrackedMesh>();
    const add = (mesh: THREE.Mesh, policy: CollisionGeometryUpdatePolicy) => {
      if (this.objectFilter && !this.objectFilter(mesh)) return;
      mesh.updateWorldMatrix(true, false);
      const geometry = mesh.geometry;
      const position = geometry.getAttribute('position');
      if (!position) return;
      const index = geometry.index;
      result.set(mesh.uuid, {
        mesh,
        policy,
        matrixWorld: mesh.matrixWorld.clone(),
        geometry,
        positionAttribute: position,
        positionVersion: ThreeGPUCollisionBackend.attributeVersion(position),
        positionCount: position.count,
        indexAttribute: index,
        indexVersion: ThreeGPUCollisionBackend.attributeVersion(index),
        indexCount: index?.count ?? position.count,
        drawRangeStart: geometry.drawRange.start,
        drawRangeCount: geometry.drawRange.count,
      });
    };
    const addRoot = (root: THREE.Object3D, policy: CollisionGeometryUpdatePolicy) => {
      root.updateWorldMatrix(true, true);
      root.traverse((object) => {
        if (object instanceof THREE.Mesh && !isIgnoredCollisionObject(object)) add(object, policy);
      });
    };

    this.staticObjects?.forEach((root) => addRoot(root, CollisionGeometryUpdatePolicy.Static));
    this.dynamicObjects?.forEach((root) => addRoot(root, CollisionGeometryUpdatePolicy.TransformDynamic));
    this.geometryDynamicObjects?.forEach((root) => addRoot(root, CollisionGeometryUpdatePolicy.GeometryDynamic));
    if (this.world) {
      this.world.updateWorldMatrix(true, true);
      this.world.traverse((object) => {
        if (!(object instanceof THREE.Mesh) || isIgnoredCollisionObject(object)) return;
        let policy = this.updatePolicy;
        if (this.geometryDynamicObjectFilter?.(object)) policy = CollisionGeometryUpdatePolicy.GeometryDynamic;
        else if (this.dynamicObjectFilter?.(object)) policy = CollisionGeometryUpdatePolicy.TransformDynamic;
        else if (this.staticObjectFilter?.(object)) policy = CollisionGeometryUpdatePolicy.Static;
        add(object, policy);
      });
    }
    return result;
  }

  private disposeData(): void {
    this.data?.dispose();
    this.data = undefined;
    this.capsuleQuery = undefined;
  }

  private static storageByteLength(data: BVHComputeDataRuntime, keys: string[]): number {
    const arrays = new Set<ArrayBufferView>();
    keys.forEach((key) => {
      const array = data.storage[key]?.proxyNode?.value?.array;
      if (array) arrays.add(array);
    });
    return Array.from(arrays).reduce((bytes, array) => bytes + array.byteLength, 0);
  }

  private static attributeVersion(
    attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null | undefined,
  ): number {
    if (!attribute) return -1;
    return 'version' in attribute ? Number(attribute.version) : Number(attribute.data.version ?? 0);
  }
}
