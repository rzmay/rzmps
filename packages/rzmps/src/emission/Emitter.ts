import GlobalSettings from '../core/GlobalSettings';
import EmitterInstance from './EmitterInstance';
import getAttributeVersion from '../utils/getAttributeVersion';
import { transformPointGPU, transformDirectionGPU, rotateEulerYXZGPU, rotateFromYGPU } from '../simulation/gpu/transforms.utils';
import EventReceiver, { type EventReceiverOptions } from '../events/EventReceiver';
import type { SubSystemOptions } from '../core/ParticleSystem';
import * as THREE from 'three';
import { StorageBufferAttribute, type Node } from 'three/webgpu';
import EmissionShape from './EmissionShape';
import Particle, { type ParticleInitializationContext, type GPUParticleInitializationContext } from '../core/Particle';
import type { InitialParticleValues } from './initialParticleValues.types';
import evaluateDynamicVector from '../values/evaluateDynamicVector3';
import evaluateDynamicNumber from '../values/evaluateDynamicNumber';
import maxDynamicNumber from '../values/maxDynamicNumber';
import evaluateDynamicColor from '../values/evaluateDynamicColor';
import acceptMultiple from '../utils/acceptMultiple';
import type ParticleSystem from '../core/ParticleSystem';
import type { DynamicUntimedValue, DynamicValue } from '../values/dynamicValue.types';
import type { Multiple, StrictMultiple } from '../types/multiple.types';
import type { Tag } from '../types/tag.types';
import { TagSelectionMethod } from '../enums/TagSelectionMethod';
import { EmissionSource } from '../enums/EmissionSource';
import { getGPUEmitterSupport, type GPUEmissionSupportReport } from './gpu/Emission';
import type { GPUParticleBufferState, GPUParticleLike, GPUParticleUpdateContext } from '../simulation/gpu/Particle';
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
  inverse,
  transpose,
  mat3,
  mat4,
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
} from '../values/evaluateDynamicGPU';
import type { PackedFloatStorage, PackedUintStorage } from '../utils/gpu/storage.utils';

export type SpawnBurst = {
    /** Normalized emission-cycle time, clamped to the range 0 through 1. */
    time: number,
    /** Number of particles emitted when the burst fires. */
    count: DynamicUntimedValue<number>,
    /** Internal CPU emission state; reset automatically with the emitter. */
    fired?: boolean,
};

export type EmitterSources = readonly string[] | { ids?: readonly string[]; tags?: readonly string[] };
export interface EmitterOptions extends EventReceiverOptions, Partial<Omit<SubSystemOptions, 'tags'>> {
    /** Registered source IDs, or a union of IDs and sources with any selected tag. Omission uses ordinary emission. */
    sources?: EmitterSources;
    /** Tags selecting event origins; tags continues to assign tags at particle birth. */
    sourceTags?: Tag[];
    /** Dynamic values sampled at birth; mutable values are isolated per particle. */
    initialValues: Partial<InitialParticleValues>;
    /** Geometry and sampling rule used to place particles. Defaults to a sphere. */
    source: EmissionShape;
    /** Timed particle batches within an emission cycle.
     * Supplying bursts changes the default continuous rate to zero. */
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

}

export interface EmissionContext extends Omit<ParticleInitializationContext, 'system'> {
  /** @internal Live attachment source, separate from the event snapshot. */
  source?: import('./EmissionSource').SubSystemSource;
  /** Stable identity of this emitter execution. */
  key: string;
  /** @internal Simulation step duration in seconds. */
  deltaTime?: number;
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
  /** Multiplies burst counts and time/distance emission rates; defaults to one. */
  countScale?: number;
  scale: number;
  tags: Tag[];
}

