import * as THREE from 'three';
import { MeshBVH, type HitPointInfo } from 'three-mesh-bvh';
import type { Node } from 'three/webgpu';
import {
  abs,
  array,
  float,
  int,
  length,
  max,
  min,
  mix,
  texture3D,
  uniform,
  vec2,
  vec3,
  vec4,
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
import type { GPUParticleLike, GPUParticleUpdateContext } from './gpu/Particle';
import { SimulationSpace } from './enums/SimulationSpace';
import type {
  GPUSpatialEffectType,
  GPUSpatialParameterAccessor,
  GPUSpatialParameterField,
} from './gpu/SpatialEffectRegistry';

enum SpatialInfluenceShape {
  Box = 1,
  Sphere,
  Cone,
  Torus,
}

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
  particle: GPUParticleLike,
  deltaTime: Node<'float'>,
  context: GPUParticleUpdateContext,
  strength: Node<'float'>,
) => void;

export type SpatialEffectGPUCondition = (
  particle: GPUParticleLike,
  context: GPUParticleUpdateContext,
  effect: SpatialEffect,
) => Node<'bool'>;

export type SpatialEffectGPUTest = (
  particle: GPUParticleLike,
  context: GPUParticleUpdateContext,
  effect: SpatialEffect,
) => Node<'float'>;

export type SpatialEffectFeatherEasing = (feather: number) => number;

export enum SpatialEffectUpdatePolicy {
  Static = 'static',
  TransformDynamic = 'transform-dynamic',
  GeometryDynamic = 'geometry-dynamic',
  Auto = 'auto',
}

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
  updatePolicy: SpatialEffectUpdatePolicy;
}

type BoxGeometryArgs = ConstructorParameters<typeof THREE.BoxGeometry>;
type SphereGeometryArgs = ConstructorParameters<typeof THREE.SphereGeometry>;
type ConeGeometryArgs = ConstructorParameters<typeof THREE.ConeGeometry>;
type TorusGeometryArgs = ConstructorParameters<typeof THREE.TorusGeometry>;

class SpatialEffect extends THREE.Object3D {
  static readonly GPU_INFLUENCE_FIELDS: GPUSpatialParameterField[] = [
    { name: 'inverseRow0', type: 'vec4' },
    { name: 'inverseRow1', type: 'vec4' },
    { name: 'inverseRow2', type: 'vec4' },
    { name: 'shape', type: 'float' },
    { name: 'shapeSize', type: 'vec3' },
    { name: 'feather', type: 'float' },
    { name: 'inverted', type: 'float' },
  ];

  static readonly GPU_INFLUENCE_ALIGNED_SIZE = 24;

  static testGPUInfluence(
    particle: GPUParticleLike,
    params: GPUSpatialParameterAccessor,
  ): Node<'float'> {
    const position = vec4(particle.position, 1);
    const local = vec3(
      params.vec4('inverseRow0').dot(position),
      params.vec4('inverseRow1').dot(position),
      params.vec4('inverseRow2').dot(position),
    );
    const shape = params.float('shape');
    const size = params.vec3('shapeSize');

    const boxDelta = abs(local).sub(size.mul(0.5));
    const boxOutside = length(max(boxDelta, vec3(0)));
    const boxInside = min(max(boxDelta.x, max(boxDelta.y, boxDelta.z)), float(0));
    const boxDistance = boxOutside.add(boxInside);
    const sphereDistance = local.length().sub(size.x);
    const coneHalfHeight = size.y.mul(0.5).max(float(Number.EPSILON));
    const coneRadius = size.x.mul(float(0.5).sub(local.y.div(size.y.max(float(Number.EPSILON)))));
    const coneDistance = max(
      local.y.abs().sub(coneHalfHeight),
      length(local.xz).sub(coneRadius),
    );
    const torusDistance = length(vec2(length(local.xz).sub(size.x), local.y)).sub(size.y);

    const distance = shape.equal(float(SpatialInfluenceShape.Box)).select(
      boxDistance,
      shape.equal(float(SpatialInfluenceShape.Sphere)).select(
        sphereDistance,
        shape.equal(float(SpatialInfluenceShape.Cone)).select(coneDistance, torusDistance),
      ),
    ) as Node<'float'>;
    const inside = distance.lessThanEqual(float(0));
    const feather = params.float('feather');
    const featheredStrength = inside.select(
      float(1),
      float(1).sub(distance.div(feather.max(float(Number.EPSILON)))).clamp(0, 1),
    );
    const strength = feather.greaterThan(float(0)).select(
      featheredStrength,
      inside.select(float(1), float(0)),
    );
    return params.float('inverted').greaterThan(float(0.5)).select(
      inside.select(float(0), float(1)),
      strength,
    ) as Node<'float'>;
  }

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
  automaticFeather: boolean;
  modifyGPU: SpatialEffectGPUUpdate;
  gpuSpatialType?: GPUSpatialEffectType;
  writeGPUParameters?: (target: Float32Array, offset: number, system: ParticleSystem) => void;
  featherEasing: SpatialEffectFeatherEasing;

