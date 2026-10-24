import * as THREE from 'three';
import { StorageBufferAttribute, type Node } from 'three/webgpu';
import EmissionShape from './EmissionShape';
import Particle from './Particle';
import type { InitialParticleValues } from './interfaces/InitialParticleValues';
import evaluateDynamicVector from './helpers/evaluateDynamicVector3';
import evaluateDynamicNumber from './helpers/evaluateDynamicNumber';
import evaluateDynamicColor from './helpers/evaluateDynamicColor';
import acceptMultiple from './helpers/acceptMultiple';
import ParticleSystem from './ParticleSystem';
import type { DynamicUntimedValue, DynamicValue } from './types/DynamicValue';
import type { Multiple, StrictMultiple } from './types/Multiple';
import type { Tag } from './types/Tag';
import { TagSelectionMethod } from './enums/TagSelectionMethod';
import { EmissionSource } from './enums/EmissionSource';
import LODHelper, { type LODSettings } from './LODHelper';
import { getGPUEmitterSupport, type GPUEmissionSupportReport } from './gpu/Emission';
import type { GPUParticleBufferState, GPUParticleLike, GPUParticleUpdateContext } from './gpu/Particle';
import type { GPUEmitterInstanceRuntime } from './gpu/EmitterInstanceBuffer';
import {
  bitAnd,
  bitOr,
  asin,
  atan,
  float,
  hash,
  If,
  instanceIndex,
  int,
  mix,
  cos,
  shiftLeft,
  sin,
  sqrt,
  storage,
  uint,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import {
  GPUDynamicParameterStore,
} from './helpers/evaluateDynamicGPU';
import type { PackedFloatStorage, PackedUintStorage } from './gpu/Storage';

export type SpawnBurst = {
    /** Normalized emission-cycle time, clamped to the range 0 through 1. */
    time: number,
    /** Number of particles emitted when the burst fires. */
    count: DynamicUntimedValue<number>,
    /** Internal CPU emission state; reset automatically with the emitter. */
    fired?: boolean,
};

export interface EmitterOptions {
    /** Dynamic values sampled at birth; mutable values are isolated per particle. */
    initialValues: Partial<InitialParticleValues>;
    /** Geometry and sampling rule used to place particles. Defaults to a sphere. */
    source: EmissionShape;
    /** Timed particle batches within an emission cycle. Supplying bursts changes the default continuous rate to zero. */
    bursts: Multiple<SpawnBurst>;
    /** Continuous particles per second. Defaults to 50 without bursts, otherwise 0. */
    rate: DynamicValue<number>;
    /** Particles per world-space distance traveled by the emission context.
     * @defaultValue 0 */
    rateOverDistance: DynamicValue<number>;

    /** Initial velocity contribution along the sampled source direction.
     * @defaultValue 1 */
    radialSpeed: DynamicValue<number>;
    /** Amount of initial rotation alignment to source direction.
     * @defaultValue 0 */
    alignment: DynamicValue<number>;

    /** Tags assigned at birth, selected using tagSelection. */
    tags: StrictMultiple<Tag>;
    /** Assigns all tags, distributes them, or samples them according to the selected mode. */
    tagSelection: TagSelectionMethod | `${TagSelectionMethod}`;
    /** Enables update skipping; defaults to whether updateLOD is provided. */
    useUpdateLOD: boolean;
    /** Distance-based emission update quality. */
    updateLOD: Partial<LODSettings>;
    /** Distance-based emitted particle count reduction. */
    countLOD: Partial<LODSettings>;
}

interface EmitterContextState {
  startTime: number;
  lastSpawn: number;
  distanceCredit: number;
  lastDistancePosition?: THREE.Vector3;
  firedBursts: Set<number>;
}

export interface EmissionContext {
  /** Stable root or subsystem run identity. */
  key: string;
  transform: THREE.Matrix4;
  position: THREE.Vector3;
  time: number;
  elapsedTime: number;
  duration: number;
  looping: boolean;
  color: THREE.Color;
  alpha: number;
  mass: number;
  distortionStrength: number;
  velocity: THREE.Vector3;
  velocityScale: number;
  scale: number;
  tags: Tag[];
}

/** @internal Context used to construct the built-in GPU birth graph. */
export interface GPUEmitterUpdateContext extends GPUParticleUpdateContext {
  /** Emitter whose birth graph is being constructed. */
  emitter: Emitter;
  /** Emitter position in the owning system's emitter array. */
  emitterIndex: number;
  /** Destination storage for newly allocated particles. */
  output: GPUParticleBufferState;
  emitterRuntime?: GPUEmitterInstanceRuntime;
  durationNode?: Node<'float'>;
  normalizedTimeNode?: Node<'float'>;
  emitterPositionNode?: Node<'vec3'>;
  parentParticle?: GPUParticleLike;
  resolveParentParticle?: (claimIndex: Node<'uint'>) => GPUParticleLike;
  resolveEmissionTime?: (claimIndex: Node<'uint'>) => Node<'float'>;
  resolveImpulseEffects?: (claimIndex: Node<'uint'>) => {
    scale: Node<'float'>;
    speed: Node<'float'>;
    mass: Node<'float'>;
    alignmentDirection?: Node<'vec3'>;
  };
  inheritance?: {
    color: number;
    alpha: number;
    mass: number;
    velocity: number;
    scale: number;
  };
  tagMasks?: number[];
  reclaimOld?: boolean;
}

/** @internal */
export type GPUEmitterUpdate = (context: GPUEmitterUpdateContext) => void;

/** Samples particle births from a shape using time, distance, and burst emission. */
class Emitter {
  source: EmissionShape;
  rate: DynamicValue<number>;
  rateOverDistance: DynamicValue<number>;

  bursts: SpawnBurst[];
  initialValues: Partial<InitialParticleValues>;
  radialSpeed: DynamicValue<number>;
  alignment: DynamicValue<number>;

  tags?: Tag[];
  tagSelection: TagSelectionMethod = TagSelectionMethod.All;
  useUpdateLOD: boolean;
  updateLOD?: Partial<LODSettings>;
  countLOD?: Partial<LODSettings>;
  private _lodHelper: LODHelper;
  private _countLODHelper: LODHelper;
  private readonly _gpuUpdateLODScale = uniform(1, 'float');
  private readonly _gpuCountLODScale = uniform(1, 'float');
  private readonly _gpuSourceMatrix = uniform(new THREE.Matrix4(), 'mat4') as Node<'mat4'> & {
    value: THREE.Matrix4;
  };
  private _distancePosition = new THREE.Vector3();
  private readonly _gpuParameters = new GPUDynamicParameterStore();
  private _gpuParameterVersion = 0;
  private _gpuVersion = 0;
  private _gpuStructureSignature = '';
  private _gpuSource?: EmissionShape;
  private _gpuGeometry?: THREE.BufferGeometry;
  private _gpuGeometrySampling?: {
    signature: string;
    vectors: StorageBufferAttribute;
    triangles: StorageBufferAttribute;
    vertexCount: number;
    triangleCount: number;
  };
  private _gpuVolumeSampling?: {
    signature: string;
    vectors: StorageBufferAttribute;
    count: number;
  };

  private _lastTagIndex: number = 0;

  // Used for subsystems
  private _contextStates = new Map<string, EmitterContextState>();

  /** Monotonic GPU configuration version used to invalidate compiled work. */
  get version(): number {
    return this._gpuVersion;
  }

  get gpuParameterUploadCount(): number {
    return this._gpuParameters.uploadCount;
  }

  set needsUpdate(value: boolean) {
    if (value) this._gpuVersion += 1;
  }

  /** Creates emission state; bursts default the continuous rate to zero. */
  constructor(
    options: Partial<EmitterOptions> = {},
  ) {
    this.source = options.source ?? EmissionShape.Sphere();
    this.initialValues = options.initialValues ?? {};

    this.bursts = acceptMultiple(options.bursts) ?? [];
    this.normalizeBurstTimes();
    this.rate = options.rate ?? (this.bursts.length > 0 ? 0 : 50);
    this.rateOverDistance = options.rateOverDistance ?? 0;

    this.radialSpeed = options.radialSpeed ?? 1
    this.alignment = options.alignment ?? 0;

    this.tags = acceptMultiple(options.tags);
    this.tagSelection = (options.tagSelection as TagSelectionMethod) ?? this.tagSelection;
    this.updateLOD = options.updateLOD;
    this.useUpdateLOD = options.useUpdateLOD ?? Boolean(this.updateLOD);
    this.countLOD = options.countLOD;
    this._lodHelper = new LODHelper(this.updateLOD);
    this._countLODHelper = new LODHelper(this.countLOD);
  }

  /*
    * CONTROLS
  */

  /** Clears timed bursts, movement credit, LOD state, and per-context emission clocks. */
  public reset(): void {
    this.bursts.forEach((burst) => {
      burst.fired = false;
    });

    this._contextStates.clear();
    this._lodHelper.reset();
    this._countLODHelper.reset();
  }

  /** Whether the current source and emission configuration support GPU-native births. */
  get supportsGPUEmission(): boolean {
    return this.getGPUEmissionSupport().supported;
  }

  /** Returns feature and incompatibility details for GPU-native emission. */
  getGPUEmissionSupport(): GPUEmissionSupportReport {
    return getGPUEmitterSupport(this);
  }

  /** Synchronizes runtime values and invalidates structural GPU changes. */
  syncGPUConfiguration(): void {
    this.normalizeBurstTimes();
    this._lodHelper.configure(this.updateLOD);
    this._countLODHelper.configure(this.countLOD);
    this._gpuParameters.sync();
    if (this._gpuParameters.version !== this._gpuParameterVersion) {
      this._gpuParameterVersion = this._gpuParameters.version;
      this._gpuVersion += 1;
    }

    const geometry = this.source.geometry;
    const structureSignature = [
      this.source.source,
      this.source.version,
      geometry.type,
      geometry.getAttribute('position')?.count ?? 0,
      getGeometryAttributeVersion(geometry.getAttribute('position')),
      getGeometryAttributeVersion(geometry.getAttribute('normal')),
      geometry.index?.count ?? 0,
      geometry.index?.version ?? 0,
      this.bursts.length,
      getDynamicStructure(this.rate),
      getDynamicStructure(this.rateOverDistance),
      getDynamicStructure(this.radialSpeed),
      getDynamicStructure(this.alignment),
      ...this.bursts.map((burst) => getDynamicStructure(burst.count)),
      ...Object.keys(this.initialValues).sort().map((key) => (
        `${key}:${getDynamicStructure(this.initialValues[key as keyof InitialParticleValues])}`
      )),
      this.tags?.length ?? 0,
      this.tagSelection,
      this.initialValues.rotation === undefined ? 'aligned-rotation' : 'explicit-rotation',
    ].join('|');
    if (
      this._gpuStructureSignature
      && (
        structureSignature !== this._gpuStructureSignature
        || this.source !== this._gpuSource
        || geometry !== this._gpuGeometry
      )
    ) this._gpuVersion += 1;

    this._gpuStructureSignature = structureSignature;
    this._gpuSource = this.source;
    this._gpuGeometry = geometry;
  }

  /** @internal Builds the standard TSL birth writer used by ParticleSystem. */
  createBuiltInGPUUpdate(): GPUEmitterUpdate {
    const volumeSampling = this.source.source === EmissionSource.Volume
      ? this.getGPUVolumeSampling()
      : undefined;
    const sampledVectors = volumeSampling
      ? storage(volumeSampling.vectors, 'vec4', volumeSampling.count * 3) as PackedFloatStorage
      : undefined;
    const geometrySampling = this.source.source === EmissionSource.Volume
      ? undefined
      : this.getGPUGeometrySampling();
    const geometryVectors = geometrySampling
      ? storage(
        geometrySampling.vectors,
        'vec4',
        geometrySampling.vertexCount * 2,
      ) as PackedFloatStorage
      : undefined;
    const geometryTriangles = geometrySampling
      ? storage(
        geometrySampling.triangles,
        'uvec4',
        Math.max(geometrySampling.triangleCount * 2, 1),
      ) as PackedUintStorage
      : undefined;
    return (context) => {
      const particle = context.output.storage.createParticle(undefined, true);
      const runtime = context.emitterRuntime;
      if (!runtime) return;
      const requested = runtime.requestCount();

      const initializeParticle = (claimIndex: Node<'uint'>) => {
        const seed = instanceIndex.add(particle.generation.mul(65537))
          .add(uint(context.emitterIndex * 4099));
        let sampledPosition: Node<'vec3'>;
        let sampledNormal: Node<'vec3'>;
        if (this.source.source === EmissionSource.Vertices && geometrySampling) {
          const vertexIndex = int(hash(seed.add(43)).mul(geometrySampling.vertexCount).floor());
          sampledPosition = geometryVectors!.element(vertexIndex).xyz as Node<'vec3'>;
          sampledNormal = geometryVectors!.element(
            vertexIndex.add(geometrySampling.vertexCount),
          ).xyz.normalize() as Node<'vec3'>;
        } else if (this.source.source === EmissionSource.Surface && geometrySampling) {
          const selectorIndex = int(hash(seed.add(43)).mul(geometrySampling.triangleCount).floor());
          const selector = geometryTriangles!.element(selectorIndex.mul(2));
          const selectorThreshold = geometryTriangles!.element(selectorIndex.mul(2).add(1)).x;
          const triangleIndex = uint(hash(seed.add(61)).mul(0xffffffff)).lessThan(selectorThreshold).select(
            uint(selectorIndex),
            selector.w,
          );
          const triangle = geometryTriangles!.element(triangleIndex.mul(2));
          const point0 = geometryVectors!.element(triangle.x).xyz;
          const point1 = geometryVectors!.element(triangle.y).xyz;
          const point2 = geometryVectors!.element(triangle.z).xyz;
          const root = sqrt(hash(seed.add(47)));
          const weight0 = float(1).sub(root);
          const weight1 = root.mul(float(1).sub(hash(seed.add(53))));
          const weight2 = root.sub(weight1);
          sampledPosition = point0.mul(weight0).add(point1.mul(weight1)).add(point2.mul(weight2)) as Node<'vec3'>;
          sampledNormal = geometryVectors!.element(triangle.x.add(geometrySampling.vertexCount)).xyz.mul(weight0)
            .add(geometryVectors!.element(triangle.y.add(geometrySampling.vertexCount)).xyz.mul(weight1))
            .add(geometryVectors!.element(triangle.z.add(geometrySampling.vertexCount)).xyz.mul(weight2))
            .normalize() as Node<'vec3'>;
        } else {
          const sampleIndex = int(hash(seed.add(43)).mul(volumeSampling!.count).floor());
          const sample = sampledVectors!.element(sampleIndex);
          const z = hash(seed.add(47)).mul(2).sub(1);
          const angle = hash(seed.add(53)).mul(Math.PI * 2);
          const radial = sqrt(float(1).sub(z.mul(z)));
          const direction = vec3(cos(angle).mul(radial), sin(angle).mul(radial), z);
          sampledPosition = sample.xyz.add(direction.mul(hash(seed.add(59)).mul(sample.w))) as Node<'vec3'>;
          const normalOffset = int(volumeSampling!.count).add(sampleIndex.mul(2));
          const neighborRecord = sampledVectors!.element(normalOffset.add(1));
          const anchorNormal = sampledVectors!.element(normalOffset).xyz;
          const blendedNormal = vec3(0).toVar('volumeSampleNormal');
          const totalWeight = float(0).toVar('volumeSampleNormalWeight');
          [sampleIndex, int(neighborRecord.x), int(neighborRecord.y), int(neighborRecord.z)]
            .forEach((neighborIndex) => {
              const neighborPosition = sampledVectors!.element(neighborIndex).xyz;
              const delta = sampledPosition.sub(neighborPosition);
              const weight = float(1).div(delta.dot(delta).max(float(1e-8)));
              blendedNormal.addAssign(
                sampledVectors!.element(
                  int(volumeSampling!.count).add(neighborIndex.mul(2)),
                ).xyz.mul(weight),
              );
              totalWeight.addAssign(weight);
            });
          sampledNormal = blendedNormal.length().greaterThan(float(Number.EPSILON)).select(
            blendedNormal.div(totalWeight.max(float(Number.EPSILON))).normalize(),
            anchorNormal,
          ) as Node<'vec3'>;
        }
        const localPosition = transformPointGPU(sampledPosition, this._gpuSourceMatrix);
        const normal = transformDirectionGPU(sampledNormal, this._gpuSourceMatrix).normalize();
        const time = context.resolveEmissionTime?.(claimIndex)
          ?? context.elapsedTimeNode.div(float(Math.max(context.system.duration, Number.EPSILON)));
        const initialPosition = this._gpuParameters.vector(
          'initial.position',
          () => this.initialValues.position,
          time,
          new THREE.Vector3(),
          seed.add(53),
        );
        const inheritance = context.inheritance;
        const parent = context.resolveParentParticle?.(claimIndex) ?? context.parentParticle;
        const impulseEffects = context.resolveImpulseEffects?.(claimIndex);
        const inheritedTransformScale = parent && inheritance && inheritance.scale > 0
          ? mix(vec3(1, 1, 1), parent.scale, inheritance.scale)
          : vec3(1, 1, 1);
        const parentLocalPosition = localPosition.add(initialPosition).mul(inheritedTransformScale);
        const rotatedPosition = parent && impulseEffects?.alignmentDirection
          ? impulseEffects.alignmentDirection.length().greaterThan(float(0)).select(
            rotateFromYGPU(parentLocalPosition, impulseEffects.alignmentDirection),
            rotateEulerYXZGPU(parentLocalPosition, parent.rotation),
          ) as Node<'vec3'>
          : parent
            ? rotateEulerYXZGPU(parentLocalPosition, parent.rotation)
            : parentLocalPosition;
        const rotatedNormal = parent && impulseEffects?.alignmentDirection
          ? impulseEffects.alignmentDirection.length().greaterThan(float(0)).select(
            rotateFromYGPU(normal, impulseEffects.alignmentDirection),
            rotateEulerYXZGPU(normal, parent.rotation),
          ) as Node<'vec3'>
          : parent
            ? rotateEulerYXZGPU(normal, parent.rotation)
            : normal;
        const emissionPosition = parent
          ? rotatedPosition.add(parent.position)
          : parentLocalPosition.add(context.emitterPositionNode ?? vec3(0, 0, 0));
        const emissionNormal = rotatedNormal.normalize();
        const initialVelocity = this._gpuParameters.vector(
          'initial.velocity',
          () => this.initialValues.velocity,
          time,
          new THREE.Vector3(),
          seed.add(59),
        );
        const alignment = this._gpuParameters.number(
          'alignment', () => this.alignment, time, 0, seed.add(61),
        ).clamp(0, 1);
        const alignedRotation = vec3(
          asin(emissionNormal.y.clamp(-1, 1)).negate(),
          atan(emissionNormal.x, emissionNormal.z),
          0,
        ).mul(alignment);
        const initialRotation = this.initialValues.rotation === undefined
          ? alignedRotation
          : this._gpuParameters.vector(
            'initial.rotation',
            () => this.initialValues.rotation,
            time,
            new THREE.Vector3(),
            seed.add(61),
          );
        const initialScale = this._gpuParameters.vector(
          'initial.scale',
          () => this.initialValues.scale,
          time,
          new THREE.Vector3(1, 1, 1),
          seed.add(67),
        );
        const initialAngularVelocity = this._gpuParameters.vector(
          'initial.angularVelocity',
          () => this.initialValues.angularVelocity,
          time,
          new THREE.Vector3(),
          seed.add(71),
        );
        const initialScalarVelocity = this._gpuParameters.vector(
          'initial.scalarVelocity',
          () => this.initialValues.scalarVelocity,
          time,
          new THREE.Vector3(),
          seed.add(73),
        );
        const initialAcceleration = this._gpuParameters.vector(
          'initial.acceleration',
          () => this.initialValues.acceleration,
          time,
          new THREE.Vector3(),
          seed.add(79),
        );
        const initialAngularAcceleration = this._gpuParameters.vector(
          'initial.angularAcceleration',
          () => this.initialValues.angularAcceleration,
          time,
          new THREE.Vector3(),
          seed.add(83),
        );
        const initialScalarAcceleration = this._gpuParameters.vector(
          'initial.scalarAcceleration',
          () => this.initialValues.scalarAcceleration,
          time,
          new THREE.Vector3(),
          seed.add(89),
        );
        const initialColor = this._gpuParameters.color(
          'initial.color',
          () => this.initialValues.color,
          time,
          new THREE.Color(1, 1, 1),
          seed.add(97),
        );
        const initialSpeed = this._gpuParameters.number(
          'initial.speed', () => this.initialValues.speed, time, 1, seed.add(101),
        );
        const initialAlpha = this._gpuParameters.number(
          'initial.alpha', () => this.initialValues.alpha, time, 1, seed.add(103),
        );
        const initialMass = this._gpuParameters.number(
          'initial.mass', () => this.initialValues.mass, time, 0, seed.add(107),
        );
        const initialDistortion = this._gpuParameters.number(
          'initial.distortionStrength',
          () => this.initialValues.distortionStrength,
          time,
          1,
          seed.add(109),
        );
        const initialLifetime = this._gpuParameters.number(
          'initial.lifetime', () => this.initialValues.lifetime, time, 1, seed.add(113),
        );
        const radialSpeed = this._gpuParameters.number(
          'radialSpeed', () => this.radialSpeed, time, 0, seed.add(127),
        );

        const inheritedColor = parent && inheritance && inheritance.color > 0
          ? mix(vec3(1, 1, 1), parent.color, inheritance.color)
          : vec3(1, 1, 1);
        const inheritedAlpha = parent && inheritance && inheritance.alpha > 0
          ? mix(float(1), parent.alpha, inheritance.alpha)
          : float(1);
        const inheritedMass = parent && inheritance && inheritance.mass > 0
          ? mix(float(1), parent.mass, inheritance.mass)
          : float(1);
        const inheritedVelocity = parent && inheritance && inheritance.velocity > 0
          ? parent.velocity.mul(inheritance.velocity)
          : vec3(0, 0, 0);

        particle.position.assign(emissionPosition);
        particle.orbitCenter.assign(vec3(0, 0, 0));
        particle.rotation.assign(initialRotation);
        particle.scale.assign(initialScale.mul(impulseEffects?.scale ?? float(1)));
        particle.velocity.assign(
          initialVelocity.add(emissionNormal.mul(radialSpeed))
            .mul(impulseEffects?.speed ?? float(1))
            .add(inheritedVelocity),
        );
        particle.angularVelocity.assign(initialAngularVelocity);
        particle.scalarVelocity.assign(initialScalarVelocity);
        particle.acceleration.assign(initialAcceleration);
        particle.angularAcceleration.assign(initialAngularAcceleration);
        particle.scalarAcceleration.assign(initialScalarAcceleration);
        particle.color.assign(initialColor.mul(inheritedColor));
        particle.speed.assign(initialSpeed);
        particle.alpha.assign(initialAlpha.mul(inheritedAlpha));
        particle.mass.assign(initialMass.mul(inheritedMass).mul(impulseEffects?.mass ?? float(1)));
        particle.distortionStrength.assign(initialDistortion);
        particle.lifetime.assign(initialLifetime);
        particle.time.assign(float(0));
        particle.realtime.assign(float(0));
        const tagMasks = context.tagMasks ?? [];
        if (
          (this.tagSelection === TagSelectionMethod.Random
            || this.tagSelection === TagSelectionMethod.Distribute)
          && tagMasks.length > 0
        ) {
          const selectedTag = this.tagSelection === TagSelectionMethod.Random
            ? int(hash(seed.add(137)).mul(tagMasks.length).floor())
            : int(claimIndex.mod(tagMasks.length));
          const tagMask = tagMasks.reduce<Node<'uint'>>((result, value, index) => (
            selectedTag.equal(index).select(uint(value), result) as Node<'uint'>
          ), uint(0));
          particle.tagMask.assign(tagMask);
        } else {
          particle.tagMask.assign(uint(tagMasks.reduce((mask, value) => mask | value, 0)));
        }
        if (parent) particle.tagMask.assign(bitOr(particle.tagMask, parent.tagMask));
        context.allocationWriter?.markSpawned(particle);
      };

      if (context.reclaimOld) {
        const deadClaims = runtime.claimCount();
        const successfulDeadClaims = deadClaims.lessThan(requested)
          .select(deadClaims, requested) as Node<'uint'>;
        context.allocationWriter?.claimOldSlotForEmitter(
          particle,
          (replacementIndex) => {
            initializeParticle(successfulDeadClaims.add(replacementIndex));
          },
        );
      } else {
        context.allocationWriter?.claimDeadSlotForEmitter(
          particle,
          requested,
          () => runtime.claimRequest(),
          initializeParticle,
        );
      }

      context.output.storage.storeParticle(particle);
    };
  }

  /** @internal Prepares request counts for the built-in GPU birth graph. */
  prepareBuiltInGPUEmission(context: GPUEmitterUpdateContext): void {
    const runtime = context.emitterRuntime;
    if (!runtime) return;

    const elapsedTime = context.elapsedTimeNode;
    const duration = context.durationNode ?? float(Math.max(context.system.duration, Number.EPSILON));
    const normalizedTime = context.normalizedTimeNode
      ?? elapsedTime.div(duration.max(float(Number.EPSILON)));
    const requestCount = runtime.pendingRequestCount().toVar('emitterRequestCount');
    const shouldUpdate = uint(1).toVar('emitterShouldUpdate');
    const lodCreditScale = 1_000_000;
    if (this.useUpdateLOD) {
      const credit = runtime.burstState.w;
      const increment = uint(this._gpuUpdateLODScale.mul(lodCreditScale).round());
      If(runtime.identity.x.equal(uint(0)), () => {
        runtime.burstState.w.assign(increment);
      }).ElseIf(credit.greaterThanEqual(uint(lodCreditScale)), () => {
        runtime.burstState.w.assign(credit.sub(uint(lodCreditScale)).add(increment));
      }).Else(() => {
        shouldUpdate.assign(uint(0));
        runtime.burstState.w.assign(credit.add(increment));
      });
    }
    const resetContext = runtime.identity.x.equal(uint(0))
      .or(elapsedTime.lessThan(runtime.timing.w))
      .toVar('resetEmitterContext');

    If(shouldUpdate.notEqual(uint(0)), () => {
      If(resetContext, () => {
        requestCount.assign(uint(0));
        runtime.setPendingRequestCount(0);
        runtime.identity.x.assign(uint(1));
        runtime.timing.x.assign(elapsedTime);
        runtime.timing.y.assign(elapsedTime);
        runtime.timing.z.assign(float(0));
        runtime.distance.xyz.assign(context.emitterPositionNode ?? vec3(0, 0, 0));
        for (let wordIndex = 0; wordIndex < Math.ceil(this.bursts.length / 32); wordIndex += 1) {
          runtime.firedBurstWord(wordIndex).assign(uint(0));
        }
      }).Else(() => {
        const rate = this._gpuParameters.number(
          'rate', () => this.rate, normalizedTime, 0, uint(context.emitterIndex * 4099),
        )
          .mul(this._gpuCountLODScale);
        If(rate.greaterThan(float(0)), () => {
          const emissionCredit = elapsedTime.sub(runtime.timing.y).mul(rate);
          const due = emissionCredit.floor();
          requestCount.addAssign(uint(due));
          If(due.greaterThan(float(0)), () => {
            runtime.timing.y.addAssign(due.div(rate));
          });
        }).Else(() => {
          runtime.timing.y.assign(elapsedTime);
        });
      });

      const rateOverDistance = this._gpuParameters.number(
        'rateOverDistance',
        () => this.rateOverDistance,
        normalizedTime,
        0,
        uint(context.emitterIndex * 6151),
      ).mul(this._gpuCountLODScale);
      if (context.emitterPositionNode) {
        const emitterPosition = context.emitterPositionNode;
        If(resetContext.not().and(rateOverDistance.greaterThan(float(0))), () => {
          const distanceCredit = runtime.timing.z.add(
            runtime.distance.xyz.distance(emitterPosition).mul(rateOverDistance),
          );
          const distanceDue = distanceCredit.floor();
          requestCount.addAssign(uint(distanceDue));
          runtime.timing.z.assign(distanceCredit.sub(distanceDue));
          runtime.distance.xyz.assign(emitterPosition);
        }).Else(() => {
          runtime.distance.xyz.assign(emitterPosition);
          If(rateOverDistance.lessThanEqual(float(0)), () => runtime.timing.z.assign(float(0)));
        });
      }

      this.bursts.forEach((burst, burstIndex) => {
        const burstWord = runtime.firedBurstWord(Math.floor(burstIndex / 32));
        const bit = shiftLeft(uint(1), uint(burstIndex % 32));
        const hasFired = bitAnd(burstWord, bit).notEqual(uint(0));
        const burstTime = this._gpuParameters.number(
          `burst.${burstIndex}.time`, () => this.bursts[burstIndex]?.time, normalizedTime, 0,
        );
        If(hasFired.not().and(normalizedTime.greaterThanEqual(burstTime)), () => {
          requestCount.addAssign(uint(
            this._gpuParameters.number(
              `burst.${burstIndex}.count`,
              () => this.bursts[burstIndex]?.count,
              normalizedTime,
              0,
              uint(context.emitterIndex * 4099 + burstIndex * 131),
            ).mul(this._gpuCountLODScale).floor(),
          ));
          burstWord.assign(bitOr(burstWord, bit));
        });
      });
    });

    runtime.timing.w.assign(elapsedTime);
    runtime.resetRequestCount(requestCount);
  }

  updateGPULOD(cameraDistance: number): void {
    this.source.updateMatrix();
    this._gpuSourceMatrix.value.copy(this.source.matrix);
    this._gpuUpdateLODScale.value = this.useUpdateLOD
      ? this._lodHelper.getScale(cameraDistance)
      : 1;
    this._gpuCountLODScale.value = this.countLOD
      ? this._countLODHelper.getScale(cameraDistance)
      : 1;
  }

  private getGPUVolumeSampling(): NonNullable<Emitter['_gpuVolumeSampling']> {
    const geometry = this.source.geometry;
    const samples = this.source.getVolumeSamples();
    const signature = [
      this.source.version,
      samples.length,
      getGeometryAttributeVersion(geometry.getAttribute('position')),
      geometry.index?.version ?? 0,
    ].join(':');
    if (this._gpuVolumeSampling?.signature === signature) return this._gpuVolumeSampling;

    this._gpuVolumeSampling?.vectors.dispose();
    // Positions, normals, and neighbor records share one vec4 storage binding.
    const vectors = new Float32Array(samples.length * 12);
    samples.forEach((sample, index) => {
      const positionOffset = index * 4;
      const normalOffset = samples.length * 4 + index * 8;
      vectors.set(
        [sample.position.x, sample.position.y, sample.position.z, sample.radius],
        positionOffset,
      );
      const neighbors = Array.from({ length: 3 }, (_, neighborIndex) => (
        sample.neighbors?.[neighborIndex] ?? index
      ));
      vectors.set([sample.normal.x, sample.normal.y, sample.normal.z, 0], normalOffset);
      vectors.set([...neighbors, 0], normalOffset + 4);
    });
    this._gpuVolumeSampling = {
      signature,
      vectors: new StorageBufferAttribute(vectors, 4),
      count: samples.length,
    };
    return this._gpuVolumeSampling;
  }

  private getGPUGeometrySampling(): NonNullable<Emitter['_gpuGeometrySampling']> {
    const geometry = this.source.geometry;
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const signature = [
      this.source.version,
      position.count,
      getGeometryAttributeVersion(position),
      getGeometryAttributeVersion(normal),
      geometry.index?.count ?? 0,
      geometry.index?.version ?? 0,
    ].join(':');
    if (this._gpuGeometrySampling?.signature === signature) return this._gpuGeometrySampling;

    this._gpuGeometrySampling?.vectors.dispose();
    this._gpuGeometrySampling?.triangles.dispose();

    // Position and normal regions share one vec4 storage binding. Triangle
    // indices remain uint storage because TSL storage bindings are homogeneous.
    const vectors = new Float32Array(position.count * 8);
    for (let index = 0; index < position.count; index += 1) {
      const positionOffset = index * 4;
      const normalOffset = (position.count + index) * 4;
      vectors[positionOffset] = position.getX(index);
      vectors[positionOffset + 1] = position.getY(index);
      vectors[positionOffset + 2] = position.getZ(index);
      vectors[normalOffset] = normal?.getX(index) ?? 0;
      vectors[normalOffset + 1] = normal?.getY(index) ?? 1;
      vectors[normalOffset + 2] = normal?.getZ(index) ?? 0;
    }

    const triangleCount = geometry.index
      ? Math.floor(geometry.index.count / 3)
      : Math.floor(position.count / 3);
    // Two uvec4 records per triangle keep vertex indices and alias metadata in
    // one storage binding: [a,b,c,alias], [probabilityThreshold,0,0,0].
    const triangles = new Uint32Array(Math.max(triangleCount * 2, 1) * 4);
    const triangleAreas = new Float32Array(Math.max(triangleCount, 1));
    const point0 = new THREE.Vector3();
    const point1 = new THREE.Vector3();
    const point2 = new THREE.Vector3();
    const triangle = new THREE.Triangle();
    for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
      const offset = triangleIndex * 8;
      triangles[offset] = geometry.index?.getX(triangleIndex * 3) ?? triangleIndex * 3;
      triangles[offset + 1] = geometry.index?.getX(triangleIndex * 3 + 1) ?? triangleIndex * 3 + 1;
      triangles[offset + 2] = geometry.index?.getX(triangleIndex * 3 + 2) ?? triangleIndex * 3 + 2;
      point0.fromBufferAttribute(position, triangles[offset]);
      point1.fromBufferAttribute(position, triangles[offset + 1]);
      point2.fromBufferAttribute(position, triangles[offset + 2]);
      triangleAreas[triangleIndex] = triangle.set(point0, point1, point2).getArea();
    }

    // Walker's alias table gives area-weighted triangle selection in O(1) on the GPU.
    const totalArea = triangleAreas.reduce((sum, area) => sum + area, 0);
    if (triangleCount > 0 && totalArea > 0) {
      const scaledAreas = Array.from(
        triangleAreas.subarray(0, triangleCount),
        (area) => area * triangleCount / totalArea,
      );
      const small: number[] = [];
      const large: number[] = [];
      scaledAreas.forEach((area, index) => (area < 1 ? small : large).push(index));
      while (small.length > 0 && large.length > 0) {
        const smallIndex = small.pop()!;
        const largeIndex = large.pop()!;
        triangles[smallIndex * 8 + 3] = largeIndex;
        triangles[smallIndex * 8 + 4] = Math.round(scaledAreas[smallIndex] * 0xffffffff);
        scaledAreas[largeIndex] -= 1 - scaledAreas[smallIndex];
        (scaledAreas[largeIndex] < 1 ? small : large).push(largeIndex);
      }
      [...small, ...large].forEach((index) => {
        triangles[index * 8 + 3] = index;
        triangles[index * 8 + 4] = 0xffffffff;
      });
    } else {
      triangles[4] = 0xffffffff;
    }

    this._gpuGeometrySampling = {
      signature,
      vectors: new StorageBufferAttribute(vectors, 4),
      triangles: new StorageBufferAttribute(triangles, 4),
      vertexCount: position.count,
      triangleCount,
    };
    return this._gpuGeometrySampling;
  }

  /*
    * SIMULATION
  */

  /** Attaches the source shape to the particle system. */
  setup(particleSystem: ParticleSystem) {
    particleSystem.add(this.source);
  }

  /** Emits births for the supplied simulation context and returns the newly created particles. */
  update(
    particles: Particle[],
    context: Partial<EmissionContext>,
    particleSystem: ParticleSystem,
  ): Particle[] {
    this.normalizeBurstTimes();
    if (
      this.useUpdateLOD
      && !this._lodHelper.shouldUpdate(Math.sqrt(particleSystem.cameraDistanceSq))
    ) return [];

    const now = Date.now();
    const elapsedMilliseconds = context.elapsedTime === undefined
      ? undefined
      : context.elapsedTime * 1000;
    const state = this.getContextState(context.key ?? '__default', elapsedMilliseconds ?? now);
    const duration = context.duration ?? particleSystem.duration;
    const elapsedTime = context.elapsedTime ?? ((now - state.startTime) / 1000);
    const time = context.time ?? (duration <= 0 ? 1 : elapsedTime / duration);
    const looping = context.looping ?? particleSystem.looping;
    const spawned: Particle[] = [];

    if (context.time === undefined && elapsedTime >= duration) {
      if (!looping) return spawned;

      state.startTime = now;
      state.lastSpawn = now;
      state.distanceCredit = 0;
      state.lastDistancePosition = undefined;
      state.firedBursts.clear();

      return spawned;
    }

    const emissionMultiplier = this.countLOD
      ? this._countLODHelper.getScale(Math.sqrt(particleSystem.cameraDistanceSq))
      : 1;
    const rate = evaluateDynamicNumber(this.rate, time) * emissionMultiplier;
    if (rate > 0) {
      const secondsPerParticle = 1000 / rate;
      const spawnClock = elapsedMilliseconds ?? now;
      const particlesDue = Math.floor((spawnClock - state.lastSpawn) / secondsPerParticle);

      for (let i = 0; i < particlesDue; i += 1) {
        const particle = this.spawnParticle(particles, time, context, particleSystem);

        if (particle) spawned.push(particle);
      }

      if (particlesDue > 0) {
        state.lastSpawn = spawnClock;
      }
    }

    const rateOverDistance = evaluateDynamicNumber(this.rateOverDistance, time) * emissionMultiplier;
    const distancePosition = this._getDistancePosition(context);
    if (rateOverDistance > 0 && distancePosition) {
      if (!state.lastDistancePosition) {
        state.lastDistancePosition = distancePosition.clone();
      } else {
        state.distanceCredit += state.lastDistancePosition.distanceTo(distancePosition) * rateOverDistance;
        state.lastDistancePosition.copy(distancePosition);
      }

      const particlesDue = Math.floor(state.distanceCredit);
      if (particlesDue > 0) {
        state.distanceCredit -= particlesDue;

        for (let i = 0; i < particlesDue; i += 1) {
          const particle = this.spawnParticle(particles, time, context, particleSystem);
          if (particle) spawned.push(particle);
        }
      }
    } else if (distancePosition && state.lastDistancePosition) {
      state.lastDistancePosition.copy(distancePosition);
      state.distanceCredit = 0;
    }

    this.bursts.forEach((burst, index) => {
      if (!state.firedBursts.has(index) && burst.time <= time) {
        const count = evaluateDynamicNumber(burst.count) * emissionMultiplier;
        for (let i = 0; i < Math.floor(count); i += 1) {
          const particle = this.spawnParticle(particles, time, context, particleSystem);
          if (particle) spawned.push(particle);
        }
        state.firedBursts.add(index);
      }
    });

    return spawned;
  }

  private normalizeBurstTimes(): void {
    this.bursts.forEach((burst) => {
      burst.time = Number.isNaN(burst.time)
        ? 0
        : THREE.MathUtils.clamp(burst.time, 0, 1);
    });
  }

  clearContext(key: string) {
    this._contextStates.delete(key);
  }

  private getContextState(key: string, startTime: number): EmitterContextState {
    let state = this._contextStates.get(key);
    if (!state) {
      state = {
        startTime,
        lastSpawn: startTime,
        distanceCredit: 0,
        firedBursts: new Set<number>(),
      };
      this._contextStates.set(key, state);
    }
    return state;
  }

  private _getDistancePosition(context: Partial<EmissionContext>): THREE.Vector3 | undefined {
    if (context.position) return context.position;
    if (!context.transform) return undefined;
    return this._distancePosition.setFromMatrixPosition(context.transform);
  }

  private spawnParticle(
    particles: Particle[],
    time: number,
    context: Partial<EmissionContext>,
    particleSystem: ParticleSystem,
  ): Particle | undefined {
    const point = this.source.getPoint();
    const position = point.position.clone().add(
      evaluateDynamicVector(this.initialValues.position ?? new THREE.Vector3(), time),
    );
    const orbitCenter = new THREE.Vector3();
    const normal = point.normal.clone();

    if (context.transform) {
      position.applyMatrix4(context.transform);
      orbitCenter.applyMatrix4(context.transform);
      normal.applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(context.transform)).normalize();
    }

    const defaultRotationQuat = (new THREE.Quaternion).setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      normal
    );
    const defaultRotationEuler = new THREE.Euler().setFromQuaternion(defaultRotationQuat, 'YXZ');
    const defaultRotation = new THREE.Vector3(
      defaultRotationEuler.x,
      defaultRotationEuler.y,
      defaultRotationEuler.z
    );
    const rotation = new THREE.Vector3(0, 0, 0).lerp(
      defaultRotation,
      Math.max(Math.min(evaluateDynamicNumber(this.alignment, time), 1), 0),
    );

    const color = evaluateDynamicColor(this.initialValues.color ?? new THREE.Color(1, 1, 1), time);
    if (context.color) {
      color.multiply(context.color);
    }

    let alpha = evaluateDynamicNumber(this.initialValues.alpha ?? 1, time);
    if (context.alpha !== undefined) {
      alpha *= context.alpha
    }

    let mass = evaluateDynamicNumber(this.initialValues.mass ?? 0, time);
    if (context.mass !== undefined) {
      mass *= context.mass;
    }

    let distortionStrength = evaluateDynamicNumber(this.initialValues.distortionStrength ?? 1, time);
    if (context.distortionStrength !== undefined) {
      distortionStrength *= context.distortionStrength;
    }

    const scale = evaluateDynamicVector(this.initialValues.scale ?? new THREE.Vector3(1, 1, 1), time);
    if (context.scale !== undefined) {
      scale.multiplyScalar(context.scale);
    }

    const speed = evaluateDynamicNumber(this.initialValues.speed ?? 1, time);
    const velocity = evaluateDynamicVector(this.initialValues.velocity ?? new THREE.Vector3(0, 0, 0), time).clone()
      .add(normal.multiplyScalar(
        evaluateDynamicNumber(this.radialSpeed, time),
      ));

    if (context.velocityScale !== undefined) {
      velocity.multiplyScalar(context.velocityScale);
    }

    if (context.velocity) {
      velocity.add(context.velocity);
    }

    const particle = new Particle({
      position,
      orbitCenter,
      rotation: evaluateDynamicVector(this.initialValues.rotation ?? rotation, time),
      scale,
      velocity,
      angularVelocity: this.initialValues.angularVelocity
        ? evaluateDynamicVector(this.initialValues.angularVelocity, time).clone()
        : undefined,
      scalarVelocity: this.initialValues.scalarVelocity
        ? evaluateDynamicVector(this.initialValues.scalarVelocity, time).clone()
        : undefined,
      acceleration: this.initialValues.acceleration
        ? evaluateDynamicVector(this.initialValues.acceleration, time).clone()
        : undefined,
      angularAcceleration: this.initialValues.angularAcceleration
        ? evaluateDynamicVector(this.initialValues.angularAcceleration, time).clone()
        : undefined,
      scalarAcceleration: this.initialValues.scalarAcceleration
        ? evaluateDynamicVector(this.initialValues.scalarAcceleration, time).clone()
        : undefined,
      speed,
      lifetime: evaluateDynamicNumber(this.initialValues.lifetime ?? 1, time),
      color,
      alpha,
      mass,
      distortionStrength,
      ...((this.tags || context.tags) && {
        tags: [...(context.tags ?? []), ...(this._selectTags() ?? [])],
      }),
    });

    return particleSystem.addParticle(particle, particles) ? particle : undefined;
  }

  private _selectTags(): Tag[] | undefined {
    if (!this.tags) return;

    switch (this.tagSelection){
      case 'random':
        return [this.tags[Math.floor(Math.random() * this.tags.length)]]
      case 'distribute':
        this._lastTagIndex = (this._lastTagIndex + 1) % this.tags.length;
        return [this.tags[this._lastTagIndex]]
      case 'all':
      default:
        return this.tags;
    }
  }
}

