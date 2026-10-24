import * as THREE from 'three';
import { MeshBVH, type MeshBVHOptions } from 'three-mesh-bvh';
import tagsIntersect from '../helpers/tagsIntersect';
import type { Tag } from '../types/Tag';
import type Particle from '../Particle';
import type ParticleSystem from '../ParticleSystem';
import getParticleWorldPosition from '../helpers/getParticleWorldPosition';
import SpatialEffect, {
  type SpatialEffectModifier,
  type SpatialEffectOptions,
} from '../SpatialEffect';
import type { Node } from 'three/webgpu';
import { If, texture3D, vec3, vec4 } from 'three/tsl';

// No custom test allowed here
export interface BoidAffectorOptions extends Omit<SpatialEffectOptions, 'test'> {
  weight: number;
  distance: number;
  range: number;
  bvhOptions: MeshBVHOptions;
}

enum Weight {
  Target = 1,
  Obstacle = -1,
}

/** Scene-space flocking target or obstacle, collected by Boids modules and filtered by tags. */
class BoidAffector extends SpatialEffect {
  // Decides default range for boid affectors
  static RANGE_INFLUENCE_THRESHOLD = 1e-6;

  static readonly Weight = Weight;

  static Box(
    modify: SpatialEffectModifier | null,
    options: Partial<BoidAffectorOptions> | null,
    ...args: ConstructorParameters<typeof THREE.BoxGeometry>
  ): BoidAffector;
  static Box(
    options?: Partial<BoidAffectorOptions>,
    ...args: ConstructorParameters<typeof THREE.BoxGeometry>
  ): BoidAffector;
  static Box(
    ...args: ConstructorParameters<typeof THREE.BoxGeometry>
  ): BoidAffector;
  static Box(
    first?: unknown,
    second?: unknown,
    ...args: unknown[]
  ): BoidAffector {
    const { options, geometryArgs } = BoidAffector.resolveFactoryArgs<
      ConstructorParameters<typeof THREE.BoxGeometry>
    >(first, second, args);
    return new BoidAffector({ ...options, geometry: new THREE.BoxGeometry(...geometryArgs) });
  }

  static Sphere(
    modify: SpatialEffectModifier | null,
    options: Partial<BoidAffectorOptions> | null,
    ...args: ConstructorParameters<typeof THREE.SphereGeometry>
  ): BoidAffector;
  static Sphere(
    options?: Partial<BoidAffectorOptions>,
    ...args: ConstructorParameters<typeof THREE.SphereGeometry>
  ): BoidAffector;
  static Sphere(
    ...args: ConstructorParameters<typeof THREE.SphereGeometry>
  ): BoidAffector;
  static Sphere(
    first?: unknown,
    second?: unknown,
    ...args: unknown[]
  ): BoidAffector {
    const resolved = BoidAffector.resolveFactoryArgs<
      ConstructorParameters<typeof THREE.SphereGeometry>
    >(first, second, args);
    return new BoidAffector({
      ...resolved.options,
      geometry: new THREE.SphereGeometry(...resolved.geometryArgs),
    });
  }

  static Cone(
    modify: SpatialEffectModifier | null,
    options: Partial<BoidAffectorOptions> | null,
    ...args: ConstructorParameters<typeof THREE.ConeGeometry>
  ): BoidAffector;
  static Cone(
    options?: Partial<BoidAffectorOptions>,
    ...args: ConstructorParameters<typeof THREE.ConeGeometry>
  ): BoidAffector;
  static Cone(
    ...args: ConstructorParameters<typeof THREE.ConeGeometry>
  ): BoidAffector;
  static Cone(
    first?: unknown,
    second?: unknown,
    ...args: unknown[]
  ): BoidAffector {
    const resolved = BoidAffector.resolveFactoryArgs<
      ConstructorParameters<typeof THREE.ConeGeometry>
    >(first, second, args);
    return new BoidAffector({
      ...resolved.options,
      geometry: new THREE.ConeGeometry(...resolved.geometryArgs),
    });
  }

