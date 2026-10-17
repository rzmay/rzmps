import * as THREE from 'three';
import type { Node } from 'three/webgpu';
// Use the focused entry point so unrelated WebGPU helper exports cannot collide.
// @ts-expect-error three-mesh-bvh does not publish declarations for deep imports.
import { BVHComputeData } from 'three-mesh-bvh/src/webgpu/BVHComputeData.js';
import type { CollisionQuery, ICollisionBackend } from '../interfaces/ICollisionBackend';
import ParticleSystem from '../ParticleSystem';
import { TRAIL_RENDERER_USER_DATA_KEY } from '../renderers/TrailRenderer';
import { SPRITE_RENDERER_USER_DATA_KEY } from '../renderers/SpriteRenderer';
import capsuleBVHCollisionNode, {
  CapsuleQuery,
} from './capsuleBVHCollisionNode';

export enum CollisionGeometryUpdatePolicy {
  Static = 'static',
  TransformDynamic = 'transform-dynamic',
  GeometryDynamic = 'geometry-dynamic',
  Auto = 'auto',
}

export interface ThreeGPUCollisionBackendOptions {
  world?: THREE.Object3D;
  staticObjects?: THREE.Object3D[];
  dynamicObjects?: THREE.Object3D[];
  geometryDynamicObjects?: THREE.Object3D[];
  objectFilter?: (object: THREE.Object3D) => boolean;
  staticObjectFilter?: (object: THREE.Object3D) => boolean;
  dynamicObjectFilter?: (object: THREE.Object3D) => boolean;
  geometryDynamicObjectFilter?: (object: THREE.Object3D) => boolean;
  updatePolicy?: CollisionGeometryUpdatePolicy;
}

export interface ThreeGPUCollisionBackendStats {
  objects: number;
  uniqueGeometries: number;
  fullBuilds: number;
  transformUpdates: number;
  geometryRefits: number;
  topologyRebuilds: number;
  estimatedUploadBytes: number;
}

type TrackedMesh = {
  mesh: THREE.Mesh;
  policy: CollisionGeometryUpdatePolicy;
  matrixWorld: THREE.Matrix4;
  geometry: THREE.BufferGeometry;
  positionVersion: number;
  positionCount: number;
  indexVersion: number;
  indexCount: number;
};