function transformPointGPU(point: Node<'vec3'>, matrix: Node<'mat4'>): Node<'vec3'> {
  return matrix.mul(vec4(point, 1)).xyz as Node<'vec3'>;
}

function transformDirectionGPU(vector: Node<'vec3'>, matrix: Node<'mat4'>): Node<'vec3'> {
  return matrix.mul(vec4(vector, 0)).xyz as Node<'vec3'>;
}

function rotateEulerYXZGPU(vector: Node<'vec3'>, rotation: Node<'vec3'>): Node<'vec3'> {
  const a = cos(rotation.x);
  const b = sin(rotation.x);
  const c = cos(rotation.y);
  const d = sin(rotation.y);
  const e = cos(rotation.z);
  const f = sin(rotation.z);

  return vec3(
    vector.x.mul(c.mul(e).add(d.mul(b).mul(f)))
      .add(vector.y.mul(c.mul(f).negate().add(d.mul(b).mul(e))))
      .add(vector.z.mul(d.mul(a))),
    vector.x.mul(a.mul(f))
      .add(vector.y.mul(a.mul(e)))
      .sub(vector.z.mul(b)),
    vector.x.mul(d.mul(e).negate().add(c.mul(b).mul(f)))
      .add(vector.y.mul(d.mul(f).add(c.mul(b).mul(e))))
      .add(vector.z.mul(c.mul(a))),
  ) as Node<'vec3'>;
}