  private readonly _modify: SpatialEffectUpdate | null = null;
  private readonly _modifyFeather?: SpatialEffectFeatherUpdate;
  private _testGPU?: SpatialEffectGPUTest;
  private readonly _test?: SpatialEffectTest;
  private readonly _hasCustomCondition: boolean;
  private readonly _hasCustomFeatherEasing: boolean;
  private readonly _hasCustomTest: boolean;
  private _geometry?: THREE.BufferGeometry;
  private _bvh?: MeshBVH;
  private _bvhGeometry?: THREE.BufferGeometry;
  private _bvhTopologyKey = '';
  private _bvhPositionVersion = -1;
  private localParticlePosition = new THREE.Vector3();
  private worldEffectPosition = new THREE.Vector3();
  private geometryBoundsSize = new THREE.Vector3();
  private closestPointInfo?: HitPointInfo;
  bakedFieldResolution: number;
  updatePolicy: SpatialEffectUpdatePolicy;
  private _bakedFieldTexture?: THREE.Data3DTexture;
  private _bakedFieldGeometry?: THREE.BufferGeometry;
  private _bakedFieldGeometryKey = '';
  private _bakedFieldFeather = -1;
  private _bakedFieldResolution = 0;
  private _version = 0;
  private readonly _bakedFieldMin = new THREE.Vector3();
  private readonly _bakedFieldSize = new THREE.Vector3(1, 1, 1);
  private readonly _gpuBakedFieldMinNode = uniform(new THREE.Vector3(), 'vec3') as Node<'vec3'> & {
    value: THREE.Vector3;
  };
  private readonly _gpuBakedFieldSizeNode = uniform(new THREE.Vector3(1, 1, 1), 'vec3') as Node<'vec3'> & {
    value: THREE.Vector3;
  };
  private readonly _gpuWorldToLocalNode = uniform(new THREE.Matrix4(), 'mat4') as Node<'mat4'> & {
    value: THREE.Matrix4;
  };
  private readonly _gpuLocalToWorldNode = uniform(new THREE.Matrix4(), 'mat4') as Node<'mat4'> & {
    value: THREE.Matrix4;
  };
  private readonly _gpuSimulationToWorldNode = uniform(new THREE.Matrix4(), 'mat4') as Node<'mat4'> & {
    value: THREE.Matrix4;
  };
  private readonly _gpuLocalToSimulationNode = uniform(new THREE.Matrix4(), 'mat4') as Node<'mat4'> & {
    value: THREE.Matrix4;
  };
  private readonly _gpuLocalDirectionNode = uniform(new THREE.Matrix4(), 'mat4') as Node<'mat4'> & {
    value: THREE.Matrix4;
  };

  get version(): number {
    return this._version;
  }

  set needsUpdate(value: boolean) {
    if (value) this._version += 1;
  }

  static GPU_UNSUPPORTED: SpatialEffectGPUUpdate = () => {
    throw new Error('This spatial effect does not support GPU processing.');
  };

  set geometry(value: THREE.BufferGeometry | undefined) {
    this._bakedFieldTexture?.dispose();
    this._geometry = value;
    if (value) value.computeBoundingBox();
    this._bvh = undefined;
    this._bvhGeometry = undefined;
    this._bvhTopologyKey = '';
    this._bvhPositionVersion = -1;
    this._bakedFieldTexture = undefined;
    this._bakedFieldGeometry = undefined;
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
    this._hasCustomFeatherEasing = resolvedOptions.featherEasing !== undefined;
    this._hasCustomTest = resolvedOptions.test !== undefined || resolvedOptions.testGPU !== undefined;
    this.condition = resolvedOptions.condition ?? (() => true);
    this.conditionGPU = resolvedOptions.conditionGPU ?? undefined;
    this.priority = resolvedOptions.priority ?? this.priority;
    this.feather = Math.max(resolvedOptions.feather ?? 0, 0);
    this.featherEasing = resolvedOptions.featherEasing ?? ((feather) => feather);
    this.automaticFeather = resolvedOptions.automaticFeather !== false;
    this.modifyGPU = resolvedOptions.modifyGPU ?? SpatialEffect.GPU_UNSUPPORTED;
    this.bakedFieldResolution = Math.max(
      2,
      Math.floor(resolvedOptions.bakedFieldResolution ?? 16),
    );
    this.updatePolicy = resolvedOptions.updatePolicy ?? SpatialEffectUpdatePolicy.Auto;
    this._test = resolvedOptions.test;
    this.geometry = resolvedOptions.geometry;
    this._testGPU = resolvedOptions.testGPU ?? this.createAnalyticTestGPU() ?? undefined;
  }

