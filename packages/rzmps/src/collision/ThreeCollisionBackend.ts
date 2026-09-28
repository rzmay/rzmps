import * as THREE from 'three';
import { Octree } from 'three/examples/jsm/math/Octree.js';
import { Capsule } from 'three/examples/jsm/math/Capsule.js';

import type {
  ICollisionBackend,
  CollisionHit,
  CollisionQuery,
} from '../interfaces/ICollisionBackend';
import ParticleSystem from '../ParticleSystem';
import { TRAIL_RENDERER_USER_DATA_KEY } from '../renderers/TrailRenderer';
import { SPRITE_RENDERER_USER_DATA_KEY } from '../renderers/SpriteRenderer';
import {
  flattenThreeOctree,
  type FlattenedOctree,
} from '../helpers/octreeFlattener';

export interface ThreeCollisionBackendOptions {
  world?: THREE.Object3D;
  staticObjects?: THREE.Object3D[];
  dynamicObjects?: THREE.Object3D[];

  staticAfter?: number;
  timeQuality?: number;
  refreshQuality?: number;
  respectMaterialSide?: boolean;
  maxLevel?: number | null;
  trianglesPerLeaf?: number | null;
  gpuCollision?: boolean;

  objectFilter?: (object: THREE.Object3D) => boolean;
  staticObjectFilter?: (object: THREE.Object3D) => boolean;
  dynamicObjectFilter?: (object: THREE.Object3D) => boolean;
}

enum Classification {
  Static,
  Dynamic,
  Auto,
}

type TrackedObject = {
  object: THREE.Mesh;
  classification: Classification;
  dynamic: boolean;
  matrixWorld: THREE.Matrix4;
  lastMovedAt: number;
};

type MembershipChanges = {
  staticChanged: boolean;
  dynamicChanged: boolean;
};

class ThreeCollisionBackend implements ICollisionBackend {
  staticOctree = new Octree();
  dynamicOctree = new Octree();

  world?: THREE.Object3D;

  staticObjects?: THREE.Object3D[];
  dynamicObjects?: THREE.Object3D[];

  objectFilter?: (object: THREE.Object3D) => boolean;
  staticObjectFilter?: (object: THREE.Object3D) => boolean;
  dynamicObjectFilter?: (object: THREE.Object3D) => boolean;

  staticAfter: number;
  timeQuality: number;
  refreshQuality: number;
  respectMaterialSide: boolean;
  maxLevel: number | null;
  trianglesPerLeaf: number | null;
  gpuCollision: boolean;

  flattenedStaticOctree?: FlattenedOctree;
  flattenedDynamicOctree?: FlattenedOctree;

  private trackedObjects = new Map<string, TrackedObject>();

  private elapsedTime = 0;
  private dynamicUpdateAccumulator = 0;
  private refreshAccumulator = 0;
  private gpuProcessingActive = false;

  constructor(options: ThreeCollisionBackendOptions = {}) {
    this.world = options.world;

    this.staticObjects = options.staticObjects;
    this.dynamicObjects = options.dynamicObjects;

    this.objectFilter = options.objectFilter;
    this.staticObjectFilter = options.staticObjectFilter;
    this.dynamicObjectFilter = options.dynamicObjectFilter;

    this.staticAfter = options.staticAfter ?? 2;
    this.respectMaterialSide = options.respectMaterialSide ?? true;
    this.maxLevel = options.maxLevel ?? null;
    this.trianglesPerLeaf = options.trianglesPerLeaf ?? null;
    this.gpuCollision = options.gpuCollision ?? true;

    this.timeQuality = THREE.MathUtils.clamp(
      options.timeQuality ?? 1,
      Number.EPSILON,
      1,
    );

    this.refreshQuality = THREE.MathUtils.clamp(
      options.refreshQuality ?? options.timeQuality ?? 1,
      Number.EPSILON,
      1,
    );

    this.initialize();
  }

  setGPUProcessingActive(active: boolean): void {
    if (this.gpuProcessingActive === active) return;

    this.gpuProcessingActive = active;
    this.rebuildStaticOctree();
    this.rebuildDynamicOctree();
  }

