import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { StorageBufferAttribute, type Node } from 'three/webgpu';
import { If, storage, uniform } from 'three/tsl';
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
  /** Retains rigid transform history for explicit queryMovingCapsule calls. Defaults to false. */
  sweptMotion?: boolean;
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
  structs: { transform: { getLength(): number } };
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
  readonly sweptMotion: boolean;

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
  private frameToken?: unknown;
  private frameObjects = '';
  private motionAttribute?: StorageBufferAttribute;
  private movingQuery?: ReturnType<typeof capsuleBVHCollisionNode>;
  private readonly motionPadding = uniform(0);
  private _motionVersion = 0;

  get hasMotion(): boolean { return this.motionPadding.value > 0; }
  get motionVersion(): number { return this._motionVersion; }

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
    this.sweptMotion = options.sweptMotion ?? false;
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
  update(_deltaTime?: number, frameToken?: unknown): void {
    const objects = [this.world?.uuid, this.staticObjects?.map(object => object.uuid),
      this.dynamicObjects?.map(object => object.uuid), this.geometryDynamicObjects?.map(object => object.uuid)]
      .join('|');
    if (frameToken !== undefined && frameToken === this.frameToken && objects === this.frameObjects
      && this.invalidatedGeometry.size === 0) return;
    this.frameToken = frameToken;
    this.frameObjects = objects;
    const previousTransforms = this.sweptMotion ? this.transformValues()?.slice() : undefined;
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
    if (this.sweptMotion) this.updateMotion(topologyChanged || changedGeometries.size > 0
      ? undefined : previousTransforms);
    this.initialized = true;
  }

  /** Relative-motion sweep against rigid walls. Ordinary queryCapsule remains a current-pose query. */
  queryMovingCapsule(start: Node<'vec3'>, end: Node<'vec3'>, radius: Node<'float'>): Node {
    if (!this.movingQuery) throw new Error('Enable sweptMotion and update collision geometry before querying motion.');
    const query = (CapsuleQuery(start, end, radius) as unknown as Node<'vec3'>).toVar();
    const hit = (this.movingQuery(query) as unknown as Node<'vec3'>).toVar();
    If(hit.get('found') as Node<'bool'>, () => {
      // Conservative rotational padding can meet the far side of a thin wall.
      // Resolve its current-pose overlap without changing the original contact side.
      for (let pass = 0; pass < 2; pass++) {
        const point = hit.get('capsulePoint') as Node<'vec3'>;
        const contact = this.queryCapsule(point, point, radius);
        If(contact.get('found') as Node<'bool'>, () => {
          const normal = hit.get('normal') as Node<'vec3'>;
          const contactNormal = contact.get('normal') as Node<'vec3'>;
          const distance = (contact.get('distanceSq') as Node<'float'>).sqrt();
          const aligned = normal.dot(contactNormal).greaterThanEqual(0);
          const direction = aligned.select(contactNormal, normal);
          const offset = aligned.select(radius.sub(distance).max(0), radius.add(distance));
          point.addAssign(direction.mul(offset));
          (hit.get('point') as Node<'vec3'>).assign(point.sub(normal.mul(radius)));
        });
      }
    });
    return hit;
  }

  private transformValues(): Float32Array | undefined {
    const array = this.data?.storage.transforms?.proxyNode?.value?.array;
    return array ? new Float32Array(array.buffer, array.byteOffset, array.byteLength / 4) : undefined;
  }

  private updateMotion(previous?: Float32Array): void {
    const current = this.transformValues();
    if (!current || !this.data) return;
    const stride = this.data.structs.transform.getLength();
    const count = current.length / stride;
    if (this.motionAttribute?.count !== count * 9) {
      this.motionAttribute?.dispose();
      this.motionAttribute = new StorageBufferAttribute(new Float32Array(count * 36), 4);
      this.movingQuery = capsuleBVHCollisionNode(this.data as unknown as Parameters<
        typeof capsuleBVHCollisionNode
      >[0], { history: storage(this.motionAttribute, 'vec4', count * 9), padding: this.motionPadding });
      this._motionVersion++;
    }
    const history = this.motionAttribute.array as Float32Array;
    const old = previous?.length === current.length ? previous : current;
    const a = new THREE.Matrix4(), b = new THREE.Matrix4();
    const positionA = new THREE.Vector3(), positionB = new THREE.Vector3();
    const rotationA = new THREE.Quaternion(), rotationB = new THREE.Quaternion();
    const scaleA = new THREE.Vector3(), scaleB = new THREE.Vector3();
    let geometryRadius = 0;
    this.tracked.forEach(({ geometry }) => {
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      const sphere = geometry.boundingSphere!;
      geometryRadius = Math.max(geometryRadius, sphere.center.length() + sphere.radius);
    });
    let padding = 0;
    for (let i = 0; i < count; i++) {
      const offset = i * stride;
      history.set(old.subarray(offset, offset + 32), i * 36);
      history[i * 36 + 32] = 0;
      if (old.subarray(offset, offset + 16).every((value, index) => value === current[offset + index])) continue;
      a.fromArray(old, offset).decompose(positionA, rotationA, scaleA);
      b.fromArray(current, offset).decompose(positionB, rotationB, scaleB);
      const angle = rotationA.angleTo(rotationB);
      const radius = geometryRadius * Math.max(scaleA.length(), scaleB.length());
      // Bound the rotating path's deviation from its relative-motion chord.
      const sagitta = radius * (1 - Math.cos(angle / 2));
      history[i * 36 + 32] = sagitta;
      padding = Math.max(padding, positionA.distanceTo(positionB) + 2 * radius * Math.sin(angle / 2)
        + geometryRadius * scaleA.distanceTo(scaleB));
    }
    if (padding > 0 || this.motionPadding.value > 0 || !previous) this.motionAttribute.needsUpdate = true;
    this.motionPadding.value = padding;
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
    this.motionAttribute?.dispose();
    this.motionAttribute = undefined;
    this.movingQuery = undefined;
    this.motionPadding.value = 0;
    this.frameToken = undefined;
    this._motionVersion++;
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