  /** Refreshes transform uniforms used by non-batched and baked GPU influence paths. */
  syncGPUTransform(system: ParticleSystem): void {
    this.updateWorldMatrix(true, false);
    this._gpuWorldToLocalNode.value.copy(this.matrixWorld).invert();
    this._gpuLocalToWorldNode.value.copy(this.matrixWorld);
    this._gpuLocalToSimulationNode.value.copy(this.matrixWorld);
    const effectRotation = this.getWorldQuaternion(new THREE.Quaternion());
    if (system.simulationSpace === SimulationSpace.Local) {
      system.updateWorldMatrix(true, false);
      this._gpuSimulationToWorldNode.value.copy(system.matrixWorld);
      this._gpuLocalToSimulationNode.value.premultiply(
        new THREE.Matrix4().copy(system.matrixWorld).invert(),
      );
      effectRotation.premultiply(system.getWorldQuaternion(new THREE.Quaternion()).invert());
    } else {
      this._gpuSimulationToWorldNode.value.identity();
    }
    this._gpuLocalDirectionNode.value.makeRotationFromQuaternion(effectRotation);
    if (!this._testGPU) this.ensureBakedField();
  }

  protected getGPUWorldToLocalMatrix(): Node<'mat4'> {
    return this._gpuWorldToLocalNode;
  }

  protected getGPULocalToWorldMatrix(): Node<'mat4'> {
    return this._gpuLocalToWorldNode;
  }

  protected getGPUEffectPosition(): Node<'vec3'> {
    return transformPointGPU(vec3(0), this._gpuLocalToSimulationNode);
  }

  protected getGPULocalDirection(direction: Node<'vec3'>): Node<'vec3'> {
    return this._gpuLocalDirectionNode.mul(vec4(direction, 0)).xyz as Node<'vec3'>;
  }

  // If this directly modifies particles and should be picked up by particle systems
  // This will be true for most spatial effects, but not special ones like boid affectors
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

  get supportsParameterizedGPUInfluence(): boolean {
    return this.supportsGPU && !this._hasCustomCondition && !this._hasCustomFeatherEasing;
  }

  /** Whether the effect uses the geometry-backed built-in containment test. */
  get usesBuiltInTest(): boolean {
    return !this._hasCustomTest;
  }

  protected canBatchGPUInfluence(): boolean {
    if (this.inverted) return false;
    switch (this.geometry?.type) {
      case 'BoxGeometry':
      case 'SphereGeometry':
      case 'TorusGeometry':
        return true;
      case 'ConeGeometry':
        return this.feather <= 0;
      default:
        return false;
    }
  }

  protected writeGPUInfluenceParameters(
    target: Float32Array,
    offset: number,
    system: ParticleSystem,
  ): void {
    this.updateWorldMatrix(true, false);
    const simulationToWorld = new THREE.Matrix4();
    if (system.simulationSpace === SimulationSpace.Local) {
      system.updateWorldMatrix(true, false);
      simulationToWorld.copy(system.matrixWorld);
    }
    const matrix = this.matrixWorld.clone().invert().multiply(simulationToWorld);
    const elements = matrix.elements;
    target.set([elements[0], elements[4], elements[8], elements[12]], offset);
    target.set([elements[1], elements[5], elements[9], elements[13]], offset + 4);
    target.set([elements[2], elements[6], elements[10], elements[14]], offset + 8);

    const geometry = this.geometry!;
    const parameters = (geometry as THREE.BufferGeometry & {
      parameters?: Record<string, number>;
    }).parameters ?? {};
    let shape = 0;
    let sizeX = 0;
    let sizeY = 0;
    let sizeZ = 0;
    switch (geometry.type) {
      case 'BoxGeometry':
        shape = SpatialInfluenceShape.Box;
        sizeX = parameters.width ?? 1;
        sizeY = parameters.height ?? 1;
        sizeZ = parameters.depth ?? 1;
        break;
      case 'SphereGeometry':
        shape = SpatialInfluenceShape.Sphere;
        sizeX = parameters.radius ?? 1;
        break;
      case 'ConeGeometry':
        shape = SpatialInfluenceShape.Cone;
        sizeX = parameters.radius ?? 1;
        sizeY = parameters.height ?? 1;
        break;
      case 'TorusGeometry':
        shape = SpatialInfluenceShape.Torus;
        sizeX = parameters.radius ?? 1;
        sizeY = parameters.tube ?? 0.4;
        break;
      default:
        break;
    }
    target[offset + 12] = shape;
    target[offset + 16] = sizeX;
    target[offset + 17] = sizeY;
    target[offset + 18] = sizeZ;
    target[offset + 20] = this.feather;
    target[offset + 21] = this.inverted ? 1 : 0;
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

    const contains = this.containsLocalPosition(this.localParticlePosition);
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

    return this.getLocalFeather(this.localParticlePosition);
  }

