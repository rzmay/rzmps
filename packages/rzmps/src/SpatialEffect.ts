import * as THREE from 'three';
import { MeshBVH, type HitPointInfo } from 'three-mesh-bvh';
import type { Node } from 'three/webgpu';
import {
  abs,
  float,
  max,
  texture3D,
  vec3,
} from 'three/tsl';
import Particle from './Particle';
import type ParticleSystem from './ParticleSystem';
import acceptMultiple from './helpers/acceptMultiple';
import getParticleWorldPosition from './helpers/getParticleWorldPosition';
import isPointInMesh from './helpers/isPointInMesh';
import tagsIntersect from './helpers/tagsIntersect';
import type { StrictMultiple } from './types/Multiple';
import type { Tag } from './types/Tag';
import Priority from './enums/Priority';
import type { GPUParticle, GPUParticleUpdateContext } from './GPUParticle';
import { SimulationSpace } from './enums/SimulationSpace';

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

export type SpatialEffectGPUUpdate = (
  particle: GPUParticle,
  deltaTime: number,
  context: GPUParticleUpdateContext,
  strength: Node<'float'>,
) => void;

export type SpatialEffectGPUCondition = (
  particle: GPUParticle,
  context: GPUParticleUpdateContext,
  effect: SpatialEffect,
) => Node<'bool'>;