/** @internal Context used to construct the built-in GPU birth graph. */
export interface GPUEmitterUpdateContext extends GPUParticleUpdateContext {
  /** @internal Native Source births are initialized in the emitting particle's reference frame. */
  sourceRelative?: boolean;
  resolveSourceIdentity?: (claimIndex: Node<'uint'>) => Node<'vec4'>;
  emissionFrame?: Node<'mat4'>;
  /** Emitter whose birth graph is being constructed. */
  emitter: Emitter;
  /** Emitter position in the owning system's emitter array. */
  emitterIndex: number;
  /** Destination storage for newly allocated particles. */
  output: GPUParticleBufferState;
  emitterRuntime?: GPUEmitterInstanceRuntime;
  durationNode?: Node<'float'>;
  normalizedTimeNode?: Node<'float'>;
  loopingClock?: boolean;
  skippedClockWrapNode?: Node<'float'>;
  countScaleNode?: Node<'float'>;
  emitterPositionNode?: Node<'vec3'>;
  parentParticle?: GPUParticleLike;
  resolveInheritedVelocity?: (claimIndex: Node<'uint'>) => Node<'vec3'>;
  resolveInitializationContext?: (claimIndex: Node<'uint'>) => Partial<GPUParticleInitializationContext>;
  resolveParentParticle?: (claimIndex: Node<'uint'>) => GPUParticleLike;
  resolveDistortionStrength?: (claimIndex: Node<'uint'>) => Node<'float'>;
  resolveEmissionTransform?: (claimIndex: Node<'uint'>) => Node<'mat4'>;
  resolveBirthOffset?: (claimIndex: Node<'uint'>) => Node<'float'>;
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
class Emitter extends EventReceiver {
  /** Emitter-owned triggers and source inheritance, overlaid by attachment overrides at execution. */
  emission: Partial<SubSystemOptions>;
  sources?: EmitterSources;
  source: EmissionShape;
  rate: DynamicValue<number>;
  rateOverDistance: DynamicValue<number>;

  bursts: SpawnBurst[];
  initialValues: Partial<InitialParticleValues>;
  radialSpeed: DynamicValue<number>;
  alignment: DynamicValue<number>;

  tags?: Tag[];
  tagSelection: TagSelectionMethod = TagSelectionMethod.All;
  private readonly _gpuQuality = uniform(1, 'float');
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

  // Owner-specific lookup; each entry is the execution itself, with no parallel context-state map.
  private readonly _instances = new Map<number, Map<string, EmitterInstance>>();