  static Torus(
    modify: SpatialEffectModifier | null,
    options: Partial<BoidAffectorOptions> | null,
    ...args: ConstructorParameters<typeof THREE.TorusGeometry>
  ): BoidAffector;
  static Torus(
    options?: Partial<BoidAffectorOptions>,
    ...args: ConstructorParameters<typeof THREE.TorusGeometry>
  ): BoidAffector;
  static Torus(
    ...args: ConstructorParameters<typeof THREE.TorusGeometry>
  ): BoidAffector;
  static Torus(
    first?: unknown,
    second?: unknown,
    ...args: unknown[]
  ): BoidAffector {
    const resolved = BoidAffector.resolveFactoryArgs<
      ConstructorParameters<typeof THREE.TorusGeometry>
    >(first, second, args);
    return new BoidAffector({
      ...resolved.options,
      geometry: new THREE.TorusGeometry(...resolved.geometryArgs),
    });
  }

  private static resolveFactoryArgs<T extends unknown[]>(
    first: unknown,
    second: unknown,
    rest: unknown[],
  ): { options: Partial<BoidAffectorOptions>; geometryArgs: T } {
    if (typeof first === 'function' || first === null) {
      return {
        options: (second && typeof second === 'object' && !Array.isArray(second)
          ? second as Partial<BoidAffectorOptions>
          : {}) ?? {},
        geometryArgs: rest as T,
      };
    }

    return {
      options: first && typeof first === 'object' && !Array.isArray(first)
        ? first as Partial<BoidAffectorOptions>
        : {},
      geometryArgs: (
        first && typeof first === 'object' && !Array.isArray(first)
          ? (second === undefined ? rest : [second, ...rest])
          : [first, second, ...rest].filter((value) => value !== undefined)
      ) as T,
    };
  }

  weight: number;
  distance: number;
  range: number;
  bvhOptions?: MeshBVHOptions;

  private _affectorBVH?: MeshBVH;
  private _affectorBVHGeometry?: THREE.BufferGeometry;
  private localSamplePoint = new THREE.Vector3();
  private worldSamplePoint = new THREE.Vector3();
  private influenceSamplePoint = new THREE.Vector3();
  private influenceLocalPosition = new THREE.Vector3();
  private particleWorldPosition = new THREE.Vector3();
  private affectorWorldPosition = new THREE.Vector3();
  private _gpuSurfaceTexture?: THREE.Data3DTexture;
  private _gpuSurfaceGeometry?: THREE.BufferGeometry;
  private _gpuSurfaceResolution = 0;
  private readonly _gpuSurfaceMin = new THREE.Vector3();
  private readonly _gpuSurfaceSize = new THREE.Vector3(1, 1, 1);
  private readonly _gpuSample = new THREE.Vector3();
  private readonly _gpuTriangleA = new THREE.Vector3();
  private readonly _gpuTriangleB = new THREE.Vector3();
  private readonly _gpuTriangleC = new THREE.Vector3();
  private readonly _gpuTriangleNormal = new THREE.Vector3();

  get bvh(): MeshBVH | undefined {
    if (!this.geometry) return undefined;

    if (!this._affectorBVH || this._affectorBVHGeometry !== this.geometry) {
      this._affectorBVH = new MeshBVH(this.geometry, this.bvhOptions);
      this._affectorBVHGeometry = this.geometry;
    }

    return this._affectorBVH;
  }

  constructor(options: Partial<BoidAffectorOptions> = {}) {
    super(null, {
      ...options,
      feather: 0,
      // Boids consumes this effect directly. The no-op keeps the effect GPU-compatible
      // when ParticleSystem also encounters it in the scene spatial-effect list.
      modifyGPU: () => {},
    });

    this.weight = options.weight ?? Weight.Target;
    this.distance = options.distance ?? 1;
    this.range = options.range ?? this.getDefaultRange();
    this.bvhOptions = options.bvhOptions;
  }

  matchesTags(tags?: Tag[]): boolean {
    return !this.tags?.length || tagsIntersect(this.tags, tags ?? []);
  }

  override test(particle: Particle, particleSystem: ParticleSystem): boolean {
    if (!this.matchesTags(particle.tags)) return false;
    if (!this.condition(particle)) return false;
    getParticleWorldPosition(particle, particleSystem, this.particleWorldPosition);
    if (!this.isWithinRange(this.particleWorldPosition)) return false;

    return true;
  }

