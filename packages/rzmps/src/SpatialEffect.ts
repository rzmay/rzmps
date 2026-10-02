import * as THREE from 'three';
import { MeshBVH, type HitPointInfo } from 'three-mesh-bvh';
import Particle from './Particle';
import type ParticleSystem from './ParticleSystem';
import acceptMultiple from './helpers/acceptMultiple';
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
  test: SpatialEffectTest;
  priority: number | Priority;
  feather: number;
  automaticFeather: boolean;
}

class SpatialEffect extends THREE.Object3D {
  private static readonly _doubleSidedMaterial = new THREE.MeshBasicMaterial(
    { side: THREE.DoubleSide },
  );

  static Box(...factoryArgs: unknown[]): SpatialEffect {
    const resolved = SpatialEffect._resolveFactoryArgs(factoryArgs);
    return new SpatialEffect(resolved.modify, { ...resolved.options, geometry: new THREE.BoxGeometry(...resolved.args) });
  }

  static Sphere(...factoryArgs: unknown[]): SpatialEffect {
    const resolved = SpatialEffect._resolveFactoryArgs(factoryArgs);
    return new SpatialEffect(resolved.modify, { ...resolved.options, geometry: new THREE.SphereGeometry(...resolved.args) });
  }

  static Cone(...factoryArgs: unknown[]): SpatialEffect {
    const resolved = SpatialEffect._resolveFactoryArgs(factoryArgs);
    return new SpatialEffect(resolved.modify, { ...resolved.options, geometry: new THREE.ConeGeometry(...resolved.args) });
  }

  static Torus(...factoryArgs: unknown[]): SpatialEffect {
    const resolved = SpatialEffect._resolveFactoryArgs(factoryArgs);
    return new SpatialEffect(resolved.modify, { ...resolved.options, geometry: new THREE.TorusGeometry(...resolved.args) });
  }