  get emitContinuous(): SubSystemOptions['emitContinuous'] | undefined { return this.emission.emitContinuous; }
  set emitContinuous(value: SubSystemOptions['emitContinuous'] | undefined) { this.emission.emitContinuous = value; }
  get emitOnSpawn(): SubSystemOptions['emitOnSpawn'] | undefined { return this.emission.emitOnSpawn; }
  set emitOnSpawn(value: SubSystemOptions['emitOnSpawn'] | undefined) { this.emission.emitOnSpawn = value; }
  get emitOnDeath(): SubSystemOptions['emitOnDeath'] | undefined { return this.emission.emitOnDeath; }
  set emitOnDeath(value: SubSystemOptions['emitOnDeath'] | undefined) { this.emission.emitOnDeath = value; }
  get emitOnCollision(): SubSystemOptions['emitOnCollision'] | undefined { return this.emission.emitOnCollision; }
  set emitOnCollision(value: SubSystemOptions['emitOnCollision'] | undefined) { this.emission.emitOnCollision = value; }
  get onEvent(): SubSystemOptions['onEvent'] | undefined { return this.emission.onEvent; }
  set onEvent(value: SubSystemOptions['onEvent'] | undefined) { this.emission.onEvent = value; }
  get shouldEmit(): SubSystemOptions['shouldEmit'] | undefined { return this.emission.shouldEmit; }
  set shouldEmit(value: SubSystemOptions['shouldEmit'] | undefined) { this.emission.shouldEmit = value; }
  get ratio(): SubSystemOptions['ratio'] | undefined { return this.emission.ratio; }
  set ratio(value: SubSystemOptions['ratio'] | undefined) { this.emission.ratio = value; }
  get inheritScale(): SubSystemOptions['inheritScale'] | undefined { return this.emission.inheritScale; }
  set inheritScale(value: SubSystemOptions['inheritScale'] | undefined) { this.emission.inheritScale = value; }
  get inheritColor(): SubSystemOptions['inheritColor'] | undefined { return this.emission.inheritColor; }
  set inheritColor(value: SubSystemOptions['inheritColor'] | undefined) { this.emission.inheritColor = value; }
  get inheritAlpha(): SubSystemOptions['inheritAlpha'] | undefined { return this.emission.inheritAlpha; }
  set inheritAlpha(value: SubSystemOptions['inheritAlpha'] | undefined) { this.emission.inheritAlpha = value; }
  get inheritMass(): SubSystemOptions['inheritMass'] | undefined { return this.emission.inheritMass; }
  set inheritMass(value: SubSystemOptions['inheritMass'] | undefined) { this.emission.inheritMass = value; }
  get inheritVelocity(): SubSystemOptions['inheritVelocity'] | undefined { return this.emission.inheritVelocity; }
  set inheritVelocity(value: SubSystemOptions['inheritVelocity'] | undefined) { this.emission.inheritVelocity = value; }
  get inheritLifetime(): SubSystemOptions['inheritLifetime'] | undefined { return this.emission.inheritLifetime; }
  set inheritLifetime(value: SubSystemOptions['inheritLifetime'] | undefined) { this.emission.inheritLifetime = value; }
  get impulseThreshold(): SubSystemOptions['impulseThreshold'] | undefined { return this.emission.impulseThreshold; }
  set impulseThreshold(value: SubSystemOptions['impulseThreshold'] | undefined) {
    this.emission.impulseThreshold = value;
  }
  get impulseAffectsScale(): SubSystemOptions['impulseAffectsScale'] | undefined {
    return this.emission.impulseAffectsScale;
  }
  set impulseAffectsScale(value: SubSystemOptions['impulseAffectsScale'] | undefined) {
    this.emission.impulseAffectsScale = value;
  }
  get impulseAffectsSpeed(): SubSystemOptions['impulseAffectsSpeed'] | undefined {
    return this.emission.impulseAffectsSpeed;
  }
  set impulseAffectsSpeed(value: SubSystemOptions['impulseAffectsSpeed'] | undefined) {
    this.emission.impulseAffectsSpeed = value;
  }
  get impulseAffectsMass(): SubSystemOptions['impulseAffectsMass'] | undefined {
    return this.emission.impulseAffectsMass;
  }
  set impulseAffectsMass(value: SubSystemOptions['impulseAffectsMass'] | undefined) {
    this.emission.impulseAffectsMass = value;
  }
  get impulseAffectsLifetime(): SubSystemOptions['impulseAffectsLifetime'] | undefined {
    return this.emission.impulseAffectsLifetime;
  }
  set impulseAffectsLifetime(value: SubSystemOptions['impulseAffectsLifetime'] | undefined) {
    this.emission.impulseAffectsLifetime = value;
  }
  get impulseAffectsAlignment(): SubSystemOptions['impulseAffectsAlignment'] | undefined {
    return this.emission.impulseAffectsAlignment;
  }
  set impulseAffectsAlignment(value: SubSystemOptions['impulseAffectsAlignment'] | undefined) {
    this.emission.impulseAffectsAlignment = value;
  }

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
    const {
      source, sources, sourceTags, initialValues, bursts, rate, rateOverDistance,
      radialSpeed, alignment, tags, tagSelection, events, eventScope, ...emission
    } = options;

    super({ events, eventScope });

    this.sources = sources;
    this.emission = { ...emission, ...(sourceTags === undefined ? {} : { tags: sourceTags }) };
    this.source = source ?? EmissionShape.Sphere();
    this.initialValues = initialValues ?? {};

    this.bursts = acceptMultiple(bursts) ?? [];
    this.normalizeBurstTimes();
    this.rate = rate ?? (this.bursts.length > 0 ? 0 : 50);
    this.rateOverDistance = rateOverDistance ?? 0;

    this.radialSpeed = radialSpeed ?? 1;
    this.alignment = alignment ?? 0;

    this.tags = acceptMultiple(tags);
    this.tagSelection = (tagSelection as TagSelectionMethod) ?? this.tagSelection;
  }

  /*
    * CONTROLS
  */