  samplePoint(
    position: THREE.Vector3,
    target = new THREE.Vector3(),
    updateMatrix = true,
  ): THREE.Vector3 {
    if (updateMatrix) this.updateWorldMatrix(true, false);

    const bvh = this.bvh;

    if (!bvh) {
      return this.getWorldPosition(target);
    }

    this.localSamplePoint.copy(position);
    this.worldToLocal(this.localSamplePoint);

    const hit = bvh.closestPointToPoint(this.localSamplePoint);

    if (!hit) {
      return this.getWorldPosition(target);
    }

    this.worldSamplePoint.copy(hit.point);
    this.localToWorld(this.worldSamplePoint);

    return target.copy(this.worldSamplePoint);
  }

  getInfluenceDirection(
    position: THREE.Vector3,
    target = new THREE.Vector3(),
    updateMatrix = true,
  ): THREE.Vector3 {
    this.samplePoint(position, this.influenceSamplePoint, updateMatrix);
    target.copy(position).sub(this.influenceSamplePoint);

    if (!this.geometry || target.lengthSq() === 0) return target;

    this.influenceLocalPosition.copy(position);
    this.worldToLocal(this.influenceLocalPosition);

    const contains = this.containsWorldPosition(position, updateMatrix);
    const inside = this.inverted ? !contains : contains;
    if (inside !== this.inverted) target.multiplyScalar(-1);

    return target;
  }

  /** Returns the closest world-space surface point and approximate solid containment on GPU. */
  getGPUWorldPosition(): Node<'vec3'> {
    return transformPointGPU(vec3(0), this.getGPULocalToWorldMatrix());
  }

  samplePointGPU(worldPosition: Node<'vec3'>): {
    point: Node<'vec3'>;
    inside: Node<'bool'>;
  } {
    const local = transformPointGPU(worldPosition, this.getGPUWorldToLocalMatrix());
    const bounds = this.geometry?.boundingBox;
    if (!bounds) {
      return {
        point: transformPointGPU(vec3(0), this.getGPULocalToWorldMatrix()),
        inside: local.lengthSq().lessThanEqual(0),
      };
    }

    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    let closestLocal: Node<'vec3'>;
    let inside: Node<'bool'>;

    if (this.geometry?.type === 'SphereGeometry' || this.geometry?.type === 'IcosahedronGeometry') {
      const radius = Math.max(size.x, size.y, size.z) * 0.5;
      const offset = vec3(local.sub(vec3(center)));
      const distance = offset.length();
      closestLocal = vec3(center).add(
        distance.greaterThan(Number.EPSILON).select(
          offset.div(distance).mul(radius),
          vec3(radius, 0, 0),
        ),
      );
      inside = distance.lessThanEqual(radius);
    } else if (this.geometry?.type === 'BoxGeometry') {
      const half = size.multiplyScalar(0.5);
      const centered = vec3(local.sub(vec3(center)));
      const q = vec3(centered.abs().sub(vec3(half)));
      const boxPoint = vec3(local.clamp(vec3(bounds.min), vec3(bounds.max)))
        .toVar('boidBoxSurfacePoint');
      inside = q.x.max(q.y).max(q.z).lessThanEqual(0);
      If(inside, () => {
        If(q.x.greaterThanEqual(q.y).and(q.x.greaterThanEqual(q.z)), () => {
          boxPoint.x.assign(centered.x.greaterThanEqual(0).select(bounds.max.x, bounds.min.x));
        }).Else(() => {
          If(q.y.greaterThanEqual(q.z), () => {
            boxPoint.y.assign(centered.y.greaterThanEqual(0).select(bounds.max.y, bounds.min.y));
          }).Else(() => {
            boxPoint.z.assign(centered.z.greaterThanEqual(0).select(bounds.max.z, bounds.min.z));
          });
        });
      });
      closestLocal = boxPoint;
    } else {
      this.ensureGPUSurfaceField();
      if (!this._gpuSurfaceTexture) {
        closestLocal = vec3(center);
        inside = local.lengthSq().lessThanEqual(0);
      } else {
        const uv = local.sub(vec3(this._gpuSurfaceMin))
          .div(vec3(this._gpuSurfaceSize))
          .clamp(0, 1);
        const sample = texture3D(this._gpuSurfaceTexture, uv);
        const outsideBounds = local.x.lessThan(bounds.min.x)
          .or(local.y.lessThan(bounds.min.y))
          .or(local.z.lessThan(bounds.min.z))
          .or(local.x.greaterThan(bounds.max.x))
          .or(local.y.greaterThan(bounds.max.y))
          .or(local.z.greaterThan(bounds.max.z));
        closestLocal = sample.xyz;
        inside = outsideBounds.not().and(sample.w.greaterThan(0.5));
      }
    }

    return {
      point: transformPointGPU(closestLocal, this.getGPULocalToWorldMatrix()),
      inside,
    };
  }

