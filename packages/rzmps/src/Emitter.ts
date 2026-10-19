import * as THREE from 'three';
import type { Node } from 'three/webgpu';
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
  pow,
  shiftLeft,
  sin,
  uint,
  uniform,
  uniformArray,
  vec3,
  vec4,
} from 'three/tsl';
import {
  GPUDynamicParameterStore,
} from './helpers/evaluateDynamicGPU';

export type SpawnBurst = {
    time: number,
    count: DynamicUntimedValue<number>,
    fired?: boolean,
};

export interface EmitterOptions {
    initialValues: Partial<InitialParticleValues>;
    source: EmissionShape;
    bursts: Multiple<SpawnBurst>;
    rate: DynamicValue<number>;
    rateOverDistance: DynamicValue<number>;

    radialSpeed: DynamicValue<number>;
    alignment: DynamicValue<number>;

    tags: StrictMultiple<Tag>;
    tagSelection: TagSelectionMethod | `${TagSelectionMethod}`;
    useUpdateLOD: boolean;
    updateLOD: Partial<LODSettings>;
    countLOD: Partial<LODSettings>;
    emitGPU: GPUEmitterUpdate;
}

interface EmitterContextState {
  startTime: number;
  lastSpawn: number;
  distanceCredit: number;
  lastDistancePosition?: THREE.Vector3;
  firedBursts: Set<number>;
}

export interface EmissionContext {
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

export interface GPUEmitterUpdateContext extends GPUParticleUpdateContext {
  emitter: Emitter;
  emitterIndex: number;
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

export type GPUEmitterUpdate = (context: GPUEmitterUpdateContext) => void;

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
  emitGPU?: GPUEmitterUpdate;
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
  private _gpuEmitGPU?: GPUEmitterUpdate;

  private _lastTagIndex: number = 0;

  // Used for subsystems
  private _contextStates = new Map<string, EmitterContextState>();

  get version(): number {
    return this._gpuVersion;
  }

  get gpuParameterUploadCount(): number {
    return this._gpuParameters.uploadCount;
  }

  set needsUpdate(value: boolean) {
    if (value) this._gpuVersion += 1;
  }

  constructor(
    options: Partial<EmitterOptions> = {},
  ) {
    this.source = options.source ?? EmissionShape.Sphere();
    this.initialValues = options.initialValues ?? {};

    this.bursts = acceptMultiple(options.bursts) ?? [];
    this.rate = options.rate ?? (this.bursts.length > 0 ? 0 : 50);
    this.rateOverDistance = options.rateOverDistance ?? 0;

    this.radialSpeed = options.radialSpeed ?? 1
    this.alignment = options.alignment ?? 0;

    this.tags = acceptMultiple(options.tags);
    this.tagSelection = (options.tagSelection as TagSelectionMethod) ?? this.tagSelection;
    this.updateLOD = options.updateLOD;
    this.useUpdateLOD = options.useUpdateLOD ?? Boolean(this.updateLOD);
    this.countLOD = options.countLOD;
    this.emitGPU = (options as Partial<EmitterOptions> & { emitGPU?: GPUEmitterUpdate }).emitGPU;
    this._lodHelper = new LODHelper(this.updateLOD);
    this._countLODHelper = new LODHelper(this.countLOD);
  }

  /*
    * CONTROLS
  */

  public reset(): void {
    this.bursts.forEach((burst) => {
      burst.fired = false;
    });

    this._contextStates.clear();
    this._lodHelper.reset();
    this._countLODHelper.reset();
  }

  get supportsGPUEmission(): boolean {
    return this.getGPUEmissionSupport().supported;
  }

  getGPUEmissionSupport(): GPUEmissionSupportReport {
    return getGPUEmitterSupport(this);
  }

  syncGPUConfiguration(): void {
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
      this.emitGPU ? 'custom' : 'built-in',
    ].join('|');
    if (
      this._gpuStructureSignature
      && (
        structureSignature !== this._gpuStructureSignature
        || this.source !== this._gpuSource
        || geometry !== this._gpuGeometry
        || this.emitGPU !== this._gpuEmitGPU
      )
    ) this._gpuVersion += 1;

    this._gpuStructureSignature = structureSignature;
    this._gpuSource = this.source;
    this._gpuGeometry = geometry;
    this._gpuEmitGPU = this.emitGPU;
  }