type BVHComputeDataRuntime = BVHComputeData & {
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
    estimatedUploadBytes: 0,
  };

  private tracked = new Map<string, TrackedMesh>();
  private invalidatedGeometry = new Set<string>();
  private data?: BVHComputeDataRuntime;
  private capsuleQuery?: ReturnType<typeof capsuleBVHCollisionNode>;
  private initialized = false;

  get hasGeometry(): boolean {
    return this.capsuleQuery !== undefined;
  }

  constructor(options: ThreeGPUCollisionBackendOptions = {}) {
    this.world = options.world;
    this.staticObjects = options.staticObjects;
    this.dynamicObjects = options.dynamicObjects;
    this.geometryDynamicObjects = options.geometryDynamicObjects;
    this.objectFilter = options.objectFilter;
    this.staticObjectFilter = options.staticObjectFilter;
    this.dynamicObjectFilter = options.dynamicObjectFilter;
    this.geometryDynamicObjectFilter = options.geometryDynamicObjectFilter;
    this.updatePolicy = options.updatePolicy ?? CollisionGeometryUpdatePolicy.Auto;
  }

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

  update(): void {
    const next = this.collectMeshes();
    let topologyChanged = !this.initialized || next.size !== this.tracked.size;
    let geometryChanged = false;
    let transformChanged = false;

    next.forEach((entry, uuid) => {
      const previous = this.tracked.get(uuid);
      if (!previous || previous.geometry !== entry.geometry) {
        topologyChanged = true;
        return;
      }

      const indexChanged = entry.indexCount !== previous.indexCount;
      const vertexCountChanged = entry.positionCount !== previous.positionCount;
      const topologyRevisionChanged = entry.indexVersion !== previous.indexVersion;
      if (indexChanged || vertexCountChanged || topologyRevisionChanged) {
        topologyChanged = true;
      } else if (
        (this.invalidatedGeometry.has(uuid) || (
          entry.policy === CollisionGeometryUpdatePolicy.GeometryDynamic
          || entry.policy === CollisionGeometryUpdatePolicy.Auto
        ))
        && (
          entry.positionVersion !== previous.positionVersion
          || this.invalidatedGeometry.has(uuid)
        )
      ) {
        geometryChanged = true;
        const boundsTree = (entry.geometry as THREE.BufferGeometry & {
          boundsTree?: { refit(): void };
        }).boundsTree;
        boundsTree?.refit();
      }

      if (
        entry.policy !== CollisionGeometryUpdatePolicy.Static
        && !entry.matrixWorld.equals(previous.matrixWorld)
      ) transformChanged = true;
    });

    this.tracked = next;
    this.invalidatedGeometry.clear();
    this.stats.objects = next.size;
    this.stats.uniqueGeometries = new Set(
      Array.from(next.values(), ({ geometry }) => geometry.uuid),
    ).size;

    if (next.size === 0) {
      this.disposeData();
      this.initialized = true;
      return;
    }

    if (topologyChanged || geometryChanged || !this.data) {
      this.rebuildData(topologyChanged, geometryChanged);
    } else if (transformChanged) {
      this.data.updateTransforms();
      this.stats.transformUpdates += 1;
      this.stats.estimatedUploadBytes += next.size * 36 * 4;
    }
    this.initialized = true;
  }

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

  destroy(): void {
    this.disposeData();
    this.tracked.clear();
    this.invalidatedGeometry.clear();
  }

  private rebuildData(topologyChanged: boolean, geometryChanged: boolean): void {
    this.disposeData();
    const meshes = Array.from(this.tracked.values(), ({ mesh }) => mesh);
    this.data = new BVHComputeData(meshes) as BVHComputeDataRuntime;
    this.data.update();
    this.capsuleQuery = capsuleBVHCollisionNode(this.data as unknown as Parameters<
      typeof capsuleBVHCollisionNode
    >[0]);
    this.stats.fullBuilds += 1;
    if (topologyChanged && this.initialized) this.stats.topologyRebuilds += 1;
    if (geometryChanged) this.stats.geometryRefits += 1;
    this.stats.estimatedUploadBytes += meshes.reduce((bytes, mesh) => {
      const geometry = mesh.geometry;
      const positions = geometry.getAttribute('position');
      const index = geometry.index;
      return bytes + (positions?.array.byteLength ?? 0) + (index?.array.byteLength ?? 0);
    }, 0);
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
        positionVersion: attributeVersion(position),
        positionCount: position.count,
        indexVersion: attributeVersion(index),
        indexCount: index?.count ?? position.count,
      });
    };
    const addRoot = (root: THREE.Object3D, policy: CollisionGeometryUpdatePolicy) => {
      root.updateWorldMatrix(true, true);
      root.traverse((object) => {
        if (object instanceof THREE.Mesh && !isIgnoredObject(object)) add(object, policy);
      });
    };

    this.staticObjects?.forEach((root) => addRoot(root, CollisionGeometryUpdatePolicy.Static));
    this.dynamicObjects?.forEach((root) => addRoot(root, CollisionGeometryUpdatePolicy.TransformDynamic));
    this.geometryDynamicObjects?.forEach((root) => addRoot(root, CollisionGeometryUpdatePolicy.GeometryDynamic));
    if (this.world) {
      this.world.updateWorldMatrix(true, true);
      this.world.traverse((object) => {
        if (!(object instanceof THREE.Mesh) || isIgnoredObject(object)) return;
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
}

function isIgnoredObject(object: THREE.Object3D): boolean {
  return object instanceof ParticleSystem
    || object instanceof THREE.BoxHelper
    || object instanceof THREE.Box3Helper
    || object instanceof THREE.AxesHelper
    || object instanceof THREE.GridHelper
    || object instanceof THREE.ArrowHelper
    || object instanceof THREE.PlaneHelper
    || object instanceof THREE.CameraHelper
    || object instanceof THREE.SkeletonHelper
    || object instanceof THREE.PolarGridHelper
    || object.userData[TRAIL_RENDERER_USER_DATA_KEY]
    || object.userData[SPRITE_RENDERER_USER_DATA_KEY];
}

function attributeVersion(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null | undefined): number {
  if (!attribute) return -1;
  return 'version' in attribute ? Number(attribute.version) : Number(attribute.data.version ?? 0);
}