  update(deltaTime: number): void {
    this.elapsedTime += deltaTime;

    let staticMembershipChanged = false;
    let dynamicMembershipChanged = false;

    this.refreshAccumulator += this.refreshQuality;

    if (this.refreshAccumulator >= 1) {
      this.refreshAccumulator -= 1;

      const changes = this.refreshObjects();

      staticMembershipChanged ||= changes.staticChanged;
      dynamicMembershipChanged ||= changes.dynamicChanged;
    }

    for (const tracked of this.trackedObjects.values()) {
      tracked.object.updateWorldMatrix(true, false);

      if (tracked.classification !== Classification.Auto) continue;

      const moved = this.matrixChanged(
        tracked.matrixWorld,
        tracked.object.matrixWorld,
      );

      if (moved) {
        tracked.matrixWorld.copy(tracked.object.matrixWorld);
        tracked.lastMovedAt = this.elapsedTime;

        if (!tracked.dynamic) {
          tracked.dynamic = true;
          staticMembershipChanged = true;
          dynamicMembershipChanged = true;
        }
      }
      else if (
        tracked.dynamic
        && this.elapsedTime - tracked.lastMovedAt >= this.staticAfter
      ) {
        tracked.dynamic = false;
        staticMembershipChanged = true;
        dynamicMembershipChanged = true;
      }
    }

    if (staticMembershipChanged) {
      this.rebuildStaticOctree();
    }

    if (dynamicMembershipChanged) {
      this.rebuildDynamicOctree();
      this.dynamicUpdateAccumulator = 0;
      return;
    }

    this.dynamicUpdateAccumulator += this.timeQuality;

    if (this.dynamicUpdateAccumulator >= 1) {
      this.dynamicUpdateAccumulator -= 1;
      this.rebuildDynamicOctree();
    }
  }

  collide(query: CollisionQuery): CollisionHit | null {
    const capsule = new Capsule(
      query.start.clone(),
      query.end.clone(),
      Math.max(query.radius, Number.EPSILON),
    );

    const staticHit = this.staticOctree.capsuleIntersect(capsule);
    const dynamicHit = this.dynamicOctree.capsuleIntersect(capsule);

    if (!staticHit && !dynamicHit) return null;

    const collisionVector = new THREE.Vector3();

    if (staticHit) {
      collisionVector.addScaledVector(
        staticHit.normal,
        staticHit.depth,
      );
    }

    if (dynamicHit) {
      collisionVector.addScaledVector(
        dynamicHit.normal,
        dynamicHit.depth,
      );
    }

    if (collisionVector.lengthSq() === 0) return null;

    const normal = collisionVector.clone().normalize();

    const position = query.end
      .clone()
      .add(collisionVector);

    const point = position
      .clone()
      .addScaledVector(normal, -query.radius);

    const impulse = normal
      .clone()
      .multiplyScalar(query.particle.mass)
      .multiplyScalar(Math.max(0, -query.velocity.dot(normal)));

    return {
      point,
      normal,
      position,
      impulse,
    };
  }

  private initialize(): void {
    this.refreshObjects();

    this.rebuildStaticOctree();
    this.rebuildDynamicOctree();

    this.dynamicUpdateAccumulator = 0;
    this.refreshAccumulator = 0;
  }

  private refreshObjects(): MembershipChanges {
    const previous = this.trackedObjects;
    const next = new Map<string, TrackedObject>();

    if (this.hasExplicitLists()) {
      this.collectExplicitObjects(next, previous);
    }
    else if (this.world) {
      this.collectWorldObjects(next, previous);
    }

    let staticChanged = false;
    let dynamicChanged = false;

    const ids = new Set([
      ...previous.keys(),
      ...next.keys(),
    ]);

    for (const id of ids) {
      const before = previous.get(id);
      const after = next.get(id);

      if (!before && after) {
        if (after.dynamic) dynamicChanged = true;
        else staticChanged = true;

        continue;
      }

      if (before && !after) {
        if (before.dynamic) dynamicChanged = true;
        else staticChanged = true;

        continue;
      }

      if (!before || !after) continue;

      if (before.dynamic !== after.dynamic) {
        staticChanged = true;
        dynamicChanged = true;
      }
    }

    this.trackedObjects = next;

    return {
      staticChanged,
      dynamicChanged,
    };
  }

  private hasExplicitLists(): boolean {
    return this.staticObjects !== undefined
      || this.dynamicObjects !== undefined;
  }

  private collectExplicitObjects(
    target: Map<string, TrackedObject>,
    previous: Map<string, TrackedObject>,
  ): void {
    this.collectRoots(
      this.staticObjects ?? [],
      (mesh) => {
        this.trackObject(
          target,
          previous,
          mesh,
          Classification.Static,
        );
      },
    );

    this.collectRoots(
      this.dynamicObjects ?? [],
      (mesh) => {
        this.trackObject(
          target,
          previous,
          mesh,
          Classification.Dynamic,
        );
      },
    );
  }