function rotateFromYGPU(vector: Node<'vec3'>, direction: Node<'vec3'>): Node<'vec3'> {
  const target = direction.normalize();
  const quaternionVector = vec3(target.z, 0, target.x.negate());
  const quaternionScalar = float(1).add(target.y);
  const inverseLength = quaternionVector.lengthSq().add(quaternionScalar.mul(quaternionScalar))
    .max(float(Number.EPSILON))
    .sqrt()
    .reciprocal();
  const qVector = quaternionVector.mul(inverseLength);
  const qScalar = quaternionScalar.mul(inverseLength);
  const rotated = vector.add(qVector.cross(qVector.cross(vector).add(vector.mul(qScalar))).mul(2));
  const antiparallel = vec3(vector.x, vector.y.negate(), vector.z.negate());

  return target.y.lessThan(-0.9999).select(antiparallel, rotated) as Node<'vec3'>;
}

function getDynamicStructure(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' || typeof value === 'function') return typeof value;
  if (Array.isArray(value)) return `array:${value.map(getDynamicStructure).join(',')}`;
  if (value instanceof Set) return `set:${Array.from(value).map(getDynamicStructure).join(',')}`;
  if (value instanceof THREE.Vector3) return 'vector3';
  if (value instanceof THREE.Color) return 'color';
  return typeof value === 'object' ? 'node' : typeof value;
}

function getGeometryAttributeVersion(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined): number {
  if (!attribute) return 0;
  return 'version' in attribute ? attribute.version : attribute.data.version;
}

export default Emitter;
