import * as THREE from 'three';
import { MeshBVH, type MeshBVHOptions } from 'three-mesh-bvh';
import tagsIntersect from '../../helpers/tagsIntersect';
import type { Tag } from '../../types/Tag';
import type Particle from '../../Particle';
import type ParticleSystem from '../../ParticleSystem';
import SpatialEffect, {
  type SpatialEffectModifier,
  type SpatialEffectOptions,
  type SpatialEffectTest,
} from '../../SpatialEffect';

export interface BoidAffectorOptions extends SpatialEffectOptions {
  weight: number;
  distance: number;
  bvhOptions: MeshBVHOptions;
}

enum Weight {
  Target = 1,
  Obstacle = -1,
}

class BoidAffector extends SpatialEffect {
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
      geometryArgs: (second === undefined ? rest : [second, ...rest]) as T,
    };
  }

  weight: number;
  distance: number;
  bvhOptions?: MeshBVHOptions;

  private _affectorBVH?: MeshBVH;
  private _affectorBVHGeometry?: THREE.BufferGeometry;
  private _affectorTest?: SpatialEffectTest;
  private localSamplePoint = new THREE.Vector3();
  private worldSamplePoint = new THREE.Vector3();
  private influenceSamplePoint = new THREE.Vector3();
  private influenceLocalPosition = new THREE.Vector3();

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
    });

    this.weight = options.weight ?? Weight.Target;
    this.distance = options.distance ?? 1;
    this.bvhOptions = options.bvhOptions;
    this._affectorTest = options.test;
  }

  matchesTags(tags?: Tag[]): boolean {
    return !this.tags?.length || tagsIntersect(this.tags, tags ?? []);
  }

  override test(particle: Particle, particleSystem: ParticleSystem): boolean {
    if (!this.matchesTags(particle.tags)) return false;
    if (!this.condition(particle)) return false;
    if (this._affectorTest) return this._affectorTest(particle, particleSystem, this);

    return true;
  }

  samplePoint(position: THREE.Vector3, target = new THREE.Vector3()): THREE.Vector3 {
    this.updateWorldMatrix(true, false);

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

  getInfluenceDirection(position: THREE.Vector3, target = new THREE.Vector3()): THREE.Vector3 {
    this.samplePoint(position, this.influenceSamplePoint);
    target.copy(position).sub(this.influenceSamplePoint);

    if (!this.geometry || target.lengthSq() === 0) return target;

    this.influenceLocalPosition.copy(position);
    this.worldToLocal(this.influenceLocalPosition);

    const contains = this.containsWorldPosition(position);
    const inside = this.inverted ? !contains : contains;
    if (inside !== this.inverted) target.multiplyScalar(-1);

    return target;
  }
}

export default BoidAffector;