  private getLocalFeather(position: THREE.Vector3): number {
    if (!this.geometry) {
      const distance = position.length();
      if (this.inverted) return distance <= Number.EPSILON ? 0 : 1;
      if (this.feather <= 0) return distance <= Number.EPSILON ? 1 : 0;
      return this.easeFeather(1 - distance / this.feather);
    }

    const contains = this.containsLocalPosition(position);

    if (contains) return this.inverted ? 0 : 1;
    if (this.inverted) return 1;
    if (this.feather <= 0) return 0;

    const hit = this.getCurrentBVH().closestPointToPoint(
      position,
      this.closestPointInfo,
      0,
      this.feather,
    );

    if (!hit) return 0;

    this.closestPointInfo = hit;
    return this.easeFeather(1 - hit.distance / this.feather);
  }

  private containsLocalPosition(position: THREE.Vector3): boolean {
    if (!this.geometry) return false;
    if (!this.geometry.boundingBox) this.geometry.computeBoundingBox();
    const diagonal = this.geometry.boundingBox?.getSize(this.geometryBoundsSize).length() ?? 0;
    return isPointInMesh(position, this.getCurrentBVH(), diagonal);
  }

  private getCurrentBVH(): MeshBVH {
    const geometry = this.geometry;
    if (!geometry) throw new Error('A spatial effect without geometry has no BVH.');
    const positionAttribute = geometry.getAttribute('position');
    const topologyKey = `${positionAttribute?.count ?? 0}:${geometry.index?.count ?? 0}:${attributeVersion(geometry.index)}`;
    const positionVersion = attributeVersion(positionAttribute);
    if (!this._bvh || this._bvhGeometry !== geometry || this._bvhTopologyKey !== topologyKey) {
      this._bvh = new MeshBVH(geometry);
      this._bvhGeometry = geometry;
      this._bvhTopologyKey = topologyKey;
      this._bvhPositionVersion = positionVersion;
    } else if (
      this.updatePolicy !== SpatialEffectUpdatePolicy.Static
      && this.updatePolicy !== SpatialEffectUpdatePolicy.TransformDynamic
      && this._bvhPositionVersion !== positionVersion
    ) {
      this._bvh.refit();
      this._bvhPositionVersion = positionVersion;
    }
    return this._bvh;
  }

  testGPU(
    particle: GPUParticleLike,
    context: GPUParticleUpdateContext,
  ): Node<'float'> {
    const rawStrength = this._testGPU
      ? this._testGPU(particle, context, this)
      : this.bakedFieldGPU(particle, context);
    const strength = this._hasCustomFeatherEasing
      ? this.easeFeatherGPU(rawStrength)
      : rawStrength;

    if (!this.conditionGPU) return strength;

    return this.conditionGPU(particle, context, this).select(
      strength,
      float(0),
    ) as Node<'float'>;
  }

