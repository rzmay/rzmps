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

export interface ThreeCollisionBackendOptions {
  world?: THREE.Object3D;
  staticObjects?: THREE.Object3D[];
  dynamicObjects?: THREE.Object3D[];

  staticAfter?: number;
  timeQuality?: number;
  refreshQuality?: number;

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

  private trackedObjects = new Map<string, TrackedObject>();

  private elapsedTime = 0;
  private dynamicUpdateAccumulator = 0;
  private refreshAccumulator = 0;

  constructor(options: ThreeCollisionBackendOptions = {}) {
    this.world = options.world;

    this.staticObjects = options.staticObjects;
    this.dynamicObjects = options.dynamicObjects;

    this.objectFilter = options.objectFilter;
    this.staticObjectFilter = options.staticObjectFilter;
    this.dynamicObjectFilter = options.dynamicObjectFilter;

    this.staticAfter = options.staticAfter ?? 2;

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
  }

  private rebuildDynamicOctree(): void {
    const objects = Array.from(
      this.trackedObjects.values(),
    )
      .filter((tracked) => tracked.dynamic)
      .map((tracked) => tracked.object);

    this.dynamicOctree = this.buildOctree(objects);
  }

  private buildOctree(
    objects: THREE.Mesh[],
  ): Octree {
    const octree = new Octree();

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

      octree.addTriangle(
        new THREE.Triangle(a, b, c),
      );

      count++;
    }

    temporaryGeometry?.dispose();

    return count;
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
