import { GeometryUpdatePolicy } from '../../enums/GeometryUpdatePolicy';
import FluidColliderField from './gpu/FluidColliderField';
import type { ParticleSpatialGridRenderer } from '../structures/ParticleSpatialGrid';
import * as THREE from 'three';
import type { Node } from 'three/webgpu';
import SpatialEffect, {
  type SpatialEffectModifier,
  type SpatialEffectOptions,
} from './SpatialEffect';
import type { GPUParticleLike, GPUParticleUpdateContext } from '../../simulation/gpu/Particle';

type BoxGeometryArgs = ConstructorParameters<typeof THREE.BoxGeometry>;
type SphereGeometryArgs = ConstructorParameters<typeof THREE.SphereGeometry>;

export type FluidColliderOptions = Partial<Omit<
  SpatialEffectOptions,
  'automaticFeather' | 'feather' | 'modifyGPU'
>> & {
  /** Additional contact region around the collider surface, in local units. */
  surfaceThickness?: number;
  /** Marks grid cells as solid for Eulerian pressure/advection. */
  gridOccupancy?: boolean;
  /** Participates in swept particle collision for particle-carried fluids. */
  particleCollision?: boolean;
};

/** A hard spatial boundary sampled by Eulerian fluid simulations at cell centers. */
export default class FluidCollider extends SpatialEffect {
  private static readonly collisionMaterial = new THREE.MeshBasicMaterial({ visible: false });
  gridOccupancy: boolean;
  particleCollision: boolean;
  private readonly collisionMesh: THREE.Mesh;
  private readonly customOccupancy: boolean;

  /** Whether unchanged geometry and transforms fully determine grid occupancy. @internal */
  get canCacheGridOccupancy(): boolean {
    return !this.customOccupancy && !this.conditionGPU
      && (this.updatePolicy === GeometryUpdatePolicy.Static
        || this.updatePolicy === GeometryUpdatePolicy.TransformDynamic);
  }

  get surfaceThickness(): number { return this.feather; }
  set surfaceThickness(value: number) {
    const next = Math.max(0, value);
    if (next === this.feather) return;
    this.feather = next;
    this.needsUpdate = true;
  }

  static Box(
    modify: SpatialEffectModifier | null,
    options: FluidColliderOptions | null,
    ...args: BoxGeometryArgs
  ): FluidCollider;
  static Box(options?: FluidColliderOptions, ...args: BoxGeometryArgs): FluidCollider;
  static Box(...args: BoxGeometryArgs): FluidCollider;
  static Box(first?: unknown, second?: unknown, ...rest: unknown[]): FluidCollider {
    const { options, geometryArgs } = FluidCollider.resolveFactoryArgs<BoxGeometryArgs>(
      first, second, rest,
    );
    return new FluidCollider({ ...options, geometry: new THREE.BoxGeometry(...geometryArgs) });
  }

  static Sphere(
    modify: SpatialEffectModifier | null,
    options: FluidColliderOptions | null,
    ...args: SphereGeometryArgs
  ): FluidCollider;
  static Sphere(options?: FluidColliderOptions, ...args: SphereGeometryArgs): FluidCollider;
  static Sphere(...args: SphereGeometryArgs): FluidCollider;
  static Sphere(first?: unknown, second?: unknown, ...rest: unknown[]): FluidCollider {
    const { options, geometryArgs } = FluidCollider.resolveFactoryArgs<SphereGeometryArgs>(
      first, second, rest,
    );
    return new FluidCollider({ ...options, geometry: new THREE.SphereGeometry(...geometryArgs) });
  }

  constructor(options: FluidColliderOptions = {}) {
    super(null, {
      ...options,
      automaticFeather: false,
      feather: Math.max(0, options.surfaceThickness ?? 0),
    });
    this.gridOccupancy = options.gridOccupancy ?? true;
    this.customOccupancy = options.test !== undefined || options.testGPU != null
      || options.featherEasing !== undefined;
    this.particleCollision = options.particleCollision ?? true;
    this.collisionMesh = new THREE.Mesh(this.geometry, FluidCollider.collisionMaterial);
    this.collisionMesh.name = 'Fluid Collider GPU Geometry';
    this.add(this.collisionMesh);
  }

  /** Invisible triangle geometry consumed by the GPU BVH collision backend. */
  getCollisionObject(): THREE.Mesh {
    if (this.geometry && this.collisionMesh.geometry !== this.geometry) {
      this.collisionMesh.geometry = this.geometry;
    }
    return this.collisionMesh;
  }

  private gpuField?: FluidColliderField;

  /** Whether a geometry-backed field has been prepared without custom CPU predicates. @internal */
  get hasPreparedGPUField(): boolean { return this.gpuField !== undefined; }

  /** Prepare local occupancy on the GPU; unchanged source geometry shares its bake across systems. @internal */
  prepareGPUField(renderer: ParticleSpatialGridRenderer): void {
    if (!this.customOccupancy && this.geometry) {
      const next = FluidColliderField.acquire(this.geometry, this.bakedFieldResolution,
        this.surfaceThickness, this.inverted, renderer);
      if (next !== this.gpuField) this.needsUpdate = true;
      this.gpuField = next;
    }
  }

  override bakedFieldGPU(particle: GPUParticleLike): Node<'float'> {
    if (this.customOccupancy) return super.bakedFieldGPU(particle);
    if (!this.gpuField) throw new Error('Fluid collider occupancy must be prepared with a GPU renderer.');
    return this.gpuField.sample(this.getGPUParticleLocalPosition(particle), this.inverted);
  }

  testPositionGPU(
    position: Node<'vec3'>,
    context: GPUParticleUpdateContext,
  ): Node<'float'> {
    const particle = { position } as GPUParticleLike;
    if (this.customOccupancy) return this.testGPU(particle, context);
    const strength = this.bakedFieldGPU(particle);
    return this.conditionGPU ? this.conditionGPU(particle, context, this).select(strength, 0) : strength;
  }

  private static resolveFactoryArgs<T extends unknown[]>(
    first: unknown,
    second: unknown,
    rest: unknown[],
  ): { options: FluidColliderOptions; geometryArgs: T } {
    if (typeof first === 'function') {
      throw new Error('FluidCollider does not accept a particle modifier.');
    }
    if (first === null) {
      return { options: (second as FluidColliderOptions | null) ?? {}, geometryArgs: rest as T };
    }
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      return {
        options: first as FluidColliderOptions,
        geometryArgs: [second, ...rest].filter((value) => value !== undefined) as T,
      };
    }
    return {
      options: {},
      geometryArgs: [first, second, ...rest].filter((value) => value !== undefined) as T,
    };
  }
}