  bakedFieldGPU(
    particle: GPUParticleLike,
    context: GPUParticleUpdateContext,
  ): Node<'float'> {
    this.ensureBakedField();

    if (!this._bakedFieldTexture) return float(0);

    const localPosition = this.getGPUParticleLocalPosition(particle, context.system);
    const uv = localPosition
      .sub(this._gpuBakedFieldMinNode)
      .div(this._gpuBakedFieldSizeNode)
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
    particle: GPUParticleLike,
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
    particle: GPUParticleLike,
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

  /** World-space influence bounds, including the feather region. */
  getWorldBounds(target = new THREE.Box3()): THREE.Box3 {
    this.updateWorldMatrix(true, false);
    target.copy(this.getLocalBounds()).applyMatrix4(this.matrixWorld);
    target.expandByScalar(Math.max(this.feather, Number.EPSILON));
    return target;
  }

  protected getGPUParticleWorldPosition(
    particle: GPUParticleLike,
    _particleSystem: ParticleSystem,
  ): Node<'vec3'> {
    return transformPointGPU(particle.position, this._gpuSimulationToWorldNode);
  }

  protected getGPUParticleLocalPosition(
    particle: GPUParticleLike,
    particleSystem: ParticleSystem,
  ): Node<'vec3'> {
    return transformPointGPU(
      this.getGPUParticleWorldPosition(particle, particleSystem),
      this._gpuWorldToLocalNode,
    );
  }

  private ensureBakedField(): void {
    if (!this.geometry && this.feather <= 0) {
      this._bakedFieldTexture = undefined;
      return;
    }

    const geometryKey = this.getGeometryRevisionKey();

    if (
      this._bakedFieldTexture
      && this._bakedFieldGeometry === this.geometry
      && this._bakedFieldFeather === this.feather
      && this._bakedFieldResolution === this.bakedFieldResolution
      && this._bakedFieldGeometryKey === geometryKey
    ) return;

    const bounds = this.getBakedFieldLocalBounds();
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
    this._gpuBakedFieldMinNode.value.copy(this._bakedFieldMin);
    this._gpuBakedFieldSizeNode.value.copy(this._bakedFieldSize);

    let index = 0;
    for (let z = 0; z < resolution; z += 1) {
      for (let y = 0; y < resolution; y += 1) {
        for (let x = 0; x < resolution; x += 1) {
          point.set(
            bounds.min.x + step.x * x,
            bounds.min.y + step.y * y,
            bounds.min.z + step.z * z,
          );
          data[index] = Math.round(THREE.MathUtils.clamp(this.getLocalFeather(point), 0, 1) * 255);
          index += 1;
        }
      }
    }

    if (this._bakedFieldTexture && this._bakedFieldResolution === resolution) {
      this._bakedFieldTexture.image.data = data;
      this._bakedFieldTexture.needsUpdate = true;
    } else {
      this._bakedFieldTexture?.dispose();
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
    }
    this._bakedFieldGeometry = this.geometry;
    this._bakedFieldFeather = this.feather;
    this._bakedFieldResolution = resolution;
    this._bakedFieldGeometryKey = geometryKey;
  }

  private getBakedFieldLocalBounds(): THREE.Box3 {
    if (!this.geometry) {
      const radius = Math.max(this.feather, Number.EPSILON);
      return new THREE.Box3(
        new THREE.Vector3(-radius, -radius, -radius),
        new THREE.Vector3(radius, radius, radius),
      );
    }

    return this.getLocalBounds().clone().expandByScalar(Math.max(this.feather, Number.EPSILON));
  }

  private getGeometryRevisionKey(): string {
    const position = this.geometry?.getAttribute('position');
    const index = this.geometry?.index;
    return [
      this.geometry?.uuid ?? 'point',
      position?.count ?? 0,
      attributeVersion(position),
      index?.count ?? 0,
      attributeVersion(index),
    ].join(':');
  }

  modify(particles: Particle[], deltaTime: number, particleSystem: ParticleSystem): void {
    particles
      .filter((particle) => particle.alive)
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

  private easeFeatherGPU(feather: Node<'float'>): Node<'float'> {
    const resolution = 17;
    const values = Array.from({ length: resolution }, (_, index) => (
      float(this.easeFeather(index / (resolution - 1)))
    ));
    const samples = array(values);
    const position = feather.clamp(0, 1).mul(resolution - 1);
    const lowerPosition = position.floor();
    const lower = samples.element(int(lowerPosition)) as Node<'float'>;
    const upper = samples.element(int(lowerPosition.add(1).min(resolution - 1))) as Node<'float'>;

    return mix(lower, upper, position.sub(lowerPosition)) as Node<'float'>;
  }
}

function transformPointGPU(point: Node<'vec3'>, matrix: Node<'mat4'>): Node<'vec3'> {
  return matrix.mul(vec4(point, 1)).xyz as Node<'vec3'>;
}

function attributeVersion(
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null | undefined,
): number {
  if (!attribute) return -1;
  return 'version' in attribute ? Number(attribute.version) : Number(attribute.data.version ?? 0);
}

export default SpatialEffect;
