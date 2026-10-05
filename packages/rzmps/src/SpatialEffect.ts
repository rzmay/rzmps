import * as THREE from 'three';
import { MeshBVH, type HitPointInfo } from 'three-mesh-bvh';
import Particle from './Particle';
import type ParticleSystem from './ParticleSystem';
import acceptMultiple from './helpers/acceptMultiple';
import getParticleWorldPosition from './helpers/getParticleWorldPosition';
import isPointInMesh from './helpers/isPointInMesh';
import tagsIntersect from './helpers/tagsIntersect';
import type { StrictMultiple } from './types/Multiple';
import type { Tag } from './types/Tag';
import Priority from './enums/Priority';

export type SpatialEffectUpdate = (
  particle: Particle,
  deltaTime: number,
  particleSystem: ParticleSystem,
) => void;

export type SpatialEffectFeatherUpdate = (
  particle: Particle,
  deltaTime: number,
  particleSystem: ParticleSystem,
  feather: number,
) => void;

export type SpatialEffectModifier = SpatialEffectUpdate | SpatialEffectFeatherUpdate;

export type SpatialEffectFeatherEasing = (feather: number) => number;

export type SpatialEffectTest = (
  particle: Particle,
  particleSystem: ParticleSystem,
  effect: SpatialEffect,
) => boolean;

export interface SpatialEffectOptions {
  position: THREE.Vector3;
  scale: THREE.Vector3;
  geometry: THREE.BufferGeometry;
  inverted: boolean;
  tags: StrictMultiple<Tag>;
  condition: (particle: Particle) => boolean;
  test: SpatialEffectTest;
  priority: number | Priority;
  feather: number;
  featherEasing: SpatialEffectFeatherEasing;
  automaticFeather: boolean;
}

type BoxGeometryArgs = ConstructorParameters<typeof THREE.BoxGeometry>;
type SphereGeometryArgs = ConstructorParameters<typeof THREE.SphereGeometry>;
type ConeGeometryArgs = ConstructorParameters<typeof THREE.ConeGeometry>;
type TorusGeometryArgs = ConstructorParameters<typeof THREE.TorusGeometry>;

class SpatialEffect extends THREE.Object3D {
  private static readonly _doubleSidedMaterial = new THREE.MeshBasicMaterial(
    { side: THREE.DoubleSide },
  );

  static Box(
    modify: SpatialEffectModifier | null,
    options: Partial<SpatialEffectOptions> | null,
    ...args: BoxGeometryArgs
  ): SpatialEffect {
    return new SpatialEffect(
      modify,
      {
        ...(options ?? {}),
        geometry: new THREE.BoxGeometry(...args),
      },
    );
  }

  static Sphere(
    modify: SpatialEffectModifier | null,
    options: Partial<SpatialEffectOptions> | null,
    ...args: SphereGeometryArgs
  ): SpatialEffect {
    return new SpatialEffect(
      modify,
      {
        ...(options ?? {}),
        geometry: new THREE.SphereGeometry(...args),
      },
    );
  }

  static Cone(
    modify: SpatialEffectModifier | null,
    options: Partial<SpatialEffectOptions> | null,
    ...args: ConeGeometryArgs
  ): SpatialEffect {
    return new SpatialEffect(
      modify,
      {
        ...(options ?? {}),
        geometry: new THREE.ConeGeometry(...args),
      },
    );
  }

  static Torus(
    modify: SpatialEffectModifier | null,
    options: Partial<SpatialEffectOptions> | null,
    ...args: TorusGeometryArgs
  ): SpatialEffect {
    return new SpatialEffect(
      modify,
      {
        ...(options ?? {}),
        geometry: new THREE.TorusGeometry(...args),
      },
    );
  }

  static Plane(
    options: {
      position?: THREE.Vector3;
      normal?: THREE.Vector3;
      inverted?: boolean;
    } = {},
  ): SpatialEffectTest {
    const position = options.position ?? new THREE.Vector3();
    const normal = options.normal ?? new THREE.Vector3(0, 1, 0);
    const inverted = options.inverted ?? false;
    const particleWorldPosition = new THREE.Vector3();

    return (particle, particleSystem) => {
      getParticleWorldPosition(particle, particleSystem, particleWorldPosition);

      const signedDistance = particleWorldPosition.sub(position).dot(normal.clone().normalize());
      const isPositiveSide = signedDistance >= 0;

      return inverted ? !isPositiveSide : isPositiveSide;
    };
  }

  tags?: Tag[];
  condition: (particle: Particle) => boolean;
  inverted: boolean;
  priority = Priority.Transient;
  feather: number;
  featherEasing: SpatialEffectFeatherEasing;

  private readonly _modify: SpatialEffectUpdate | null = null;
  private readonly _modifyFeather?: SpatialEffectFeatherUpdate;
  private readonly _test?: SpatialEffectTest;
  private _geometry?: THREE.BufferGeometry;
  private _bvh?: MeshBVH;
  private _bvhGeometry?: THREE.BufferGeometry;
  private _mesh: THREE.Mesh;
  private localParticlePosition = new THREE.Vector3();
  private worldEffectPosition = new THREE.Vector3();
  private closestPointInfo?: HitPointInfo;

  set geometry(value: THREE.BufferGeometry | undefined) {
    this._geometry = value;
    if (value) value.computeBoundingBox();
    this._bvh = undefined;
    this._bvhGeometry = undefined;
    this._mesh.geometry = value ?? new THREE.BufferGeometry();
  }