export type SpatialEffectGPUTest = (
  particle: GPUParticle,
  context: GPUParticleUpdateContext,
  effect: SpatialEffect,
) => Node<'float'>;

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
  modifyGPU: SpatialEffectGPUUpdate | null;
  conditionGPU: SpatialEffectGPUCondition | null;
  testGPU: SpatialEffectGPUTest | null;
  bakedFieldResolution: number;
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
  conditionGPU?: SpatialEffectGPUCondition;
  inverted: boolean;
  priority = Priority.Transient;
  feather: number;
  modifyGPU: SpatialEffectGPUUpdate;
  featherEasing: SpatialEffectFeatherEasing;

  private readonly _modify: SpatialEffectUpdate | null = null;
  private readonly _modifyFeather?: SpatialEffectFeatherUpdate;
  private _testGPU?: SpatialEffectGPUTest;
  private readonly _test?: SpatialEffectTest;
  private readonly _hasCustomCondition: boolean;
  private _geometry?: THREE.BufferGeometry;
  private _bvh?: MeshBVH;
  private _bvhGeometry?: THREE.BufferGeometry;
  private _mesh: THREE.Mesh;
  private localParticlePosition = new THREE.Vector3();
  private worldEffectPosition = new THREE.Vector3();
  private closestPointInfo?: HitPointInfo;
  bakedFieldResolution: number;
  private _bakedFieldTexture?: THREE.Data3DTexture;
  private _bakedFieldMatrixKey = '';
  private _bakedFieldGeometry?: THREE.BufferGeometry;
  private _bakedFieldFeather = -1;
  private _bakedFieldResolution = 0;
  private readonly _bakedFieldMin = new THREE.Vector3();
  private readonly _bakedFieldSize = new THREE.Vector3(1, 1, 1);

  static GPU_UNSUPPORTED: SpatialEffectGPUUpdate = () => {
    throw new Error('This spatial effect does not support GPU processing.');
  };

  set geometry(value: THREE.BufferGeometry | undefined) {
    this._geometry = value;
    if (value) value.computeBoundingBox();
    this._bvh = undefined;
    this._bvhGeometry = undefined;
    this._bakedFieldTexture = undefined;
    this._bakedFieldGeometry = undefined;
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
    this._hasCustomCondition = resolvedOptions.condition !== undefined;
    this.condition = resolvedOptions.condition ?? (() => true);
    this.conditionGPU = resolvedOptions.conditionGPU ?? undefined;
    this.priority = resolvedOptions.priority ?? this.priority;
    this.feather = Math.max(resolvedOptions.feather ?? 0, 0);
    this.featherEasing = resolvedOptions.featherEasing ?? ((feather) => feather);
    this.modifyGPU = resolvedOptions.modifyGPU ?? SpatialEffect.GPU_UNSUPPORTED;
    this.bakedFieldResolution = Math.max(
      2,
      Math.floor(resolvedOptions.bakedFieldResolution ?? 16),
    );
    this._test = resolvedOptions.test;
    this.geometry = resolvedOptions.geometry;
    this._testGPU = resolvedOptions.testGPU ?? this.createAnalyticTestGPU() ?? undefined;
  }

  get modifiesParticles(): boolean {
    return this._modify !== null
      || this._modifyFeather !== undefined
      || this._modifyParticle !== SpatialEffect.prototype._modifyParticle;
  }

  get supportsGPU(): boolean {
    return this.modifyGPU !== SpatialEffect.GPU_UNSUPPORTED
      && (!this._hasCustomCondition || this.conditionGPU !== undefined)
      && (this._testGPU !== undefined || this.geometry !== undefined);
  }

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

  containsWorldPosition(position: THREE.Vector3): boolean {
    if (!this.geometry) {
      this.getWorldPosition(this.worldEffectPosition);
      const contains = position.distanceToSquared(this.worldEffectPosition) <= Number.EPSILON;
      return this.inverted ? !contains : contains;
    }

    this.localParticlePosition.copy(position);
    this.updateWorldMatrix(true, false);
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

  testGPU(
    particle: GPUParticle,
    context: GPUParticleUpdateContext,
  ): Node<'float'> {
    const strength = this._testGPU
      ? this._testGPU(particle, context, this)
      : this.bakedFieldGPU(particle, context);

    if (!this.conditionGPU) return strength;

    return this.conditionGPU(particle, context, this).select(
      strength,
      float(0),
    ) as Node<'float'>;
  }

  bakedFieldGPU(
    particle: GPUParticle,
    context: GPUParticleUpdateContext,
  ): Node<'float'> {
    this.ensureBakedField();

    if (!this._bakedFieldTexture) return float(0);

    const worldPosition = this.getGPUParticleWorldPosition(particle, context.system);
    const uv = worldPosition
      .sub(vec3(this._bakedFieldMin))
      .div(vec3(this._bakedFieldSize))
      .clamp(0, 1);

    return texture3D(this._bakedFieldTexture, uv).x as Node<'float'>;
  }

  private createAnalyticTestGPU(): SpatialEffectGPUTest | undefined {
    if (!this.geometry) return undefined;

    const { type } = this.geometry;
    if (type === 'SphereGeometry' || type === 'IcosahedronGeometry') {
      return (particle, context) => this.sphereTestGPU(particle, context);
    }

    if (type === 'BoxGeometry') {
      return (particle, context) => this.boxTestGPU(particle, context);
    }

    return undefined;
  }

  private sphereTestGPU(
    particle: GPUParticle,
    context: GPUParticleUpdateContext,
  ): Node<'float'> {
    const bounds = this.getLocalBounds();
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5;
    const localPosition = this.getGPUParticleLocalPosition(particle, context.system);
    const distance = localPosition.sub(vec3(center)).length();
    const inside = distance.lessThanEqual(float(radius));

    if (this.inverted) {
      return inside.select(float(0), float(1));
    }

    if (this.feather <= 0) {
      return inside.select(float(1), float(0));
    }

    return inside.select(
      float(1),
      float(1).sub(distance.sub(radius).div(this.feather)).clamp(0, 1),
    ) as Node<'float'>;
  }

  private boxTestGPU(
    particle: GPUParticle,
    context: GPUParticleUpdateContext,
  ): Node<'float'> {
    const bounds = this.getLocalBounds();
    const center = bounds.getCenter(new THREE.Vector3());
    const halfSize = bounds.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const localPosition = this.getGPUParticleLocalPosition(particle, context.system);
    const q = abs(localPosition.sub(vec3(center))).sub(vec3(halfSize));
    const outside = vec3(
      max(q.x, float(0)),
      max(q.y, float(0)),
      max(q.z, float(0)),
    );
    const outsideDistance = outside.length();
    const maxAxis = max(q.x, max(q.y, q.z));
    const inside = maxAxis.lessThanEqual(float(0));

    if (this.inverted) {
      return inside.select(float(0), float(1));
    }

    if (this.feather <= 0) {
      return inside.select(float(1), float(0));
    }

    return inside.select(
      float(1),
      float(1).sub(outsideDistance.div(this.feather)).clamp(0, 1),
    ) as Node<'float'>;
  }

  protected getLocalBounds(): THREE.Box3 {
    if (!this.geometry) {
      return new THREE.Box3(
        new THREE.Vector3(-Number.EPSILON, -Number.EPSILON, -Number.EPSILON),
        new THREE.Vector3(Number.EPSILON, Number.EPSILON, Number.EPSILON),
      );
    }

    if (!this.geometry.boundingBox) this.geometry.computeBoundingBox();
    return this.geometry.boundingBox
      ?? new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
  }

  protected getGPUParticleWorldPosition(
    particle: GPUParticle,
    particleSystem: ParticleSystem,
  ): Node<'vec3'> {
    if (particleSystem.simulationSpace !== SimulationSpace.Local) {
      return particle.position;
    }

    particleSystem.updateWorldMatrix(true, false);
    return transformPointGPU(particle.position, particleSystem.matrixWorld);
  }

  protected getGPUParticleLocalPosition(
    particle: GPUParticle,
    particleSystem: ParticleSystem,
  ): Node<'vec3'> {
    this.updateWorldMatrix(true, false);
    const inverseWorld = this.matrixWorld.clone().invert();
    return transformPointGPU(
      this.getGPUParticleWorldPosition(particle, particleSystem),
      inverseWorld,
    );
  }

  private ensureBakedField(): void {
    if (!this.geometry && this.feather <= 0) {
      this._bakedFieldTexture = undefined;
      return;
    }

    this.updateWorldMatrix(true, false);

    const matrixKey = this.matrixWorld.elements
      .map((value) => value.toFixed(6))
      .join(',');

    if (
      this._bakedFieldTexture
      && this._bakedFieldGeometry === this.geometry
      && this._bakedFieldFeather === this.feather
      && this._bakedFieldResolution === this.bakedFieldResolution
      && this._bakedFieldMatrixKey === matrixKey
    ) return;

    const bounds = this.getBakedFieldWorldBounds();
    const resolution = this.bakedFieldResolution;
    const data = new Uint8Array(resolution * resolution * resolution);
    const point = new THREE.Vector3();
    const step = new THREE.Vector3(
      resolution > 1 ? bounds.getSize(new THREE.Vector3()).x / (resolution - 1) : 0,
      resolution > 1 ? bounds.getSize(new THREE.Vector3()).y / (resolution - 1) : 0,
      resolution > 1 ? bounds.getSize(new THREE.Vector3()).z / (resolution - 1) : 0,
    );

    this._bakedFieldMin.copy(bounds.min);
    bounds.getSize(this._bakedFieldSize);
    this._bakedFieldSize.max(new THREE.Vector3(Number.EPSILON, Number.EPSILON, Number.EPSILON));

    let index = 0;
    for (let z = 0; z < resolution; z += 1) {
      for (let y = 0; y < resolution; y += 1) {
        for (let x = 0; x < resolution; x += 1) {
          point.set(
            bounds.min.x + step.x * x,
            bounds.min.y + step.y * y,
            bounds.min.z + step.z * z,
          );
          data[index] = Math.round(THREE.MathUtils.clamp(this.getFeather(point), 0, 1) * 255);
          index += 1;
        }
      }
    }

    const texture = new THREE.Data3DTexture(data, resolution, resolution, resolution);
    texture.format = THREE.RedFormat;
    texture.type = THREE.UnsignedByteType;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.wrapR = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;

    this._bakedFieldTexture = texture;
    this._bakedFieldGeometry = this.geometry;
    this._bakedFieldFeather = this.feather;
    this._bakedFieldResolution = resolution;
    this._bakedFieldMatrixKey = matrixKey;
  }

  private getBakedFieldWorldBounds(): THREE.Box3 {
    this.updateWorldMatrix(true, false);

    if (!this.geometry) {
      this.getWorldPosition(this.worldEffectPosition);
      const radius = Math.max(this.feather, Number.EPSILON);
      return new THREE.Box3(
        this.worldEffectPosition.clone().subScalar(radius),
        this.worldEffectPosition.clone().addScalar(radius),
      );
    }

    const bounds = this.getLocalBounds();
    const worldBounds = new THREE.Box3();
    const corner = new THREE.Vector3();

    for (let x = 0; x <= 1; x += 1) {
      for (let y = 0; y <= 1; y += 1) {
        for (let z = 0; z <= 1; z += 1) {
          corner.set(
            x === 0 ? bounds.min.x : bounds.max.x,
            y === 0 ? bounds.min.y : bounds.max.y,
            z === 0 ? bounds.min.z : bounds.max.z,
          );
          worldBounds.expandByPoint(corner.applyMatrix4(this.matrixWorld));
        }
      }
    }

    worldBounds.expandByScalar(Math.max(this.feather, Number.EPSILON));
    return worldBounds;
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

function transformPointGPU(point: Node<'vec3'>, matrix: THREE.Matrix4): Node<'vec3'> {
  const e = matrix.elements;

  return vec3(
    point.x.mul(e[0]).add(point.y.mul(e[4])).add(point.z.mul(e[8])).add(e[12]),
    point.x.mul(e[1]).add(point.y.mul(e[5])).add(point.z.mul(e[9])).add(e[13]),
    point.x.mul(e[2]).add(point.y.mul(e[6])).add(point.z.mul(e[10])).add(e[14]),
  ) as Node<'vec3'>;
}

export default SpatialEffect;