  /** Clears timed bursts, movement credit, LOD state, and instance emission clocks. */
  public reset(): void {
    this.bursts.forEach((burst) => {
      burst.fired = false;
    });

    for (const instances of this._instances.values()) {
      for (const instance of instances.values()) instance.reset();
    }
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
      getAttributeVersion(geometry.getAttribute('position'), 0),
      getAttributeVersion(geometry.getAttribute('normal'), 0),
      geometry.index?.count ?? 0,
      geometry.index?.version ?? 0,
      this.bursts.length,
      this.getDynamicStructure(this.rate),
      this.getDynamicStructure(this.rateOverDistance),
      this.getDynamicStructure(this.radialSpeed),
      this.getDynamicStructure(this.alignment),
      ...this.bursts.map((burst) => this.getDynamicStructure(burst.count)),
      ...Object.keys(this.initialValues).sort().map((key) => (
        `${key}:${this.getDynamicStructure(this.initialValues[key as keyof InitialParticleValues])}`
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
        particle.lodPriority.assign(uint(hash(seed.add(9173)).mul(this._gpuQuality).mul(4294967040)));
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
        const emissionTransform = context.resolveEmissionTransform?.(claimIndex)
          ?? (context.sourceRelative ? mat4(new THREE.Matrix4()) : context.emissionFrame);
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
        const emissionPosition = emissionTransform ? transformPointGPU(localPosition.add(initialPosition),
          emissionTransform) : parent
          ? rotatedPosition.add(parent.position)
          : parentLocalPosition.add(context.emitterPositionNode ?? vec3(0, 0, 0));
        const emissionNormal = emissionTransform
          ? transpose(inverse(mat3(emissionTransform))).mul(normal).normalize() as Node<'vec3'>
          : rotatedNormal.normalize();
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
          atan(emissionNormal.x, emissionNormal.x.abs().add(emissionNormal.z.abs()).lessThan(1e-8)
            .select(float(1), emissionNormal.z)),
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
        const inheritedVelocity = context.resolveInheritedVelocity?.(claimIndex)
          ?? (parent && inheritance && inheritance.velocity > 0
            ? parent.velocity.mul(inheritance.velocity) : vec3(0, 0, 0));

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
        particle.distortionStrength.assign(
          initialDistortion.mul(context.resolveDistortionStrength?.(claimIndex) ?? float(1)),
        );
        particle.lifetime.assign(initialLifetime);
        particle.time.assign(float(0));
        particle.realtime.assign(float(0));
        context.output.storage.createSourceIdentityNode(particle.index).assign(
          context.resolveSourceIdentity?.(claimIndex) ?? vec4(0),
        );
        const tagMasks = context.tagMasks ?? [];
        if (
          (this.tagSelection === TagSelectionMethod.Random
            || this.tagSelection === TagSelectionMethod.Distribute)
          && tagMasks.length > 0
        ) {
          const selectedTag = this.tagSelection === TagSelectionMethod.Random
            ? int(hash(seed.add(137)).mul(tagMasks.length).floor())
            : int(particle.index.mod(tagMasks.length));
          const tagMask = tagMasks.reduce<Node<'uint'>>((result, value, index) => (
            selectedTag.equal(index).select(uint(value), result) as Node<'uint'>
          ), uint(0));
          particle.tagMask.assign(tagMask);
        } else {
          particle.tagMask.assign(uint(tagMasks.reduce((mask, value) => mask | value, 0)));
        }
        context.system.initializeParticleGPU(particle, {
          ...context, source: parent, ...context.resolveInitializationContext?.(claimIndex),
        });
        context.allocationWriter?.markSpawned(particle);
        // Hooks and spawn snapshots see age zero. Only packed storage carries the offset.
        particle.birthOffset?.assign((context.resolveBirthOffset?.(claimIndex)
          ?? runtime.birthOffset(claimIndex, this.bursts.length)).clamp(0, context.deltaTimeNode));
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

    const elapsedTime = context.elapsedTimeNode.toVar('emitterElapsedTime');
    const duration = context.durationNode ?? float(Math.max(context.system.duration, Number.EPSILON));
    const safeDuration = duration.max(float(Number.EPSILON));
    const normalizedTime = context.normalizedTimeNode
      ?? (context.loopingClock ? elapsedTime.mod(safeDuration) : elapsedTime).div(safeDuration);
    const emissionMultiplier = this._gpuQuality.mul((context.countScaleNode ?? float(1)).max(0));
    const skipped = context.skippedTimeNode ?? float(0);
    If(skipped.greaterThan(0), () => {
      const wrap = context.skippedClockWrapNode ?? float(0);
      const skipEnd = elapsedTime.sub(context.deltaTimeNode).toVar('skipEnd');
      const skipTime = (context.loopingClock ? skipEnd.mod(safeDuration) : skipEnd).div(safeDuration);
      const crossedCycle = (context.loopingClock
        ? skipEnd.div(safeDuration).floor().notEqual(runtime.timing.w.div(safeDuration).floor())
        : wrap.greaterThan(0)).toVar('skipCrossedCycle');
      If(runtime.identity.x.equal(uint(0)), () => {
        runtime.timing.y.assign(skipEnd.add(wrap).sub(skipped).max(0));
        runtime.identity.x.assign(uint(1));
      });
      const rate = this._gpuParameters.number('rate', () => this.rate, skipTime, 0,
        uint(context.emitterIndex * 4099)).mul(emissionMultiplier);
      If(rate.greaterThan(0), () => {
        const due = skipEnd.add(wrap).sub(runtime.timing.y).mul(rate).add(1e-6).floor().max(0);
        runtime.timing.y.addAssign(due.div(rate));
      }).Else(() => { runtime.timing.y.assign(skipEnd.add(wrap)); });
      runtime.timing.y.subAssign(wrap);
      runtime.timing.w.assign(skipEnd);
      runtime.timing.z.assign(0);
      runtime.distance.xyz.assign(context.emitterPositionNode ?? vec3(0));
      runtime.distance.w.assign(0);
      runtime.setPendingRequestCount(0);
      for (let word = 0; word < Math.ceil(this.bursts.length / 32); word += 1) {
        If(wrap.greaterThan(0).or(crossedCycle), () => { runtime.firedBurstWord(word).assign(uint(0)); });
      }
      this.bursts.forEach((_burst, index) => {
        const burstTime = this._gpuParameters.number(`burst.${index}.time`,
          () => this.bursts[index]?.time, skipTime, 0);
        If(burstTime.lessThanEqual(skipTime), () => {
          const word = runtime.firedBurstWord(Math.floor(index / 32));
          word.assign(bitOr(word, shiftLeft(uint(1), uint(index % 32))));
        });
      });
    });
    if (context.loopingClock) {
      If(elapsedTime.div(safeDuration).floor().notEqual(runtime.timing.w.div(safeDuration).floor()), () => {
        for (let word = 0; word < Math.ceil(this.bursts.length / 32); word += 1) {
          runtime.firedBurstWord(word).assign(uint(0));
        }
      });
    }
    const requestCount = runtime.pendingRequestCount().toVar('emitterRequestCount');
    runtime.birthSchedule(0).assign(vec4(float(requestCount), 0, 0, 0));
    const firstBirth = float(0).toVar('firstBirth');
    const birthInterval = float(0).toVar('birthInterval');
    const resetContext = runtime.identity.x.equal(uint(0))
      .or(elapsedTime.lessThan(runtime.timing.w))
      .toVar('resetEmitterContext');

    {
      If(resetContext, () => {
        requestCount.assign(uint(0));
        runtime.setPendingRequestCount(0);
        runtime.identity.x.assign(uint(1));
        runtime.timing.x.assign(elapsedTime);
        runtime.timing.y.assign(runtime.timing.x);
        runtime.timing.z.assign(float(0));
        runtime.distance.w.assign(float(0));
        runtime.distance.xyz.assign(context.emitterPositionNode ?? vec3(0, 0, 0));
        for (let wordIndex = 0; wordIndex < Math.ceil(this.bursts.length / 32); wordIndex += 1) {
          runtime.firedBurstWord(wordIndex).assign(uint(0));
        }
      });
      {
        const rate = this._gpuParameters.number(
          'rate', () => this.rate, normalizedTime, 0, uint(context.emitterIndex * 4099),
        )
          .mul(emissionMultiplier);
        If(rate.greaterThan(float(0)), () => {
          const emissionCredit = elapsedTime.sub(runtime.timing.y).mul(rate);
          const due = emissionCredit.add(1e-6).floor().max(0);
          birthInterval.assign(float(1).div(rate));
          firstBirth.assign(runtime.timing.y.add(birthInterval).sub(elapsedTime.sub(context.deltaTimeNode)));
          requestCount.addAssign(uint(due));
          If(due.greaterThan(float(0)), () => {
            runtime.timing.y.addAssign(due.div(rate));
          });
        }).Else(() => {
          runtime.timing.y.assign(elapsedTime);
        });
      }
      runtime.birthSchedule(1).assign(vec4(float(requestCount), firstBirth, birthInterval, 0));

      const rateOverDistance = this._gpuParameters.number(
        'rateOverDistance',
        () => this.rateOverDistance,
        normalizedTime,
        0,
        uint(context.emitterIndex * 6151),
      ).mul(emissionMultiplier);
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

      runtime.birthSchedule(2).assign(vec4(float(requestCount), 0, 0, 0));
      this.bursts.forEach((burst, burstIndex) => {
        const burstWord = runtime.firedBurstWord(Math.floor(burstIndex / 32));
        const bit = shiftLeft(uint(1), uint(burstIndex % 32));
        const hasFired = bitAnd(burstWord, bit).notEqual(uint(0));
        const burstTime = this._gpuParameters.number(
          `burst.${burstIndex}.time`, () => this.bursts[burstIndex]?.time, normalizedTime, 0,
        );
        If(hasFired.not().and(normalizedTime.greaterThanEqual(burstTime)), () => {
          const burstCredit = this._gpuParameters.number(
            `burst.${burstIndex}.count`, () => this.bursts[burstIndex]?.count,
            normalizedTime, 0, uint(context.emitterIndex * 4099 + burstIndex * 131),
          ).mul(emissionMultiplier).add(runtime.distance.w);
          const due = burstCredit.floor();
          requestCount.addAssign(uint(due));
          runtime.distance.w.assign(burstCredit.sub(due));
          burstWord.assign(bitOr(burstWord, bit));
        });
        runtime.birthSchedule(burstIndex + 3).assign(vec4(float(requestCount),
          burstTime.mul(duration).add(context.loopingClock
            ? elapsedTime.div(safeDuration).floor().mul(duration) : float(0))
            .sub(elapsedTime.sub(context.deltaTimeNode)).max(0), 0, 0));
      });
    }

    runtime.timing.w.assign(elapsedTime);
    If(this._gpuQuality.lessThanEqual(float(0)), () => { requestCount.assign(uint(0)); });
    runtime.resetRequestCount(requestCount);
  }

  updateGPUQuality(quality: number): void {
    this.source.updateMatrix();
    this._gpuSourceMatrix.value.copy(this.source.matrix);
    this._gpuQuality.value = quality;
  }

  private getGPUVolumeSampling(): NonNullable<Emitter['_gpuVolumeSampling']> {
    const geometry = this.source.geometry;
    const samples = this.source.getVolumeSamples();
    const signature = [
      this.source.version,
      samples.length,
      getAttributeVersion(geometry.getAttribute('position'), 0),
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
      getAttributeVersion(position, 0),
      getAttributeVersion(normal, 0),
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

  /** Returns a sampled maximum initial lifetime, or null when no finite sample is readable.
   * Functional values use GPU_DYNAMIC_VALUE_RESOLUTION samples over normalized time;
   * their maximum is approximate and can miss peaks between samples. */
  getMaxLifetime(): number | null {
    const maximum = maxDynamicNumber(this.initialValues.lifetime ?? 1,
      GlobalSettings.GPU_DYNAMIC_VALUE_RESOLUTION, Number.NaN);
    return Number.isFinite(maximum) ? maximum : null;
  }

  /** @internal Moves an execution past discarded time without births or deferred credit. */
  advanceClock(context: Partial<EmissionContext>, system: ParticleSystem,
    instance: EmitterInstance, discarded: number, clockWrap = 0): void {
    this.normalizeBurstTimes();
    const end = (context.elapsedTime ?? instance.elapsed) + clockWrap;
    const duration = context.duration ?? system.duration;
    const looping = context.looping ?? system.looping;
    const time = context.time ?? (duration > 0 ? (looping ? end % duration : end) / duration : 1);
    if (instance.startTime === undefined) {
      instance.startTime = Math.max(0, end - discarded) * 1000;
      instance.lastSpawn = instance.startTime;
    }
    const rate = evaluateDynamicNumber(this.rate, time) * system.quality * Math.max(0, context.countScale ?? 1);
    if (rate > 0) {
      const interval = 1000 / rate;
      const count = Math.max(0, Math.floor((end * 1000 - instance.lastSpawn) / interval + 1e-9));
      instance.lastSpawn += count * interval;
    } else instance.lastSpawn = end * 1000;
    instance.lastSpawn -= clockWrap * 1000;
    instance.startTime -= clockWrap * 1000;
    const cycle = duration > 0 && looping ? Math.floor(end / duration) : 0;
    if (clockWrap > 0 || (instance.cycle !== undefined && instance.cycle !== cycle)) {
      instance.firedBursts.clear();
    }
    instance.cycle = clockWrap > 0 ? 0 : cycle;
    this.bursts.forEach((burst, index) => {
      if (burst.time <= time) instance.firedBursts.add(index);
    });
    instance.distanceCredit = 0;
    instance.burstCredit = 0;
    instance.lastDistancePosition = this._getDistancePosition(context)?.clone();
  }

  /** Emits births for the supplied simulation context and returns the newly created particles. */
  update(particles: Particle[], context: Partial<EmissionContext>, particleSystem: ParticleSystem): Particle[];
  /** @internal The coordinator can reuse its resolved instance without another identity lookup. */
  update(
    particles: Particle[], context: Partial<EmissionContext>, particleSystem: ParticleSystem, instance: EmitterInstance,
  ): Particle[];
  update(
    particles: Particle[],
    context: Partial<EmissionContext>,
    particleSystem: ParticleSystem,
    instance?: EmitterInstance,
  ): Particle[] {
    const state = instance ?? this.getInstance(particleSystem, context.key ?? '__default');
    const now = Date.now();
    const step = context.deltaTime ?? 0;
    this.normalizeBurstTimes();
    const elapsedMilliseconds = context.elapsedTime === undefined
      ? undefined
      : context.elapsedTime * 1000;
    if (state.startTime === undefined) {
      state.startTime = elapsedMilliseconds ?? now;
      state.lastSpawn = state.startTime;
    }
    const duration = context.duration ?? particleSystem.duration;
    const elapsedTime = context.elapsedTime ?? ((now - state.startTime) / 1000);
    let time = context.time ?? (duration <= 0 ? 1 : elapsedTime / duration);
    const looping = context.looping ?? particleSystem.looping;
    const spawned: Particle[] = [];

    const explicitLoopClock = context.elapsedTime !== undefined && context.time === undefined && looping &&
      duration > 0;
    if (explicitLoopClock) {
      const cycle = Math.floor(elapsedTime / duration);
      time = (elapsedTime % duration) / duration;
      if (state.cycle !== cycle) { state.firedBursts.clear(); state.cycle = cycle; }
    }
    if (!explicitLoopClock && context.time === undefined && elapsedTime >= duration) {
      if (!looping) return spawned;

      state.startTime = now;
      state.lastSpawn = now;
      state.distanceCredit = 0;
      state.lastDistancePosition = undefined;
      state.firedBursts.clear();

      return spawned;
    }

    const emissionMultiplier = particleSystem.quality * Math.max(0, context.countScale ?? 1);
    const rate = evaluateDynamicNumber(this.rate, time) * emissionMultiplier;
    if (emissionMultiplier <= 0) state.lastSpawn = elapsedMilliseconds ?? now;
    if (rate <= 0) state.lastSpawn = elapsedMilliseconds ?? now;
    if (rate > 0) {
      const secondsPerParticle = 1000 / rate;
      const spawnClock = elapsedMilliseconds ?? now;
      const particlesDue = Math.floor((spawnClock - state.lastSpawn) / secondsPerParticle + 1e-9);

      for (let i = 0; i < particlesDue; i += 1) {
        const particle = this.spawnParticle(particles, time, context, particleSystem);

        if (particle) {
          particle.realtime = -Math.max(0, Math.min(step * 1000,
            state.lastSpawn + (i + 1) * secondsPerParticle - (spawnClock - step * 1000)));
          spawned.push(particle);
        }
      }

      if (particlesDue > 0) state.lastSpawn += particlesDue * secondsPerParticle;
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
        const requested = evaluateDynamicNumber(burst.count) * emissionMultiplier + state.burstCredit;
        const count = Math.floor(requested);
        state.burstCredit = requested - count;
        for (let i = 0; i < Math.floor(count); i += 1) {
          const particle = this.spawnParticle(particles, time, context, particleSystem);
          if (particle) {
            const scheduled = burst.time * duration;
            const cycleStart = explicitLoopClock ? Math.floor(elapsedTime / duration) * duration : 0;
            particle.realtime = -Math.max(0, Math.min(step, cycleStart + scheduled - (elapsedTime - step))) * 1000;
            spawned.push(particle);
          }
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

  clearContext(key: string): void;
  /** @internal Retires a binding without disturbing another owner of this emitter. */
  clearContext(key: string, system: ParticleSystem): void;
  clearContext(key: string, system?: ParticleSystem): void {
    const owners = system ? [this._instances.get(system.id)] : this._instances.values();
    for (const instances of owners) {
      if (!instances) continue;
      const instance = instances.get(key);
      if (instance) instance.active = false;
      instances.delete(key);
    }
  }

  /** @internal Returns the execution binding owned by this system and identity. */
  getInstance(system: ParticleSystem, key: string): EmitterInstance {
    let instances = this._instances.get(system.id);
    if (!instances) {
      instances = new Map();
      this._instances.set(system.id, instances);
    }
    let instance = instances.get(key);
    if (!instance) {
      instance = new EmitterInstance(this, key);
      instances.set(key, instance);
    }
    return instance;
  }

  /** @internal Releases an execution without affecting another owner of this definition. */
  releaseInstance(system: ParticleSystem, instance: EmitterInstance): void {
    const instances = this._instances.get(system.id);
    if (instances?.get(instance.key) === instance) instances.delete(instance.key);
    if (instances?.size === 0) this._instances.delete(system.id);
    instance.active = false;
  }

  /** @internal Releases this owner's clocks, including direct update() contexts. */
  releaseInstances(system: ParticleSystem): void {
    for (const instance of this._instances.get(system.id)?.values() ?? []) instance.active = false;
    this._instances.delete(system.id);
  }

  private _getDistancePosition(context: Partial<EmissionContext>): THREE.Vector3 | undefined {
    if (context.position) return context.position;
    if (!context.transform) return undefined;
    return this._distancePosition.setFromMatrixPosition(context.transform);
  }

  private spawnParticle(
    particles: Particle[],
    time: number,
    emissionContext: Partial<EmissionContext>,
    particleSystem: ParticleSystem,
  ): Particle | undefined {
    const sourceFrame = particleSystem.getSourceEmissionFrame(emissionContext.source);
    if (emissionContext.source?.alive && particleSystem.isSubSystem
      && particleSystem.simulationSpace === 'source' && !sourceFrame) return;
    const toSource = sourceFrame?.clone().invert();
    const context = toSource ? {
      ...emissionContext,
      transform: toSource.clone().multiply(emissionContext.transform ?? new THREE.Matrix4()),
      velocity: emissionContext.velocity?.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(toSource)),
    } : emissionContext;
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

    if (sourceFrame) particle.transformSimulationFrame(sourceFrame);
    particle.lodPriority = particleSystem.quality * Math.random();
    if (!particleSystem.addParticle(particle, particles)) return undefined;
    particleSystem.bindParticleSource(particle, context.source);
    particleSystem.initializeParticle(particle, { system: particleSystem, source: context.source,
      event: context.event, sourceToWorld: context.sourceToWorld });
    return particle;
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

  // Recursively describe emission option structure for GPU configuration invalidation.
  private getDynamicStructure(value: unknown): string {
    if (value === undefined) return 'undefined';
    if (typeof value === 'number' || typeof value === 'function') return typeof value;
    if (Array.isArray(value)) return `array:${value.map(value => this.getDynamicStructure(value)).join(',')}`;
    if (value instanceof Set) return `set:${Array.from(value).map(value => this.getDynamicStructure(value)).join(',')}`;
    if (value instanceof THREE.Vector3) return 'vector3';
    if (value instanceof THREE.Color) return 'color';
    return typeof value === 'object' ? 'node' : typeof value;
  }
}

export default Emitter;