  get geometry(): THREE.BufferGeometry | undefined {
    return this._geometry;
  }

  constructor(
    modify: SpatialEffectModifier | null,
    options: Partial<SpatialEffectOptions> | null = {},
  ) {
    super();
    const resolvedOptions = options ?? {};

    this._mesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      SpatialEffect._doubleSidedMaterial,
    );
    if (modify && resolvedOptions.automaticFeather === false) {
      this._modifyFeather = modify as SpatialEffectFeatherUpdate;
    } else {
      this._modify = modify as SpatialEffectUpdate | null;
    }

    if (resolvedOptions.position) this.position.copy(resolvedOptions.position);
    if (resolvedOptions.scale) this.scale.copy(resolvedOptions.scale);

    this.inverted = resolvedOptions.inverted ?? false;
    this.tags = acceptMultiple(resolvedOptions.tags);
    this.condition = resolvedOptions.condition ?? (() => true);
    this.priority = resolvedOptions.priority ?? this.priority;
    this.feather = Math.max(resolvedOptions.feather ?? 0, 0);
    this.featherEasing = resolvedOptions.featherEasing ?? ((feather) => feather);
    this._test = resolvedOptions.test;
    this.geometry = resolvedOptions.geometry;
  }

  // If this directly modifies particles and should be picked up by particle systems
  // This will be true for most spatial effects, but not special ones like boid affectors
  get modifiesParticles(): boolean {
    return this._modify !== null
      || this._modifyFeather !== undefined
      || this._modifyParticle !== SpatialEffect.prototype._modifyParticle;
  }

  // Spatial test, whether or not this is within the effect's jurisdiction
  test(particle: Particle, particleSystem: ParticleSystem): boolean {
    if (this.tags && !tagsIntersect(this.tags, particle.tags ?? [])) return false;
    if (this._test) return this._test(particle, particleSystem, this);

    getParticleWorldPosition(
      particle,
      particleSystem,
      this.localParticlePosition,
    );

    return this.getFeather(this.localParticlePosition) > 0;
  }

  containsWorldPosition(position: THREE.Vector3, updateMatrix = true): boolean {
    if (!this.geometry) {
      this.getWorldPosition(this.worldEffectPosition);
      const contains = position.distanceToSquared(this.worldEffectPosition) <= Number.EPSILON;
      return this.inverted ? !contains : contains;
    }

    this.localParticlePosition.copy(position);
    if (updateMatrix) this.updateWorldMatrix(true, false);
    this.worldToLocal(this.localParticlePosition);

    const contains = isPointInMesh(this.localParticlePosition, this._mesh);
    return this.inverted ? !contains : contains;
  }

  getFeather(position: THREE.Vector3): number {
    if (!this.geometry) {
      this.getWorldPosition(this.worldEffectPosition);
      const distance = position.distanceTo(this.worldEffectPosition);

      if (this.inverted) return distance <= Number.EPSILON ? 0 : 1;
      if (this.feather <= 0) return distance <= Number.EPSILON ? 1 : 0;

      return this.easeFeather(1 - distance / this.feather);
    }

    this.localParticlePosition.copy(position);
    this.updateWorldMatrix(true, false);
    this.worldToLocal(this.localParticlePosition);

    const contains = isPointInMesh(this.localParticlePosition, this._mesh);

    if (contains) return this.inverted ? 0 : 1;
    if (this.inverted) return 1;
    if (this.feather <= 0) return 0;

    if (!this._bvh || this._bvhGeometry !== this.geometry) {
      this._bvh = new MeshBVH(this.geometry);
      this._bvhGeometry = this.geometry;
    }

    const hit = this._bvh.closestPointToPoint(
      this.localParticlePosition,
      this.closestPointInfo,
      0,
      this.feather,
    );

    if (!hit) return 0;

    this.closestPointInfo = hit;
    return this.easeFeather(1 - hit.distance / this.feather);
  }

  modify(particles: Particle[], deltaTime: number, particleSystem: ParticleSystem): void {
    particles
      .filter((particle) => this.test(particle, particleSystem))
      .filter((particle) => this.condition(particle))
      .forEach((particle) => this._modifyParticle(particle, deltaTime, particleSystem));
  }

  protected _modifyParticle(
    particle: Particle,
    deltaTime: number,
    particleSystem: ParticleSystem,
  ): void {
    getParticleWorldPosition(
      particle,
      particleSystem,
      this.localParticlePosition,
    );

    const feather = this._test ? 1 : this.getFeather(this.localParticlePosition);
    if (feather <= 0) return;

    if (this._modifyFeather) {
      this._modifyFeather(particle, deltaTime, particleSystem, feather);
      return;
    }

    if (!this._modify) return;

    if (feather >= 1) {
      this._modify(particle, deltaTime, particleSystem);
      return;
    }

    const before = particle.clone();
    this._modify(particle, deltaTime, particleSystem);
    const after = particle.clone();
    particle
      .lerp(before, 1)
      .lerp(after, feather);
  }

  private easeFeather(feather: number): number {
    const clamped = Math.min(Math.max(feather, 0), 1);
    const eased = this.featherEasing(clamped);
    return Number.isFinite(eased)
      ? Math.min(Math.max(eased, 0), 1)
      : clamped;
  }
}

export default SpatialEffect;