  createBuiltInGPUUpdate(): GPUEmitterUpdate | undefined {
    if (!this.supportsBuiltInGPUEmission()) return undefined;

    const geometry = this.source.geometry as THREE.BoxGeometry | THREE.SphereGeometry;
    const parameters = geometry.parameters as {
      width?: number;
      height?: number;
      depth?: number;
      radius?: number;
    };
    const shapeType = this.source.geometry.type;
    const shapeTime = float(0);
    const width = this._gpuParameters.number('shape.width', () => parameters.width, shapeTime, 1);
    const height = this._gpuParameters.number('shape.height', () => parameters.height, shapeTime, 1);
    const depth = this._gpuParameters.number('shape.depth', () => parameters.depth, shapeTime, 1);
    const radius = this._gpuParameters.number('shape.radius', () => parameters.radius, shapeTime, 1);
    const useAnalyticVolume = this.source.source === EmissionSource.Volume
      && (shapeType === 'BoxGeometry' || shapeType === 'SphereGeometry');
    const samplingTable = useAnalyticVolume ? undefined : this.createLocalGPUSamplingTable();
    const sampledPositions = samplingTable
      ? uniformArray(samplingTable.map((sample) => sample.position), 'vec3')
      : undefined;
    const sampledNormals = samplingTable
      ? uniformArray(samplingTable.map((sample) => sample.normal), 'vec3')
      : undefined;
    return (context) => {
      const particle = context.output.storage.loadParticle();
      const runtime = context.emitterRuntime;
      if (!runtime) return;
      const requested = runtime.requestCount();

      const initializeParticle = (claimIndex: Node<'uint'>) => {
        const seed = instanceIndex.add(uint(context.emitterIndex * 4099));
        const randomBoxPosition = vec3(
          hash(seed).sub(0.5).mul(width),
          hash(seed.add(17)).sub(0.5).mul(height),
          hash(seed.add(31)).sub(0.5).mul(depth),
        );
        const randomDirection = vec3(
          hash(seed).mul(2).sub(1),
          hash(seed.add(17)).mul(2).sub(1),
          hash(seed.add(31)).mul(2).sub(1),
        ).normalize();
        const randomRadius = pow(hash(seed.add(47)), float(1 / 3)).mul(radius);
        const randomSpherePosition = randomDirection.mul(randomRadius);
        const sampleIndex = int(hash(seed.add(43)).mul(256).floor());
        const sampledPosition: Node<'vec3'> = sampledPositions
          ? sampledPositions.element(sampleIndex) as unknown as Node<'vec3'>
          : shapeType === 'SphereGeometry'
            ? randomSpherePosition
            : randomBoxPosition;
        const localPosition = transformPointGPU(sampledPosition, this._gpuSourceMatrix);
        const normal: Node<'vec3'> = sampledNormals
          ? transformDirectionGPU(
            sampledNormals.element(sampleIndex) as unknown as Node<'vec3'>,
            this._gpuSourceMatrix,
          ).normalize()
          : transformDirectionGPU(sampledPosition.normalize(), this._gpuSourceMatrix).normalize();
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
        if (this.tagSelection === TagSelectionMethod.Random && tagMasks.length > 0) {
          const selectedTag = int(hash(seed.add(137)).mul(tagMasks.length).floor());
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

  prepareBuiltInGPUEmission(context: GPUEmitterUpdateContext): void {
    const runtime = context.emitterRuntime;
    if (!runtime) return;

    const elapsedTime = context.elapsedTimeNode;
    const duration = context.durationNode ?? float(Math.max(context.system.duration, Number.EPSILON));
    const normalizedTime = context.normalizedTimeNode
      ?? elapsedTime.div(duration.max(float(Number.EPSILON)));
    const requestCount = uint(0).toVar('emitterRequestCount');
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
        runtime.identity.x.assign(uint(1));
        runtime.timing.x.assign(elapsedTime);
        runtime.timing.y.assign(elapsedTime);
        runtime.timing.z.assign(float(0));
        runtime.distance.xyz.assign(context.emitterPositionNode ?? vec3(0, 0, 0));
        runtime.burstState.z.assign(uint(0));
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
        const bit = shiftLeft(uint(1), uint(burstIndex));
        const hasFired = bitAnd(runtime.burstState.z, bit).notEqual(uint(0));
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
          runtime.burstState.z.assign(bitOr(runtime.burstState.z, bit));
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

  private createLocalGPUSamplingTable(): Array<{ position: THREE.Vector3; normal: THREE.Vector3 }> {
    const position = this.source.position.clone();
    const quaternion = this.source.quaternion.clone();
    const scale = this.source.scale.clone();
    this.source.position.set(0, 0, 0);
    this.source.quaternion.identity();
    this.source.scale.set(1, 1, 1);
    this.source.updateMatrixWorld(true);
    const samples = Array.from({ length: 256 }, () => this.source.getPoint());
    this.source.position.copy(position);
    this.source.quaternion.copy(quaternion);
    this.source.scale.copy(scale);
    this.source.updateMatrixWorld(true);
    return samples;
  }

  supportsBuiltInGPUEmission(): boolean {
    if (this.emitGPU) return true;
    if (
      this.source.source !== EmissionSource.Volume
      && this.source.source !== EmissionSource.Surface
      && this.source.source !== EmissionSource.Vertices
    ) return false;
    if (
      this.source.geometry.type !== 'BoxGeometry'
      && this.source.geometry.type !== 'SphereGeometry'
      && this.source.geometry.type !== 'ConeGeometry'
      && this.source.geometry.type !== 'TorusGeometry'
    ) return false;
    if (!this.bursts.every((burst) => Number.isFinite(burst.time))) return false;
    if (this.bursts.length > 32) return false;
    if (this.tags?.length && this.tagSelection === TagSelectionMethod.Distribute) return false;
    return true;
  }

  /*
    * SIMULATION
  */

  setup(particleSystem: ParticleSystem) {
    particleSystem.add(this.source);
  }

  update(
    particles: Particle[],
    context: Partial<EmissionContext>,
    particleSystem: ParticleSystem,
  ): Particle[] {
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