  private ensureGPUSurfaceField(): void {
    const geometry = this.geometry;
    const resolution = this.bakedFieldResolution;
    if (
      !geometry
      || (
        this._gpuSurfaceTexture
        && this._gpuSurfaceGeometry === geometry
        && this._gpuSurfaceResolution === resolution
      )
    ) return;

    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const bounds = geometry.boundingBox;
    const position = geometry.getAttribute('position');
    if (!bounds || !position) return;

    this._gpuSurfaceMin.copy(bounds.min);
    bounds.getSize(this._gpuSurfaceSize)
      .max(new THREE.Vector3(Number.EPSILON, Number.EPSILON, Number.EPSILON));
    const data = new Float32Array(resolution ** 3 * 4);
    const bvh = this.bvh;
    if (!bvh) return;

    let offset = 0;
    for (let z = 0; z < resolution; z += 1) {
      for (let y = 0; y < resolution; y += 1) {
        for (let x = 0; x < resolution; x += 1) {
          this._gpuSample.set(
            bounds.min.x + this._gpuSurfaceSize.x * x / (resolution - 1),
            bounds.min.y + this._gpuSurfaceSize.y * y / (resolution - 1),
            bounds.min.z + this._gpuSurfaceSize.z * z / (resolution - 1),
          );
          const hit = bvh.closestPointToPoint(this._gpuSample);
          const point = hit?.point ?? this._gpuSample;
          let isInside = false;
          if (hit && hit.faceIndex !== undefined) {
            const triangleOffset = hit.faceIndex * 3;
            const index = geometry.index;
            const a = index?.getX(triangleOffset) ?? triangleOffset;
            const b = index?.getX(triangleOffset + 1) ?? triangleOffset + 1;
            const c = index?.getX(triangleOffset + 2) ?? triangleOffset + 2;
            this._gpuTriangleA.fromBufferAttribute(position, a);
            this._gpuTriangleB.fromBufferAttribute(position, b);
            this._gpuTriangleC.fromBufferAttribute(position, c);
            this._gpuTriangleNormal
              .subVectors(this._gpuTriangleB, this._gpuTriangleA)
              .cross(this._gpuTriangleC.clone().sub(this._gpuTriangleA));
            isInside = this._gpuSample.clone().sub(point).dot(this._gpuTriangleNormal) < 0;
          }
          data[offset] = point.x;
          data[offset + 1] = point.y;
          data[offset + 2] = point.z;
          data[offset + 3] = isInside ? 1 : 0;
          offset += 4;
        }
      }
    }

    const texture = new THREE.Data3DTexture(data, resolution, resolution, resolution);
    texture.format = THREE.RGBAFormat;
    texture.type = THREE.FloatType;
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.wrapR = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    this._gpuSurfaceTexture?.dispose();
    this._gpuSurfaceTexture = texture;
    this._gpuSurfaceGeometry = geometry;
    this._gpuSurfaceResolution = resolution;
  }

  private isWithinRange(position: THREE.Vector3): boolean {
    this.affectorWorldPosition.setFromMatrixPosition(this.matrixWorld);

    return position.distanceToSquared(this.affectorWorldPosition)
      <= this.range * this.range;
  }

  private getDefaultRange(): number {
    // Default range can be approximated from weight and bounding box
    const influenceRange = Math.sqrt(
      Math.abs(this.weight) / BoidAffector.RANGE_INFLUENCE_THRESHOLD,
    );

    if (!this.geometry) return influenceRange;

    this.geometry.computeBoundingBox();

    const box = this.geometry.boundingBox;
    if (!box) return influenceRange;

    const geometryRadius = Math.max(
      box.min.length(),
      box.max.length(),
    );

    return geometryRadius + influenceRange;
  }
}

function transformPointGPU(point: Node<'vec3'>, matrix: Node<'mat4'>): Node<'vec3'> {
  return matrix.mul(vec4(point, 1)).xyz as Node<'vec3'>;
}

export default BoidAffector;