  private collectWorldObjects(
    target: Map<string, TrackedObject>,
    previous: Map<string, TrackedObject>,
  ): void {
    if (!this.world) return;

    this.world.updateWorldMatrix(true, true);

    this.world.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      if (object instanceof ParticleSystem) return;

      // Ideally, we ignore all helpers here.
      // Good god, what a mess
      if (object instanceof THREE.BoxHelper) return;
      if (object instanceof THREE.Box3Helper) return;
      if (object instanceof THREE.AxesHelper) return;
      if (object instanceof THREE.GridHelper) return;
      if (object instanceof THREE.ArrowHelper) return;
      if (object instanceof THREE.PlaneHelper) return;
      if (object instanceof THREE.CameraHelper) return;
      if (object instanceof THREE.SkeletonHelper) return;
      if (object instanceof THREE.PolarGridHelper) return;
      if (object instanceof THREE.DirectionalLightHelper) return;
      if (object instanceof THREE.HemisphereLightHelper) return;
      if (object instanceof THREE.SpotLightHelper) return;
      if (object instanceof THREE.PointLightHelper) return;

      // Check for renderer object
      if (object.userData[TRAIL_RENDERER_USER_DATA_KEY]) return;
      if (object.userData[SPRITE_RENDERER_USER_DATA_KEY]) return;

      if (
        this.objectFilter
        && !this.objectFilter(object)
      ) {
        return;
      }

      const isDynamic =
        this.dynamicObjectFilter?.(object)
        ?? false;

      const isStatic =
        this.staticObjectFilter?.(object)
        ?? false;

      if (isDynamic) {
        this.trackObject(
          target,
          previous,
          object,
          Classification.Dynamic,
        );

        return;
      }

      if (isStatic) {
        this.trackObject(
          target,
          previous,
          object,
          Classification.Static,
        );

        return;
      }

      this.trackObject(
        target,
        previous,
        object,
        Classification.Auto,
      );
    });
  }

  private collectRoots(
    roots: THREE.Object3D[],
    callback: (mesh: THREE.Mesh) => void,
  ): void {
    roots.forEach((root) => {
      root.updateWorldMatrix(true, true);

      root.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;

        if (
          this.objectFilter
          && !this.objectFilter(object)
        ) {
          return;
        }

        callback(object);
      });
    });
  }

  private trackObject(
    target: Map<string, TrackedObject>,
    previous: Map<string, TrackedObject>,
    object: THREE.Mesh,
    classification: Classification,
  ): void {
    const existing = target.get(object.uuid);

    if (
      existing?.classification === Classification.Dynamic
    ) {
      return;
    }

    const previousTracked =
      previous.get(object.uuid);

    object.updateWorldMatrix(true, false);

    if (
      classification === Classification.Auto
      && previousTracked?.classification === Classification.Auto
    ) {
      target.set(object.uuid, {
        object,
        classification,
        dynamic: previousTracked.dynamic,
        matrixWorld: previousTracked.matrixWorld.clone(),
        lastMovedAt: previousTracked.lastMovedAt,
      });

      return;
    }

    target.set(object.uuid, {
      object,
      classification,
      dynamic: classification === Classification.Dynamic,
      matrixWorld: object.matrixWorld.clone(),
      lastMovedAt: this.elapsedTime,
    });
  }

  private rebuildStaticOctree(): void {
    const objects = Array.from(
      this.trackedObjects.values(),
    )
      .filter((tracked) => !tracked.dynamic)
      .map((tracked) => tracked.object);

    this.staticOctree = this.buildOctree(objects);
    this.flattenedStaticOctree = this.shouldFlattenOctree(this.staticOctree)
      ? flattenThreeOctree(this.staticOctree as Parameters<typeof flattenThreeOctree>[0])
      : undefined;
  }

  private rebuildDynamicOctree(): void {
    const objects = Array.from(
      this.trackedObjects.values(),
    )
      .filter((tracked) => tracked.dynamic)
      .map((tracked) => tracked.object);

    this.dynamicOctree = this.buildOctree(objects);
    this.flattenedDynamicOctree = this.shouldFlattenOctree(this.dynamicOctree)
      ? flattenThreeOctree(this.dynamicOctree as Parameters<typeof flattenThreeOctree>[0])
      : undefined;
  }

  private buildOctree(
    objects: THREE.Mesh[],
  ): Octree {
    const octree = new Octree();
    const settings = this.getOctreeSettings();
    if (settings.maxLevel !== null) octree.maxLevel = settings.maxLevel;
    if (settings.trianglesPerLeaf !== null) octree.trianglesPerLeaf = settings.trianglesPerLeaf;

    let triangleCount = 0;

    objects.forEach((object) => {
      triangleCount += this.addMeshToOctree(
        octree,
        object,
      );
    });

    if (triangleCount > 0) {
      octree.build();
    }

    return octree;
  }

  private getOctreeSettings(): { maxLevel: number | null; trianglesPerLeaf: number | null } {
    if (this.shouldUseGPUFriendlyDefaults()) {
      return {
        maxLevel: this.maxLevel ?? 8,
        trianglesPerLeaf: this.trianglesPerLeaf ?? 32,
      };
    }

    return {
      maxLevel: this.maxLevel,
      trianglesPerLeaf: this.trianglesPerLeaf,
    };
  }

  private shouldUseGPUFriendlyDefaults(): boolean {
    return this.gpuCollision && this.gpuProcessingActive;
  }

  private shouldFlattenOctree(octree: Octree): boolean {
    return this.shouldUseGPUFriendlyDefaults() && Boolean(octree.box);
  }

  private addMeshToOctree(
    octree: Octree,
    object: THREE.Mesh,
  ): number {
    object.updateWorldMatrix(true, false);

    const sourceGeometry = object.geometry;

    if (!(sourceGeometry instanceof THREE.BufferGeometry)) {
      return 0;
    }

    let geometry = sourceGeometry;
    let temporaryGeometry: THREE.BufferGeometry | undefined;

    if (sourceGeometry.index !== null) {
      temporaryGeometry = sourceGeometry.toNonIndexed();
      geometry = temporaryGeometry;
    }

    const position = geometry.getAttribute('position');

    if (!position) {
      temporaryGeometry?.dispose();
      return 0;
    }

    let count = 0;

    for (let i = 0; i + 2 < position.count; i += 3) {
      const a = new THREE.Vector3()
        .fromBufferAttribute(position, i)
        .applyMatrix4(object.matrixWorld);

      const b = new THREE.Vector3()
        .fromBufferAttribute(position, i + 1)
        .applyMatrix4(object.matrixWorld);

      const c = new THREE.Vector3()
        .fromBufferAttribute(position, i + 2)
        .applyMatrix4(object.matrixWorld);

      count += this.addTriangleForMaterialSide(
        octree,
        object,
        geometry,
        i,
        a,
        b,
        c,
      );
    }

    temporaryGeometry?.dispose();

    return count;
  }

  private addTriangleForMaterialSide(
    octree: Octree,
    object: THREE.Mesh,
    geometry: THREE.BufferGeometry,
    vertexStart: number,
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
  ): number {
    const side = this.respectMaterialSide
      ? this.getMaterialSide(object, geometry, vertexStart)
      : THREE.FrontSide;

    if (side === THREE.BackSide) {
      octree.addTriangle(new THREE.Triangle(c, b, a));
      return 1;
    }

    octree.addTriangle(new THREE.Triangle(a, b, c));

    if (side === THREE.DoubleSide) {
      octree.addTriangle(new THREE.Triangle(c, b, a));
      return 2;
    }

    return 1;
  }

  private getMaterialSide(
    object: THREE.Mesh,
    geometry: THREE.BufferGeometry,
    vertexStart: number,
  ): THREE.Side {
    const material = object.material;

    if (!Array.isArray(material)) {
      return material?.side ?? THREE.FrontSide;
    }

    const materialIndex = this.getMaterialIndexForVertex(
      geometry,
      vertexStart,
    );

    return material[materialIndex]?.side ?? THREE.FrontSide;
  }

  private getMaterialIndexForVertex(
    geometry: THREE.BufferGeometry,
    vertexStart: number,
  ): number {
    const group = geometry.groups.find(({ start, count }) => (
      vertexStart >= start
      && vertexStart < start + count
    ));

    return group?.materialIndex ?? 0;
  }

  private matrixChanged(
    previous: THREE.Matrix4,
    current: THREE.Matrix4,
  ): boolean {
    const a = previous.elements;
    const b = current.elements;

    for (let i = 0; i < 16; i++) {
      if (Math.abs(a[i] - b[i]) > 1e-6) {
        return true;
      }
    }

    return false;
  }
}

export default ThreeCollisionBackend;