  private static _resolveFactoryArgs(factoryArgs: unknown[]): {
      modify: SpatialEffectModifier | null;
      options: Partial<SpatialEffectOptions>;
      args: never[];
    } {
    const [modifyOrOptions, optionsOrFirstGeometryArg, ...args] = factoryArgs;
    const firstArgIsModify = typeof modifyOrOptions === 'function' || modifyOrOptions === null;
    const secondArgIsOptions = typeof optionsOrFirstGeometryArg === 'object'
      && optionsOrFirstGeometryArg !== null
      && !(optionsOrFirstGeometryArg instanceof Number);

    if (firstArgIsModify) {
      return {
        modify: modifyOrOptions as SpatialEffectModifier | null,
        options: secondArgIsOptions ? optionsOrFirstGeometryArg as Partial<SpatialEffectOptions> : {},
        args: (secondArgIsOptions || optionsOrFirstGeometryArg === undefined
          ? args
          : [optionsOrFirstGeometryArg, ...args]) as never[],
      };
    }

    return {
      modify: null,
      options: modifyOrOptions ?? {},
      args: (optionsOrFirstGeometryArg === undefined
        ? args
        : [optionsOrFirstGeometryArg, ...args]) as never[],
    };
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
      SpatialEffect.getParticleWorldPosition(particle, particleSystem, particleWorldPosition);

      const signedDistance = particleWorldPosition.sub(position).dot(normal.clone().normalize());
      const isPositiveSide = signedDistance >= 0;

      return inverted ? !isPositiveSide : isPositiveSide;
    };
  }

  static getParticleWorldPosition(
    particle: Particle,
    particleSystem: ParticleSystem,
    target = new THREE.Vector3(),
  ): THREE.Vector3 {
    target.copy(particle.position);

    if (particleSystem.simulationSpace !== 'world') {
      particleSystem.updateWorldMatrix(true, false);
      particleSystem.localToWorld(target);
    }

    return target;
  }

  tags?: Tag[];
  inverted: boolean;
  priority = Priority.Transient;
  feather: number;

  private readonly _modify: SpatialEffectUpdate | null = null;
  private readonly _modifyFeather?: SpatialEffectFeatherUpdate;
  private readonly _test?: SpatialEffectTest;
  private _geometry?: THREE.BufferGeometry;
  private _bvh?: MeshBVH;
  private _bvhGeometry?: THREE.BufferGeometry;
  private _mesh: THREE.Mesh;
  private localParticlePosition = new THREE.Vector3();
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
    options: Partial<SpatialEffectOptions> = {},
  ) {
    super();

    this._mesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      SpatialEffect._doubleSidedMaterial,
    );
    if (modify && options.automaticFeather === false) {
      this._modifyFeather = modify as SpatialEffectFeatherUpdate;
    } else {
      this._modify = modify as SpatialEffectUpdate | null;
    }

    if (options.position) this.position.copy(options.position);
    if (options.scale) this.scale.copy(options.scale);

    this.inverted = options.inverted ?? false;
    this.tags = acceptMultiple(options.tags);
    this.priority = options.priority ?? this.priority;
    this.feather = Math.max(options.feather ?? 0, 0);
    this._test = options.test;
    this.geometry = options.geometry;
  }

  get modifiesParticles(): boolean {
    return this._modify !== null
      || this._modifyFeather !== undefined
      || this.modify !== SpatialEffect.prototype.modify;
  }

  test(particle: Particle, particleSystem: ParticleSystem): boolean {
    if (this.tags && !tagsIntersect(this.tags, particle.tags ?? [])) return false;
    if (this._test) return this._test(particle, particleSystem, this);
    if (!this.geometry) return false;

    SpatialEffect.getParticleWorldPosition(
      particle,
      particleSystem,
      this.localParticlePosition,
    );

    return this.getFeather(this.localParticlePosition) > 0;
  }

  containsWorldPosition(position: THREE.Vector3): boolean {
    return this.getFeather(position) >= 1;
  }

  getParticleFeather(particle: Particle, particleSystem: ParticleSystem): number {
    if (this.tags && !tagsIntersect(this.tags, particle.tags ?? [])) return 0;
    if (this._test) return this._test(particle, particleSystem, this) ? 1 : 0;

    SpatialEffect.getParticleWorldPosition(
      particle,
      particleSystem,
      this.localParticlePosition,
    );

    return this.getFeather(this.localParticlePosition);
  }

  getFeather(position: THREE.Vector3): number {
    if (!this.geometry) return 0;

    this.localParticlePosition.copy(position);
    this.updateWorldMatrix(true, false);
    this.worldToLocal(this.localParticlePosition);

    const contains = isPointInMesh(this.localParticlePosition, this._mesh);

    if (contains) return this.inverted ? 0 : 1;
    if (this.inverted) return 1;
    if (this.feather <= 0) return 0;

    const distance = this.getLocalFeatherDistance(this.localParticlePosition);
    if (distance === undefined) return 0;

    return Math.min(Math.max(1 - distance / this.feather, 0), 1);
  }

  private getLocalFeatherDistance(position: THREE.Vector3): number | undefined {
    if (!this.geometry) return undefined;

    const bvh = this.getBVH();
    if (!bvh) return undefined;

    const hit = bvh.closestPointToPoint(
      position,
      this.closestPointInfo,
      0,
      this.feather,
    );

    if (!hit) return undefined;

    this.closestPointInfo = hit;
    return hit.distance;
  }

  private getBVH(): MeshBVH | undefined {
    if (!this.geometry) return undefined;
    if (this._bvh && this._bvhGeometry === this.geometry) return this._bvh;

    this._bvh = new MeshBVH(this.geometry);
    this._bvhGeometry = this.geometry;

    return this._bvh;
  }

  modify(particle: Particle, deltaTime: number, particleSystem: ParticleSystem): void {
    const feather = this.getParticleFeather(particle, particleSystem);
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
}

export default SpatialEffect;
