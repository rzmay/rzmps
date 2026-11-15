import type { SpatialGridDomain } from '../spatial/structures/spatialGridDomain.utils';
import GasModule, { type GPUGasCell, type GasModuleContext } from './GasModule';
import SpatialEffect from '../spatial/effects/SpatialEffect';
import GasAffector from '../spatial/effects/GasAffector';
import FluidCollider from '../spatial/effects/FluidCollider';
import ParticleForceField from '../spatial/effects/ParticleForceField';
import acceptMultiple from '../utils/acceptMultiple';
import minDynamicVector from '../values/minDynamicVector';
import maxDynamicVector from '../values/maxDynamicVector';
import maxDynamicNumber from '../values/maxDynamicNumber';
import type { GasCellGPU } from '../spatial/effects/GasAffector';
import type { ModuleExecutionContext } from '../core/Module';
import type ParticleSystem from '../core/ParticleSystem';
import tagsIntersect from '../core/tags/tagsIntersect';
import { sampleGasEffectGPU } from '../simulation/gpu/gasSpatialEffects.utils';
import * as THREE from 'three';
import {
  Storage3DTexture, StorageBufferAttribute, type ComputeNode, type Node, type WebGPURenderer,
} from 'three/webgpu';
import {
  Fn, If, Loop, atomicMax, atomicMin, atomicStore, clamp, float, floatBitsToUint, instanceIndex, int, ivec3,
  max, min, mix, pow, storage, storageTexture, textureStore, uint, uniform, vec3, vec4,
} from 'three/tsl';
import type {
  GPUParticleLike, GPUParticleRenderBufferState, GPUParticleUpdateContext,
} from '../simulation/gpu/Particle';
import { destroyGPUStorageAttribute } from '../simulation/gpu/Particle';
import prepareComputePrograms from '../utils/gpu/prepareComputePrograms';
import { readFluidBrickStates } from '../simulation/gpu/readFluidBrickStates';
import { GUARD_PREDICTION_HORIZON, type FluidGuardSource } from '../simulation/gpu/FluidGuardPrediction';
import ParticleSpatialGrid, { type ParticleSpatialGridRenderer } from '../spatial/structures/ParticleSpatialGrid';
import { generateGPUParticleNoise4D } from '../utils/noise.utils';
import type { VolumeField } from '../rendering/volumeField.types';
import type { VolumeFieldProvider } from '../rendering/volumeField.types';
import type { ValueByParameter } from '../values/valueByParameter.types';
import type { DynamicValue } from '../values/dynamicValue.types';
import FluidSimulation, { type FluidSimulationOptions } from './FluidSimulation';
import SparseVolumeGrid from '../spatial/structures/gpu/SparseVolumeGrid';
import FluidPressureProjection from '../simulation/gpu/FluidPressureProjection';
import StagedGPUAllocation from '../utils/gpu/StagedGPUAllocation';
import { copyStorageAttributes, initializeStorageAttribute } from '../utils/gpu/storage.utils';
import { PressureSolver } from '../enums/PressureSolver';
import { pressureAutoPolicy, pressureHierarchy, selectPressureSolver } from '../simulation/gpu/pressureSolver.utils';
import type { MultigridOptions } from '../simulation/multigrid.types';
import { AdvectionMethod } from '../enums/AdvectionMethod';

interface GasPool {
  attributes: StorageBufferAttribute[];
  count: number;
  grid?: SparseVolumeGrid;
  pressure?: ReturnType<FluidPressureProjection['createCapacityStorage']>;
  retired: StorageBufferAttribute[];
  adopted?: boolean;
}

interface GasTexturePool {
  dimensions: THREE.Vector3;
  density: Storage3DTexture;
  color: Storage3DTexture;
}

type Vec4Storage = { element(index: Node | number): Node<'vec4'> };
type AtomicUintStorage = { element(index: Node | number): Node<'uint'> };
type FloatUniform = Node<'float'> & { value: number };

const behaviorCoefficients = [
  'turbulenceNoiseStrength', 'vorticityStrength', 'densityDissipation', 'temperatureDissipation',
  'velocityDissipation', 'colorDissipation', 'turbulenceNoiseFrequency',
] as const;
type BehaviorCoefficient = typeof behaviorCoefficients[number];
type BehaviorState = { temperature?: Node<'float'>; density?: Node<'float'> };

export interface GasSimulationOptions extends FluidSimulationOptions {
  /** Discover all compatible SpatialEffects, including force fields. Defaults to false. */
  supportSpatialEffects?: boolean;
  /** Opt into sampling ordinary ParticleForceFields directly on gas cells. Defaults to false. */
  supportForceFields?: boolean;
  /** Physical specific-temperature interval shared by simulation modifiers, independent of rendering. */
  temperatureRange: [number, number];
  /** Physical density interval shared by simulation modifiers, independent of rendering. */
  densityRange: [number, number];
  /** Nonnegative temperature-driven turbulenceNoiseStrength multiplier. Omitted means no shader evaluation. */
  turbulenceNoiseStrengthByTemperature?: ValueByParameter<number>;
  /** Nonnegative density-driven multiplier of turbulenceNoiseStrength; omitted means one without shader evaluation. */
  turbulenceNoiseStrengthByDensity?: ValueByParameter<number>;
  /** Nonnegative temperature-driven multiplier of vorticityStrength; omitted means one without shader evaluation. */
  vorticityStrengthByTemperature?: ValueByParameter<number>;
  /** Nonnegative density-driven multiplier of vorticityStrength; omitted means one without shader evaluation. */
  vorticityStrengthByDensity?: ValueByParameter<number>;
  /** Nonnegative temperature-driven multiplier of densityDissipation; omitted means one without shader evaluation. */
  densityDissipationByTemperature?: ValueByParameter<number>;
  /** Nonnegative density-driven multiplier of densityDissipation; omitted means one without shader evaluation. */
  densityDissipationByDensity?: ValueByParameter<number>;
  /** Nonnegative temperature multiplier of temperatureDissipation; omitted means no shader evaluation. */
  temperatureDissipationByTemperature?: ValueByParameter<number>;
  /** Nonnegative density-driven multiplier of temperatureDissipation; omitted means one without shader evaluation. */
  temperatureDissipationByDensity?: ValueByParameter<number>;
  /** Nonnegative temperature-driven multiplier of velocityDissipation; omitted means one without shader evaluation. */
  velocityDissipationByTemperature?: ValueByParameter<number>;
  /** Nonnegative density-driven multiplier of velocityDissipation; omitted means one without shader evaluation. */
  velocityDissipationByDensity?: ValueByParameter<number>;
  /** Nonnegative temperature-driven multiplier of colorDissipation; omitted means one without shader evaluation. */
  colorDissipationByTemperature?: ValueByParameter<number>;
  /** Nonnegative density-driven multiplier of colorDissipation; omitted means one without shader evaluation. */
  colorDissipationByDensity?: ValueByParameter<number>;
  /** Nonnegative temperature-driven turbulenceNoiseFrequency multiplier. Omitted means no shader evaluation. */
  turbulenceNoiseFrequencyByTemperature?: ValueByParameter<number>;
  /** Nonnegative density-driven multiplier of turbulenceNoiseFrequency; omitted means one without shader evaluation. */
  turbulenceNoiseFrequencyByDensity?: ValueByParameter<number>;

  /** Explicit initial reserve. Omission derives source/receiver demand during prepare(), rounded geometrically. */
  initialBrickCapacity: number;
  /** Recommended default is Auto. Supplying multigrid alone implies Multigrid. */
  pressureSolver: PressureSolver | `${PressureSolver}`;
  /** Optional cycle tuning; explicit pressureSolver always takes precedence. */
  multigrid?: MultigridOptions;
  /** Maximum resident bricks; omission uses maxActiveBricks. */
  maxBrickCapacity: number;
  /** Resident brick limit, also settable via maxBrickCapacity. Omission uses device and logical limits. */
  maxActiveBricks: number;
  /** Defaults to SemiLagrangian. MacCormack enables experimental bounded higher-order transport. */
  advectionMethod: AdvectionMethod | `${AdvectionMethod}`;
  /** Exponential density decay rate in inverse seconds. Zero preserves density. */
  densityDissipation: number;
  /** Density below this value is cleared along with its temperature and color. */
  densityCutoff: number;
  /** Exponential specific-temperature decay rate in inverse seconds. Zero preserves temperature. */
  temperatureDissipation: number;
  /** Exponential accumulated-color decay rate in inverse seconds. Zero preserves color. */
  colorDissipation: number;
  /** Exponential velocity decay rate in inverse seconds. Zero preserves velocity. */
  velocityDissipation: number;
  buoyancy: number;
  weight: number;
  sourceStrength: number;
  velocitySourceStrength: number;
  sourceTemperature: number;
  temperatureOverLifetime: DynamicValue<number>;
  /** Optional six-neighbor scalar mixing rate in inverse seconds. */
  scalarDiffusion: number;
  /** Curl-confinement strength; restores small-scale rotation lost to advection. */
  vorticityStrength: number;
  /** Independent animated noise acceleration in simulation units per second squared. */
  turbulenceNoiseStrength: number;
  turbulenceNoiseFrequency: number;
  turbulenceNoiseSpeed: number;
  turbulenceNoiseOctaves: number;
}

class GasSimulation extends FluidSimulation implements VolumeFieldProvider {
  temperatureRange: [number, number];
  densityRange: [number, number];
  turbulenceNoiseStrengthByTemperature?: ValueByParameter<number>;
  turbulenceNoiseStrengthByDensity?: ValueByParameter<number>;
  vorticityStrengthByTemperature?: ValueByParameter<number>;
  vorticityStrengthByDensity?: ValueByParameter<number>;
  densityDissipationByTemperature?: ValueByParameter<number>;
  densityDissipationByDensity?: ValueByParameter<number>;
  temperatureDissipationByTemperature?: ValueByParameter<number>;
  temperatureDissipationByDensity?: ValueByParameter<number>;
  velocityDissipationByTemperature?: ValueByParameter<number>;
  velocityDissipationByDensity?: ValueByParameter<number>;
  colorDissipationByTemperature?: ValueByParameter<number>;
  colorDissipationByDensity?: ValueByParameter<number>;
  turbulenceNoiseFrequencyByTemperature?: ValueByParameter<number>;
  turbulenceNoiseFrequencyByDensity?: ValueByParameter<number>;
  private readonly behaviorTemperatureRange = uniform(new THREE.Vector2(0, 1));
  private readonly behaviorDensityRange = uniform(new THREE.Vector2(0, 1));
  private behaviorKey = '';

  maxActiveBricks: number;
  initialBrickCapacity: number;
  pressureSolver: PressureSolver | `${PressureSolver}`;
  multigrid?: MultigridOptions;
  get maxBrickCapacity(): number { return this.maxActiveBricks; }
  set maxBrickCapacity(value: number) { this.maxActiveBricks = value; }
  private autoPressureSolver = PressureSolver.Iterative;
  private requiredBrickCapacity = 0;
  private readonly initialCapacityConfigured: boolean;
  private initialCapacityPrepared = false;
  /** @internal Conservative initial source-support and receiver demand, before any births. */
  readonly initialCapacityDemand = { bricks: 0, capacity: 0 };
  /** @internal Compact asynchronous snapshots; no GUI tuning fields. */
  readonly brickDiagnostics = { frame: 0, observedAt: 0, requested: 0, resident: 0,
    unfulfilled: 0, fresh: 0, released: 0, activeDispatch: 0, priorityDemand: [] as number[] };
  private guardBehaviorKey = '';
  private guardGasKeys = new WeakMap<object, object>();
  private guardGrid?: SparseVolumeGrid;
  private growthEvents = 0;
  private peakAllocatedBytes = 0;
  private volumeGrid: SparseVolumeGrid;
  private sourceGrid?: ParticleSpatialGrid;
  private readonly textureDimensions = new THREE.Vector3();
  private readonly exportDimensions = uniform(new THREE.Vector3());
  private readonly exportOffset = uniform(new THREE.Vector3());
  readonly domainChanges = { logical: 0, capacity: 0, quality: 0 };
  private densityTextureNode!: ReturnType<typeof storageTexture>;
  private colorTextureNode!: ReturnType<typeof storageTexture>;
  private textureAllocation?: StagedGPUAllocation<GasTexturePool>;
  private readonly requestedTextureDimensions = new THREE.Vector3();
  private sparseStructureKey = '';
  private clearNewNodes: ComputeNode[] = [];
  private clearTexturesNode?: ComputeNode;
  private sparseReadPending = false;
  private sparseReadFrame = 0;
  private sparseOverflowReported = false;
  advectionMethod: GasSimulationOptions['advectionMethod'];
  density: VolumeField;
  colorField: VolumeField;
  densityDissipation: number;
  densityCutoff: number;
  temperatureDissipation: number;
  colorDissipation: number;
  velocityDissipation: number;
  buoyancy: number;
  weight: number;
  sourceStrength: number;
  velocitySourceStrength: number;
  sourceTemperature: number;
  temperatureOverLifetime: DynamicValue<number>;
  scalarDiffusion: number;
  vorticityStrength: number;
  turbulenceNoiseStrength: number;
  turbulenceNoiseFrequency: number;
  turbulenceNoiseSpeed: number;
  turbulenceNoiseOctaves: number;

  private densityAttributeA!: StorageBufferAttribute;
  private densityAttributeB!: StorageBufferAttribute;
  private colorAttributeA!: StorageBufferAttribute;
  private colorAttributeB!: StorageBufferAttribute;
  private visualAttribute!: StorageBufferAttribute;
  private densityCurrent!: Vec4Storage;
  private densityNext!: Vec4Storage;
  private colorCurrent!: Vec4Storage;
  private colorNext!: Vec4Storage;
  private visualDensity!: Vec4Storage;
  private visualColor!: Vec4Storage;
  private readonly occupiedGasBounds = new THREE.Box3();
  private maximaMinimum = new THREE.Vector3();
  private maximaCellSize = 1;
  protected override get automaticFieldBounds(): THREE.Box3 { return this.occupiedGasBounds; }

  private maximaAttribute!: StorageBufferAttribute;
  private maxima!: AtomicUintStorage;
  private densityTexture!: Storage3DTexture;
  private colorTexture!: Storage3DTexture;
  private gpuCacheKey = '';
  private velocityNodes = new WeakMap<object, ComputeNode>();
  private velocitySourceNode?: ComputeNode;
  private sourceNodes = new WeakMap<object, ComputeNode[]>();
  private scalarModuleNodes = new WeakMap<object, ComputeNode[]>();
  private scalarSourceNodes = new WeakMap<object, ComputeNode>();
  private solidClearNodes = new WeakMap<object, ComputeNode>();
  private outputNodes = new WeakMap<object, ComputeNode>();
  private pendingPreviousBounds?: THREE.Box3;
  private readonly previousMinimum = uniform(new THREE.Vector3());
  private readonly previousCellSize = uniform(1);
  private remapNodes = new WeakMap<object, ComputeNode>();
  private remapVelocityNode?: ComputeNode;
  private visualCacheKey = '';
  private visualSourceNode?: ComputeNode;
  private visualOutputNodes = new WeakMap<object, ComputeNode>();
  private maximaNodes = new WeakMap<object, ComputeNode>();
  private maximaResetNode?: ComputeNode;
  private readonly densityDissipationNode = uniform(0) as FloatUniform;
  private readonly densityCutoffNode = uniform(0) as FloatUniform;
  private readonly temperatureDissipationNode = uniform(0) as FloatUniform;
  private readonly colorDissipationNode = uniform(0) as FloatUniform;
  private readonly velocityDissipationNode = uniform(0) as FloatUniform;
  private readonly scalarDiffusionNode = uniform(0) as FloatUniform;
  private curlAttribute!: StorageBufferAttribute;
  private curl!: Vec4Storage;
  private curlNode?: ComputeNode;
  private confinementNodes = new WeakMap<object, ComputeNode>();
  private readonly vorticityNode = uniform(0) as FloatUniform;
  private advectionAttributes: StorageBufferAttribute[] = [];
  private velocityAdvected!: Vec4Storage;
  private densityAdvected!: Vec4Storage;
  private colorAdvected!: Vec4Storage;
  private advectionNodes = new WeakMap<object, ComputeNode>();
  private pressureProjection?: FluidPressureProjection;
  private poolAllocation?: StagedGPUAllocation<GasPool>;
  private poolConfiguration = '';
  /** @internal Capacity changes deliberately have no graph-building or compilation phase. */
  readonly capacityMetrics = { storagePreparationMs: 0, graphConstructionMs: 0, compilationMs: 0 };
  private poolContext?: GPUParticleUpdateContext;
  private poolParticleGrid?: ParticleSpatialGrid;
  private preparingPool = false;

  private permanentEffects: SpatialEffect[] = [];
  private transientEffects: SpatialEffect[] = [];
  private spatialEffectsKey = '';
  private gasModules: GasModule[] = [];
  private gasModulesKey = '';
  private effectNodes = new Map<string, WeakMap<object, ComputeNode>>();
  private visualStateNodes = new WeakMap<object, ComputeNode>();

  public override prepare(context: ModuleExecutionContext): void {
    super.prepare(context);
    this.prepareGasEffects(context.system);
  }

  /** Virtual shorthand for broad discovery through the existing requirement list. */
  get supportSpatialEffects(): boolean { return this.requireSpatialEffects?.includes(SpatialEffect) ?? false; }
  set supportSpatialEffects(enabled: boolean) {
    const requirements = this.requireSpatialEffects ?? [];
    this.requireSpatialEffects = enabled
      ? [...new Set([...requirements, SpatialEffect])]
      : requirements.filter(entry => entry !== SpatialEffect);
  }

  /** Effective force-field support; broad spatial-effect discovery always includes force fields. */
  get supportForceFields(): boolean {
    return this.supportSpatialEffects || (this.requireSpatialEffects?.includes(ParticleForceField) ?? false);
  }
  set supportForceFields(enabled: boolean) {
    const requirements = this.requireSpatialEffects ?? [];
    this.requireSpatialEffects = enabled
      ? [...new Set([...requirements, ParticleForceField])]
      : requirements.filter(entry => entry !== ParticleForceField);
  }

  private prepareGasEffects(system: ParticleSystem): void {
    this.gasModules = GasModule.collect(system, this.tags, 'simulation');
    this.gasModulesKey = this.gasModules.map(module => module.graphKey('simulation')).join('|');
    const affectors = new Set(this.spatialEffects.get(GasAffector));
    const effects = this.spatialEffects.filter(effect => effect.visible && effect.supportsGPU
      && (effect.modifiesParticles || affectors.has(effect as GasAffector))
      && (!this.tags?.length || !effect.tags?.length || tagsIntersect(this.tags, effect.tags)))
      .sort((a, b) => a.priority - b.priority);
    for (const effect of effects) {
      effect.syncGPUTransform(system);
      if (effect instanceof GasAffector) effect.evaluateDynamicGPU.sync();
    }
    const key = effects.map(effect => [effect.uuid, effect.version, effect.priority, effect.feather,
      effect.inverted, effect.geometry?.uuid, effect.bakedFieldResolution, effect.updatePolicy,
      effect.tags?.join(','),
      effect instanceof GasAffector ? [effect.evaluateDynamicGPU.version, effect.colorRate,
        ...['density', 'densityMultiplier', 'temperature', 'velocity', 'drag', 'color']
          .map(name => effect[name as keyof GasAffector] != null)] : '',
    ].join(':')).join('|') + `:${this.tags?.join(',')}`;
    this.permanentEffects = effects.filter(effect => effect.priority < 0);
    this.transientEffects = effects.filter(effect => effect.priority >= 0);
    if (key === this.spatialEffectsKey) return;
    this.spatialEffectsKey = key;
    this.poolAllocation?.cancelPending();
    this.effectNodes = new Map();
    this.visualStateNodes = new WeakMap();
    this.visualOutputNodes = new WeakMap();
  }

  /** Each effect uses a small independent binding set; no effects means no additional cell dispatch. */
  private applySpatialEffects(
    phase: 'velocity' | 'scalars' | 'visual', density: Vec4Storage, color: Vec4Storage,
    velocity: Vec4Storage, context: GPUParticleUpdateContext, renderer: ParticleSpatialGridRenderer,
  ): void {
    const effects = phase === 'visual' ? this.transientEffects : this.permanentEffects;
    const mask = context.system.getGPUFilterTagMask(this.tags) ?? 0xffffffff;
    for (const effect of effects) {
      const key = `${effect.uuid}:${phase}`;
      let nodes = this.effectNodes.get(key);
      if (!nodes) { nodes = new WeakMap(); this.effectNodes.set(key, nodes); }
      const node = nodes.get(density) ?? this.computeCells(index => {
        If(this.isSolid(index).not(), () => {
          const original = density.element(index).toVar();
          const originalColor = color.element(index).toVar();
          // Visual velocity occupies otherwise unused components of the two existing visual planes.
          const initialVelocity = phase === 'visual'
            ? vec3(original.zw, originalColor.w) : velocity.element(index).xyz;
          const cell: GasCellGPU = {
            position: this.cellCenter(this.cellCoordinate(index)),
            density: original.x.toVar(), temperature: original.y.div(original.x.max(1e-6)).toVar(),
            color: original.x.greaterThan(1e-6)
              .select(originalColor.xyz.div(original.x.max(1e-6)), vec3(1)).toVar(),
            velocity: initialVelocity.toVar(),
          };
          sampleGasEffectGPU(effect, cell, index, this.cellSizeNode, mask, context);
          if (phase === 'velocity') velocity.element(index).assign(vec4(this.clampVelocity(cell.velocity), 0));
          else {
            const kept = cell.density.greaterThan(0);
            density.element(index).assign(vec4(cell.density, cell.temperature.mul(cell.density),
              phase === 'visual' ? cell.velocity.xy : vec3(0).xy));
            color.element(index).assign(vec4(kept.select(cell.color.mul(cell.density), vec3(0)),
              phase === 'visual' ? cell.velocity.z : float(0)));
          }
        });
      });
      nodes.set(density, node);
      this.benchmarks.span(`spatialEffects:${phase}`, () => renderer.compute(node));
    }
  }

  constructor(options: Partial<GasSimulationOptions> = {}) {
    super({
      ...options,
      // Colliders remain native solver boundaries; ordinary particle modifiers require an explicit opt-in.
      requireSpatialEffects: [...new Set([FluidCollider,
        ...(acceptMultiple(options.requireSpatialEffects) ?? [])])],
      automaticPadding: options.automaticPadding ?? true,
    });
    if (options.supportForceFields !== undefined) this.supportForceFields = options.supportForceFields;
    if (options.supportSpatialEffects !== undefined) this.supportSpatialEffects = options.supportSpatialEffects;
    this.temperatureRange = [...(options.temperatureRange ?? [0, 1])];
    this.densityRange = [...(options.densityRange ?? [0, 1])];
    for (const name of behaviorCoefficients) {
      this[`${name}ByTemperature`] = options[`${name}ByTemperature`];
      this[`${name}ByDensity`] = options[`${name}ByDensity`];
    }
    this.syncBehaviorParameters();
    this.advectionMethod = options.advectionMethod ?? AdvectionMethod.SemiLagrangian;
    this.densityDissipation = Math.max(0, options.densityDissipation ?? 0.6);
    this.densityCutoff = Math.max(0, options.densityCutoff ?? 0.01);
    this.temperatureDissipation = Math.max(0, options.temperatureDissipation ?? 1.2);
    this.colorDissipation = Math.max(0, options.colorDissipation ?? this.densityDissipation);
    this.velocityDissipation = Math.max(0, options.velocityDissipation ?? 0.6);
    this.buoyancy = options.buoyancy ?? 1;
    this.weight = options.weight ?? 0;
    this.sourceStrength = options.sourceStrength ?? 1;
    this.velocitySourceStrength = options.velocitySourceStrength ?? 0.12;
    this.sourceTemperature = options.sourceTemperature ?? 0;
    this.temperatureOverLifetime = options.temperatureOverLifetime ?? 1;
    this.scalarDiffusion = Math.max(0, options.scalarDiffusion ?? 0);
    this.vorticityStrength = Math.max(0, options.vorticityStrength ?? 0);
    this.turbulenceNoiseStrength = Math.max(0, options.turbulenceNoiseStrength ?? 0);
    this.turbulenceNoiseFrequency = Math.max(0, options.turbulenceNoiseFrequency ?? 0.75);
    this.turbulenceNoiseSpeed = options.turbulenceNoiseSpeed ?? 0.2;
    this.turbulenceNoiseOctaves = Math.max(1, Math.floor(options.turbulenceNoiseOctaves ?? 2));

    this.pressureSolver = options.pressureSolver
      ?? (options.multigrid !== undefined ? PressureSolver.Multigrid : PressureSolver.Auto);
    this.multigrid = options.multigrid;
    this.initialCapacityConfigured = options.initialBrickCapacity !== undefined;
    this.maxActiveBricks = options.maxBrickCapacity ?? options.maxActiveBricks ?? Number.MAX_SAFE_INTEGER;
    // A single bootstrap slot avoids treating a fixed reserve as initial physical-support demand.
    // prepareResources measures source/receiver support before the simulation becomes visible.
    this.initialBrickCapacity = options.initialBrickCapacity ?? 1;
    if (!Number.isSafeInteger(this.initialBrickCapacity) || this.initialBrickCapacity < 1
      || !Number.isSafeInteger(this.maxActiveBricks) || this.maxActiveBricks < this.initialBrickCapacity) {
      throw new RangeError('Gas brick capacities must be positive integers with initial <= maximum.');
    }
    this.volumeGrid = new SparseVolumeGrid({ ...this.spatialGridOptions, bounds: this.bounds },
      Math.min(this.initialBrickCapacity, this.gridDimensions.x * this.gridDimensions.y * this.gridDimensions.z
        / (2 ** this.spatialGridOptions!.cellSubdivisions!) ** 3), this.gridDimensions);
    this.benchmarks.register('allocatedBricks', { type: 'gauge', get: () => this.volumeGrid.capacity });
    this.benchmarks.register('peakAllocatedBytes', { type: 'gauge', unit: 'bytes',
      get: () => this.peakAllocatedBytes = Math.max(this.peakAllocatedBytes, this.allocatedBytes) });
    this.benchmarks.register('growthEvents', { type: 'counter', get: () => this.growthEvents });
    this.benchmarks.register('allocatedBytes', { type: 'gauge', unit: 'bytes', get: () => this.allocatedBytes });
    this.sparseStructureKey = [this.volumeGrid.brickSubdivisions,
      this.volumeGrid.cellSubdivisions].join('|');
    this.resizeGridFields(this.volumeGrid.cellCount);
    this.allocateGasFields();
    this.exportDimensions.value.copy(this.gridDimensions);
    this.density = {
      texture: this.densityTexture,
      bounds: this.bounds.clone(),
      resolution: this.gridDimensions.clone(),
      textureResolution: this.textureDimensions,
      channels: 4,
      parameterChannels: { temperature: 1, speed: 2, vorticity: 3 },
      sampleVelocityGPU: position => this.sampleVelocity(position),
      parametersPremultiplied: true,
      version: 0,
    };
    this.colorField = {
      texture: this.colorTexture,
      bounds: this.bounds.clone(),
      resolution: this.density.resolution.clone(),
      textureResolution: this.textureDimensions,
      channels: 4,
      version: 0,
    };
  }

  protected override get gridFieldCellCount(): number { return 1; }

  /** Density field available to volume renderers and other field consumers. */
  public getVolumeField(): VolumeField {
    return this.density;
  }

  /** Color field corresponding to getVolumeField. */
  public getVolumeColorField(): VolumeField {
    return this.colorField;
  }

  public override async prepareResources(
    system: import('../core/ParticleSystem').default,
    renderer: ParticleSpatialGridRenderer,
  ): Promise<void> {
    await this.prepareInitialCapacity(system, renderer);
    this.volumeGrid.reductionCellCount = this.maximumResidentCapacity(renderer) * this.volumeGrid.cellsPerBrick + 1;
    await super.prepareResources(system, renderer);
    await this.volumeGrid.prepareLayout(renderer);
    this.prepareGasEffects(system);
    this.fieldAttributes.forEach(attribute => initializeStorageAttribute(renderer, attribute));
    const textures = renderer as ParticleSpatialGridRenderer & { initTexture?: (texture: THREE.Texture) => void };
    textures.initTexture?.(this.densityTexture);
    textures.initTexture?.(this.colorTexture);
    await this.getPressureProjection().prepare(
      renderer, this.velocityNext, this.velocityCurrent, this.pressureIterations,
    );
    const compiler = renderer as ParticleSpatialGridRenderer & {
      compileComputeAsync?: (nodes: ComputeNode[]) => Promise<void>;
    };
    await compiler.compileComputeAsync?.([
      this.getRemapNode(this.densityCurrent, this.colorCurrent, this.densityNext, this.colorNext),
      this.getRemapNode(this.densityNext, this.colorNext, this.densityCurrent, this.colorCurrent),
    ]);
    if (compiler.compileComputeAsync) await this.prepareTransport(system, renderer);
    await this.prepareGuardResources(system, renderer);

  }

  /** Measure source geometry at birth, not the empty rectangular guard domain or future particle trajectories. */
  private async prepareInitialCapacity(system: ParticleSystem, renderer: ParticleSpatialGridRenderer): Promise<void> {
    if (this.initialCapacityPrepared || this.sparseReadFrame || this.initialCapacityConfigured) return;
    const maximum = this.maximumResidentCapacity(renderer), requested = new Set<string>();
    const brick = this.volumeGrid.brickSize;
    const support = (bounds: THREE.Box3) => {
      if (bounds.isEmpty() || ![...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)) return;
      const low = bounds.min.clone().divideScalar(brick).floor().addScalar(-1);
      const high = bounds.max.clone().divideScalar(brick).floor().addScalar(1);
      for (let z = low.z; z <= high.z; z++) for (let y = low.y; y <= high.y; y++) {
        for (let x = low.x; x <= high.x; x++) {
          requested.add(`${x},${y},${z}`);
          if (requested.size >= maximum) return;
        }
      }
    };
    system.updateWorldMatrix(true, false);
    const toSimulation = system.getSimulationToWorldMatrix().clone().invert();
    for (const emitter of system.emitters) {
      if (this.tags && emitter.tags && !tagsIntersect(this.tags, emitter.tags)) continue;
      if (!(maxDynamicNumber(emitter.rate) > 0 || maxDynamicNumber(emitter.rateOverDistance) > 0
        || emitter.bursts.some(burst => maxDynamicNumber(burst.count) > 0))) {
        continue;
      }
      const source = emitter.source, initial = emitter.initialValues;
      source.updateWorldMatrix(true, false);
      source.geometry.computeBoundingBox();
      if (!source.geometry.boundingBox) continue;
      const bounds = source.geometry.boundingBox.clone().applyMatrix4(source.matrix);
      const position = typeof initial.position === 'function' ? initial.position(0) : initial.position;
      const scale = typeof initial.scale === 'function' ? initial.scale(0) : initial.scale;
      const lowScale = minDynamicVector(scale ?? 1), highScale = maxDynamicVector(scale ?? 1);
      const radius = Math.max(this.cellSize, ...lowScale.toArray().map(Math.abs),
        ...highScale.toArray().map(Math.abs)) * 0.5;
      bounds.min.add(minDynamicVector(position));
      bounds.max.add(maxDynamicVector(position));
      bounds.expandByScalar(Math.max(radius, this.cellSize));
      bounds.applyMatrix4(toSimulation.clone().multiply(source.parent?.matrixWorld ?? system.matrixWorld));
      support(bounds);
    }
    for (const particle of system.particles) if (particle.alive) {
      const size = particle.scale.clone();
      size.set(Math.abs(size.x), Math.abs(size.y), Math.abs(size.z)).max(new THREE.Vector3().setScalar(this.cellSize));
      support(new THREE.Box3().setFromCenterAndSize(particle.position, size));
    }
    this.initialCapacityDemand.bricks = requested.size;
    const desired = Math.min(maximum, 2 ** Math.ceil(Math.log2(Math.max(1, requested.size))));
    if (desired > this.volumeGrid.capacity) {
      const context = system.gpuSimulation.prepareContext(renderer as WebGPURenderer);
      const grid = this.getParticleSpatialGrid(system)!;
      this.poolContext = context; this.poolParticleGrid = grid;
      this.ensurePoolAllocation(renderer, context, grid);
      this.fieldAttributes.forEach(attribute => initializeStorageAttribute(renderer, attribute, false));
      this.poolAllocation!.request(desired);
      await this.poolAllocation!.whenPrepared();
      // Initial support is a reserve, not measured live pressure to immediately request another tier.
      this.poolAllocation!.request(0);
      this.poolAllocation!.commit();
    }
    this.initialCapacityDemand.capacity = this.volumeGrid.capacity;
    this.initialCapacityPrepared = true;
  }

  /** Capture predictable ping-pong/source/export variants against persistent particle bindings. */
  private async prepareTransport(system: import('../core/ParticleSystem').default,
    renderer: ParticleSpatialGridRenderer): Promise<void> {
    const native = renderer as WebGPURenderer;
    const context = system.gpuSimulation.prepareContext(native);
    const grid = this.getParticleSpatialGrid(system)!;
    const nodes: ComputeNode[] = [], original = renderer.compute;
    const density = this.densityCurrent, color = this.colorCurrent;
    const nextDensity = this.densityNext, nextColor = this.colorNext;
    const densityVersion = this.density.version, colorVersion = this.colorField.version;
    const previousPreparing = this.preparingPool;
    const collect = () => {
      renderer.compute = value => { nodes.push(...(Array.isArray(value) ? value : [value])); };
      try {
        grid.rebuild(renderer, context.buffers);
        this.volumeGrid.updateDispatch(renderer);
        this.volumeGrid.rebuild(context, renderer, this.densityCurrent, this.velocityCurrent,
          this.boundsMinNode, this.cellSizeNode, this.densityCutoffNode, system.getGPUFilterTagMask(this.tags));
        this.clearNewBricks(renderer);
        if (this.advectionMethod === AdvectionMethod.MacCormack) this.ensureAdvectionFields();
        this.syncSimulationUniforms();
        this.preparingPool = true;
        this.getPressureProjection().forPreparation(() => {
          for (let phase = 0; phase < 2; phase++) this.computeTransport(context, renderer, grid);
        });
        if (system.renderers.some(component => component.supportsGPUInput)) {
          const render = system.gpuSimulation.prepareRenderBuffers(native);
          this.renderGPU(context, render, renderer, grid);
          // Both scalar identities can be current when a paused/render-only refresh occurs.
          [this.densityCurrent, this.densityNext] = [this.densityNext, this.densityCurrent];
          [this.colorCurrent, this.colorNext] = [this.colorNext, this.colorCurrent];
          this.renderGPU(context, render, renderer, grid);
        }
      } finally {
        renderer.compute = original; this.preparingPool = previousPreparing;
        this.densityCurrent = density; this.densityNext = nextDensity;
        this.colorCurrent = color; this.colorNext = nextColor;
        this.density.version = densityVersion; this.colorField.version = colorVersion;
      }
    };
    this.volumeGrid.capturePreparation(collect);
    await this.benchmarks.spanAsync('transportPipelinePreparation',
      () => native.compileComputeAsync([...new Set(nodes)]));
  }

  /** Internal debug-grid access, not part of the public module contract. @internal */
  protected override get visualizationGrid(): SparseVolumeGrid | undefined { return this.volumeGrid; }

  public override computeGPU(
    context: GPUParticleUpdateContext,
    renderer: ParticleSpatialGridRenderer,
    grid?: ParticleSpatialGrid,
  ): void {
    if (!grid) throw new Error('GasSimulation requires a GPU spatial grid.');
    if (!Object.values(PressureSolver).includes(this.pressureSolver as PressureSolver)) {
      throw new RangeError('Unknown gas pressureSolver.');
    }
    if (!Object.values(AdvectionMethod).includes(this.advectionMethod as AdvectionMethod)) {
      throw new RangeError('Unknown gas advectionMethod.');
    }
    super.computeGPU(context, renderer, grid);
    this.ensureGridResolution(renderer, grid);
    this.updateExportLayout(renderer);
    this.poolContext = context;
    this.poolParticleGrid = grid;
    this.ensurePoolAllocation(renderer, context, grid);
    this.poolAllocation!.commit();
    if (this.requiredBrickCapacity > 0) {
      this.poolAllocation!.request(Math.min(this.requiredBrickCapacity, this.poolAllocation!.maximumCapacity));
    }
    this.requiredBrickCapacity = 0;
    if (this.advectionMethod === AdvectionMethod.MacCormack) this.ensureAdvectionFields();
    this.syncSimulationUniforms();
    this.refreshBounds(grid, renderer);
    this.volumeGrid.bounds.copy(this.bounds);
    this.benchmarks.span('brickActivation', () => {
      this.volumeGrid.rebuild(context, renderer, this.densityCurrent, this.velocityCurrent,
        this.boundsMinNode, this.cellSizeNode, this.densityCutoffNode,
        context.system.getGPUFilterTagMask(this.tags), this.pendingPreviousBounds, 3, this.pendingPreviousGrid,
        this.sparseReadFrame + 1);
    });
    if ((++this.sparseReadFrame % 60 === 0 || this.benchmarks.enabled || this.volumeGrid.capacity < Math.min(
      this.maxActiveBricks, this.volumeGrid.brickCount,
    )) && !this.sparseReadPending) {
      this.sparseReadPending = true;
      const volumeGrid = this.volumeGrid;
      void this.readGridDiagnostics(renderer).then(diagnostics => {
        if (volumeGrid !== this.volumeGrid) return;
        Object.assign(this.brickDiagnostics, { frame: diagnostics.frame, observedAt: performance.now(),
          requested: diagnostics.requestedBricks, resident: diagnostics.activeBricks,
          unfulfilled: diagnostics.overflowedBricks, fresh: diagnostics.freshBricks,
          released: diagnostics.releasedBricks, activeDispatch: diagnostics.activeDispatchEntries,
          priorityDemand: diagnostics.priorityDemand });
        this.requiredBrickCapacity = this.capacityDemand(diagnostics.requestedBricks,
          this.poolAllocation?.metrics.preparationMs, volumeGrid.capacity);
        this.benchmarks.set('activeBricks', diagnostics.activeBricks);
        if (diagnostics.overflowedBricks > 0 && this.volumeGrid.capacity >= this.maxActiveBricks
          && !this.sparseOverflowReported) {
          this.sparseOverflowReported = true;
          console.warn('GasSimulation sparse brick budget exceeded; increase maxActiveBricks.', diagnostics);
        }
      }).catch(() => {
        // Readback may be cancelled by teardown; it must not reject the render loop.
      }).finally(() => { this.sparseReadPending = false; });
    }
    if (!this.pendingPreviousBounds) this.clearNewBricks(renderer);
    this.remapFields(renderer);
    this.computeSolidField(context, renderer);
    this.getPressureProjection().initialize(renderer, this.velocityCurrent);
    this.computeTransport(context, renderer, grid);
    if (this.showGridHelper) this.volumeGrid.updateVisualization(renderer, this.densityCurrent, this.densityCutoffNode);
    this.updateBoundsHelper(context.system);
  }

  /** One source bucket per simulation brick avoids scanning fine empty cells inside each splat. */
  private getSourceGrid(context: GPUParticleUpdateContext, renderer: ParticleSpatialGridRenderer,
    grid: ParticleSpatialGrid): ParticleSpatialGrid {
    // A staged field replacement captures the current index without submitting live indexing work.
    if (this.preparingPool && this.sourceGrid) return this.sourceGrid;
    const quality = grid.volumeQualityTier;
    if (!this.sourceGrid || this.sourceGrid.brickSubdivisions !== grid.brickSubdivisions) {
      this.sourceGrid?.dispose(renderer);
      this.sourceGrid = new ParticleSpatialGrid({ bounds: this.bounds,
        brickSubdivisions: grid.brickSubdivisions, cellSubdivisions: 0, autoExpand: false,
        minVolumeQuality: quality, maxVolumeQuality: quality });
    } else if (!this.sourceGrid.bounds.equals(this.bounds) || this.sourceGrid.volumeQualityTier !== quality) {
      if (this.sourceGrid.volumeQualityTier !== quality) {
        this.sourceGrid.setOptions({ minVolumeQuality: quality, maxVolumeQuality: quality });
      }
      this.sourceGrid.setBounds(this.bounds);
    }
    this.benchmarks.span('sourceSpatialIndex', () => this.sourceGrid!.rebuild(renderer, context.buffers));
    return this.sourceGrid;
  }

  /** Resource-local graphs can be compiled off to the side without advancing the current fields. */
  private computeTransport(context: GPUParticleUpdateContext, renderer: ParticleSpatialGridRenderer,
    grid: ParticleSpatialGrid): void {
    const dt = context.deltaTimeNode;
    const tagMask = context.system.getGPUFilterTagMask(this.tags);
    const sourceGrid = this.getSourceGrid(context, renderer, grid);

    const cacheKey = [grid.resourceVersion, context.buffers.version, tagMask,
      this.buoyancy, this.weight, this.velocitySourceStrength, this.sourceStrength,
      this.sourceTemperature, Boolean(this.temperatureOverLifetime), this.turbulenceNoiseStrength,
      this.turbulenceNoiseFrequency,
      this.turbulenceNoiseSpeed, this.turbulenceNoiseOctaves, this.advectionMethod,
      this.behaviorKey, this.gasModulesKey].join('|');
    if (cacheKey !== this.gpuCacheKey) {
      this.gpuCacheKey = cacheKey;
      this.velocityNodes = new WeakMap();
      this.velocitySourceNode = undefined;
      this.sourceNodes = new WeakMap();
      this.scalarModuleNodes = new WeakMap();
      this.scalarSourceNodes = new WeakMap();
      this.solidClearNodes = new WeakMap();
      this.outputNodes = new WeakMap();
      this.confinementNodes = new WeakMap();
    }

    if (this.advectionMethod === AdvectionMethod.MacCormack) {
      this.predictAdvection(this.velocityCurrent, this.velocityAdvected, context, renderer);
    }
    const velocityDensity = this.densityCurrent;
    const velocity = this.velocityNodes.get(velocityDensity) ?? this.computeCells(index => {
      const coordinate = this.cellCoordinate(index);
      const center = this.cellCenter(coordinate);
      let previous = this.advectField(this.velocityCurrent, this.velocityAdvected, center, dt, index).xyz;
      const density = velocityDensity.element(index);
      const modules = this.evaluateGasModules(density, this.colorCurrent.element(index), previous, center, context);
      if (modules) previous = modules.cell.velocity;
      const temperature = modules?.cell.temperature ?? density.y.div(max(density.x, float(1e-6)));
      const state = this.behaviorState(density, [
        'turbulenceNoiseStrength', 'turbulenceNoiseFrequency', 'velocityDissipation',
      ]);
      const lift = temperature.mul(modules?.coefficients.buoyancy ?? float(this.buoyancy))
        .sub((modules?.cell.density ?? density.x).mul(this.weight));
      const noiseTime = context.elapsedTimeNode.mul(this.turbulenceNoiseSpeed);
      const noiseSettings = {
        octaves: this.turbulenceNoiseOctaves,
        frequency: this.turbulenceNoiseFrequency,
        lacunarity: 2,
        persistence: 0.5,
        time: 0,
        offset: new THREE.Vector3(),
      };
      // Preserve the old noise graph exactly when frequency modulation is absent.
      const frequency = modules?.coefficients.turbulenceNoiseFrequency
        ?? this.effectiveBehavior('turbulenceNoiseFrequency',
        float(Math.max(0, this.turbulenceNoiseFrequency)), state);
      const variableFrequency = !!modules || this.turbulenceNoiseFrequencyByTemperature != null
        || this.turbulenceNoiseFrequencyByDensity != null;
      const noise = (offset: THREE.Vector3) => variableFrequency
        ? generateGPUParticleNoise4D(center.add(vec3(offset)).mul(frequency),
          { ...noiseSettings, frequency: 1, offset: new THREE.Vector3() }, noiseTime)
        : generateGPUParticleNoise4D(center, { ...noiseSettings, offset }, noiseTime);
      const turbulence = vec3(
        noise(new THREE.Vector3(17.1, 31.7, 47.3)),
        noise(new THREE.Vector3(59.7, 11.3, 23.9)),
        noise(new THREE.Vector3(37.5, 71.9, 5.7)),
      ).mul(2).sub(1).mul(modules?.coefficients.turbulenceNoiseStrength
        ?? this.effectiveBehavior('turbulenceNoiseStrength', float(this.turbulenceNoiseStrength), state));
      const velocityRate = modules?.coefficients.velocityDissipation
        ?? this.effectiveBehavior('velocityDissipation', this.velocityDissipationNode, state);
      const velocityRetention = pow(float(Math.E), dt.mul(velocityRate).mul(-1));
      const advected = vec3(previous)
        .mul(velocityRetention)
        .add(this.forceNode.mul(dt))
        .add(vec3(0, 1, 0).mul(lift.mul(dt)))
        .add(turbulence.mul(dt));
      this.velocityNext.element(index).assign(
        this.isSolid(index).select(vec4(0), vec4(this.clampVelocity(advected), 0)),
      );
    });
    this.velocityNodes.set(velocityDensity, velocity);
    this.benchmarks.span('advectionForces', () => renderer.compute(velocity));

    const velocitySources = this.velocitySourceNode ?? this.computeCells(index => {
      If(this.volumeGrid.sourceActive(index), () => {
        const coordinate = this.cellCoordinate(index);
        const center = this.cellCenter(coordinate);
        const momentum = vec3(0).toVar('gasSourceMomentum');
        const sourceMass = float(0).toVar('gasSourceMass');
        const radius = max(this.cellSizeNode.mul(1.5), sourceGrid.getMaxParticleRadiusNode());
        sourceGrid.forEachParticleInRadius(center, radius, (particle, distanceSq) => {
          const particleRadius = this.splatRadius(particle.scale);
          const weight = max(float(0), float(1).sub(distanceSq.sqrt().div(particleRadius)));
          const mass = max(particle.mass, float(0)).mul(particle.alpha).mul(weight)
            .mul(this.sourceStep(particle, dt));
          sourceMass.addAssign(mass);
          momentum.addAssign(particle.velocity.mul(mass));
        }, { tagMask });
        const blend = clamp(float(1).sub(pow(float(Math.E), sourceMass.mul(-this.velocitySourceStrength))), 0, 1);
        const previous = vec3(this.velocityNext.element(index).xyz);
        const updated = mix(previous, momentum.div(max(sourceMass, float(1e-6))), blend);
        this.velocityNext.element(index).assign(vec4(this.clampVelocity(updated), 0));
      });
    });
    this.velocitySourceNode = velocitySources;
    this.benchmarks.span('velocitySourceInjection', () => renderer.compute(velocitySources));

    this.applyVorticity(context, renderer);
    this.applySpatialEffects('velocity', this.densityCurrent, this.colorCurrent, this.velocityNext, context, renderer);
    this.solveProjection(renderer, this.velocityNext, this.velocityCurrent);

    const densityCurrent = this.densityCurrent;
    const colorCurrent = this.colorCurrent;
    let densityNext = this.densityNext;
    let colorNext = this.colorNext;
    if (this.advectionMethod === AdvectionMethod.MacCormack) {
      this.predictAdvection(densityCurrent, this.densityAdvected, context, renderer);
      this.predictAdvection(colorCurrent, this.colorAdvected, context, renderer);
    }
    // Custom rules may read velocity/color and parameter LUTs together; reuse the existing split-output
    // path to keep both advection methods within WebGPU's eight-storage-buffer limit.
    const targets = this.advectionMethod === AdvectionMethod.MacCormack || this.gasModules.length
      ? [false, true] : [null];

    // MacCormack's correction already occupies the binding budget. When rules are present,
    // finish advection first, then use the existing ping-pong pair for local rules/diffusion/decay.
    const buildScalars = (inputDensity: Vec4Storage, inputColor: Vec4Storage,
      outputDensity: Vec4Storage, outputColor: Vec4Storage, transport: boolean) =>
      targets.map(writeColor => this.computeCells(index => {
        const coordinate = this.cellCoordinate(index);
        const center = this.cellCenter(coordinate);
        let previousDensity = transport
          ? this.advectField(inputDensity, this.densityAdvected, center, dt, index) : inputDensity.element(index);
        let previousColor = transport
          ? this.advectField(inputColor, this.colorAdvected, center, dt, index) : inputColor.element(index);
        if (transport && this.advectionMethod === AdvectionMethod.MacCormack) {
          [previousDensity, previousColor] = this.limitSpecificFields(
            previousDensity, previousColor, inputDensity, inputColor,
            center.sub(this.sampleVelocity(center).mul(dt)),
          );
        }
        if (transport && this.gasModules.length) {
          if (writeColor !== false) outputColor.element(index).assign(previousColor);
          if (writeColor !== true) outputDensity.element(index).assign(previousDensity);
          return;
        }
        // Gas rules operate on shader-local specific values; each transport stage commits only its owned fields.
        const modules = this.evaluateGasModules(previousDensity, previousColor,
          this.velocityCurrent.element(index).xyz, center, context,
          mix(previousDensity, this.neighborAverage(inputDensity, coordinate),
            clamp(this.scalarDiffusionNode.mul(dt), 0, 1)));
        if (modules) {
          previousDensity = vec4(modules.cell.density, modules.cell.temperature.mul(modules.cell.density), 0, 0);
          previousColor = vec4(modules.cell.color.mul(modules.cell.density), 0);
        }
        const diffusion = clamp((modules?.coefficients.scalarDiffusion ?? this.scalarDiffusionNode).mul(dt), 0, 1);
        const mixedDensity = mix(previousDensity, this.neighborAverage(inputDensity, coordinate), diffusion);
        const mixedColor = mix(previousColor, this.neighborAverage(inputColor, coordinate), diffusion);
        const gridCoordinate = vec3(coordinate);
        const edgeDistances = (['x', 'y', 'z'] as const).flatMap((axis) => [
          this.closedMinNode[axis].greaterThan(0).select(this.dimensionsNode[axis], gridCoordinate[axis]),
          this.closedMaxNode[axis].greaterThan(0).select(this.dimensionsNode[axis],
            this.dimensionsNode[axis].sub(1).sub(gridCoordinate[axis])),
        ]);
        const edgeDistance = edgeDistances.reduce((distance, value) => min(distance, value));
        // An absorbing edge layer with a decay rate, not a per-frame multiplier.
        const boundaryRetention = pow(clamp(edgeDistance.div(2), 0, 1), dt.mul(60));
        // Evaluate coefficients from the transported/mixed state before any decay is applied.
        const state = this.behaviorState(mixedDensity, [
          'densityDissipation', 'temperatureDissipation', 'colorDissipation',
        ]);
        const densityRate = modules?.coefficients.densityDissipation
          ?? this.effectiveBehavior('densityDissipation', this.densityDissipationNode, state);
        const temperatureRate = modules?.coefficients.temperatureDissipation
          ?? this.effectiveBehavior('temperatureDissipation', this.temperatureDissipationNode, state);
        const colorRate = modules?.coefficients.colorDissipation
          ?? this.effectiveBehavior('colorDissipation', this.colorDissipationNode, state);
        const densityRetention = pow(float(Math.E), dt.mul(densityRate).mul(-1));
        const temperatureRetention = pow(float(Math.E), dt.mul(temperatureRate).mul(-1));
        const colorRetention = pow(float(Math.E), dt.mul(colorRate).mul(-1));
        const rawDensity = max(float(0), mixedDensity.x
          .mul(densityRetention).mul(boundaryRetention));
        const keep = rawDensity.greaterThanEqual(this.densityCutoffNode);
        const density = keep.select(rawDensity, float(0));
        const temperature = keep.select(
          max(float(0), mixedDensity.y
            .mul(densityRetention).mul(temperatureRetention).mul(boundaryRetention)),
          float(0),
        );
        const color = keep.select(
          vec3(mixedColor.xyz).mul(colorRetention).mul(boundaryRetention),
          vec3(0),
        );
        // Separate targets keep MacCormack inside WebGPU's eight-storage-buffer limit.
        if (writeColor !== false) outputColor.element(index).assign(
          this.isSolid(index).select(vec4(0), vec4(color, 0)),
        );
        if (writeColor !== true) outputDensity.element(index).assign(
          this.isSolid(index).select(vec4(0), vec4(density, temperature, 0, 0)),
        );
      }));

    const sources = this.sourceNodes.get(densityCurrent)
      ?? buildScalars(densityCurrent, colorCurrent, densityNext, colorNext, true);
    this.sourceNodes.set(densityCurrent, sources);
    this.benchmarks.span('scalarAdvectionDiffusionDecay', () => sources.forEach(node => renderer.compute(node)));

    if (this.gasModules.length) {
      const rules = this.scalarModuleNodes.get(densityCurrent)
        ?? buildScalars(densityNext, colorNext, densityCurrent, colorCurrent, false);
      this.scalarModuleNodes.set(densityCurrent, rules);
      this.benchmarks.span('scalarGasModules', () => rules.forEach(node => renderer.compute(node)));
      // Rule outputs occupy the old input pair. Injection and the normal final swap retain that pair.
      [this.densityCurrent, this.densityNext] = [this.densityNext, this.densityCurrent];
      [this.colorCurrent, this.colorNext] = [this.colorNext, this.colorCurrent];
      densityNext = this.densityNext;
      colorNext = this.colorNext;
    }

    const scalarSources = this.scalarSourceNodes.get(densityNext) ?? this.computeCells(index => {
      If(this.volumeGrid.sourceActive(index), () => {
        const center = this.cellCenter(this.cellCoordinate(index));
        const sourceDensity = float(0).toVar('gasSourceDensity');
        const sourceTemperature = float(0).toVar('gasSourceTemperature');
        const sourceColor = vec3(0).toVar('gasSourceColor');
        const radius = max(this.cellSizeNode.mul(1.5), sourceGrid.getMaxParticleRadiusNode());
        sourceGrid.forEachParticleInRadius(center, radius, (particle, distanceSq) => {
          const particleRadius = this.splatRadius(particle.scale);
          const weight = max(float(0), float(1).sub(distanceSq.sqrt().div(particleRadius)));
          const contribution = max(particle.mass, float(0)).mul(particle.alpha)
            .mul(weight).mul(this.sourceStrength).mul(this.sourceStep(particle, dt));
          sourceDensity.addAssign(contribution);
          sourceTemperature.addAssign(contribution.mul(this.particleTemperature(particle.time, particle.index)));
          sourceColor.addAssign(particle.color.mul(contribution));
        }, { tagMask });
        const previous = densityNext.element(index);
        densityNext.element(index).assign(vec4(
          previous.x.add(sourceDensity), previous.y.add(sourceTemperature), 0, 0,
        ));
        colorNext.element(index).assign(vec4(
          colorNext.element(index).xyz.add(sourceColor), 0,
        ));
      });
    });
    this.scalarSourceNodes.set(densityNext, scalarSources);
    this.benchmarks.span('scalarSourceInjection', () => renderer.compute(scalarSources));
    this.applySpatialEffects('scalars', densityNext, colorNext, this.velocityCurrent, context, renderer);

    const clearSolid = this.solidClearNodes.get(densityNext) ?? this.computeCells(index => {
      densityNext.element(index).assign(
        this.isSolid(index).select(vec4(0), densityNext.element(index)),
      );
      colorNext.element(index).assign(
        this.isSolid(index).select(vec4(0), colorNext.element(index)),
      );
    });
    this.solidClearNodes.set(densityNext, clearSolid);
    this.benchmarks.span('solidScalarConstraints', () => renderer.compute(clearSolid));
    [this.densityCurrent, this.densityNext] = [this.densityNext, this.densityCurrent];
    [this.colorCurrent, this.colorNext] = [this.colorNext, this.colorCurrent];

    this.volumeGrid.recordPhase(renderer, 'simulation');
    const outputDensity = this.densityCurrent;
    const outputColor = this.colorCurrent;
    this.clearOutputTextures(renderer);
    const output = this.outputNodes.get(outputDensity) ?? this.computeCells(index => {
      const coordinate = this.cellCoordinate(index);
      const density = outputDensity.element(index).x;
      const normalized = this.outputColor(
        outputColor.element(index).xyz,
        density,
      );
      const exportCoordinate = coordinate.sub(ivec3(this.exportOffset));
      If(vec3(exportCoordinate).greaterThanEqual(0).all()
        .and(vec3(exportCoordinate).lessThan(this.exportDimensions).all()), () => {
        textureStore(this.densityTextureNode, vec3(exportCoordinate),
          this.outputParameters(index, density, outputDensity.element(index).y)).toWriteOnly();
        textureStore(
          this.colorTextureNode, vec3(exportCoordinate), vec4(normalized, density.greaterThan(0).select(1, 0)),
        ).toWriteOnly();
      });
    });
    this.outputNodes.set(outputDensity, output);
    this.benchmarks.span('volumeFieldUpdate', () => renderer.compute(output));
    this.volumeGrid.recordPhase(renderer, 'export');
    this.reduceFieldMaxima(renderer, outputDensity);
    if (!this.preparingPool) {
      this.density.version += 1;
      this.colorField.version += 1;
    }
  }

  public override renderGPU(
    context: GPUParticleUpdateContext,
    renderBuffers: GPUParticleRenderBufferState,
    renderer: ParticleSpatialGridRenderer,
    grid?: ParticleSpatialGrid,
  ): void {
    if (!grid) return;
    const sourceGrid = this.getSourceGrid(context, renderer, grid);
    const tagMask = context.system.getGPUFilterTagMask(this.tags);
    this.volumeGrid.updateRenderSourceMask(context, renderBuffers, renderer,
      this.boundsMinNode, this.cellSizeNode, tagMask);
    const cacheKey = [grid.resourceVersion, context.buffers.version, renderBuffers.version,
      tagMask, this.sourceStrength, this.sourceTemperature, Boolean(this.temperatureOverLifetime),
    ].join('|');
    if (cacheKey !== this.visualCacheKey) {
      this.visualCacheKey = cacheKey;
      this.visualSourceNode = undefined;
    }

    const sourceNode = this.visualSourceNode ?? this.computeCells(index => {
      // Masked-out cells must be cleared: a source may have moved or died.
      this.visualDensity.element(index).assign(vec4(0));
      this.visualColor.element(index).assign(vec4(0));
      If(this.volumeGrid.sourceActive(index), () => {
        const center = this.cellCenter(this.cellCoordinate(index));
        const total = float(0).toVar('visualGasDensity');
        const temperature = float(0).toVar('visualGasTemperature');
        const color = vec3(0).toVar('visualGasColor');
        const radius = max(this.cellSizeNode.mul(1.5), sourceGrid.getMaxParticleRadiusNode());
        sourceGrid.forEachParticleInRadius(center, radius, (particle) => {
          const vectors = renderBuffers.storage.createVectorNodes(particle.index);
          const scalars = renderBuffers.storage.createScalarNodes(particle.index);
          const particleRadius = this.splatRadius(vectors.scale);
          const weight = max(float(0), float(1).sub(vectors.position.distance(center).div(particleRadius)));
          const contribution = max(particle.mass, float(0)).mul(scalars.alpha)
            .mul(weight).mul(this.sourceStrength).mul(context.deltaTimeNode);
          total.addAssign(contribution);
          temperature.addAssign(contribution.mul(this.particleTemperature(scalars.time, particle.index)));
          color.addAssign(vectors.color.mul(contribution));
        }, { tagMask });
        this.visualDensity.element(index).assign(vec4(total, temperature, 0, 0));
        this.visualColor.element(index).assign(vec4(color, 0));
      });
    });
    this.visualSourceNode = sourceNode;
    renderer.compute(sourceNode);

    if (this.transientEffects.length) {
      const density = this.densityCurrent, color = this.colorCurrent;
      const initialize = this.visualStateNodes.get(density) ?? this.computeCells(index => {
        const total = density.element(index).add(this.visualDensity.element(index));
        const totalColor = color.element(index).xyz.add(this.visualColor.element(index).xyz);
        const velocity = this.velocityCurrent.element(index).xyz;
        this.visualDensity.element(index).assign(vec4(total.xy, velocity.xy));
        this.visualColor.element(index).assign(vec4(totalColor, velocity.z));
      });
      this.visualStateNodes.set(density, initialize);
      renderer.compute(initialize);
      this.applySpatialEffects('visual', this.visualDensity, this.visualColor, this.velocityCurrent, context, renderer);
    }

    const density = this.densityCurrent;
    const color = this.colorCurrent;
    const output = this.visualOutputNodes.get(density) ?? this.computeCells(index => {
      const coordinate = this.cellCoordinate(index);
      const fluidCell = this.isSolid(index).not();
      const totalDensity = fluidCell.select(
        this.transientEffects.length ? this.visualDensity.element(index).x
          : density.element(index).x.add(this.visualDensity.element(index).x),
        float(0),
      );
      const totalColor = fluidCell.select(
        this.transientEffects.length ? this.visualColor.element(index).xyz
          : vec3(color.element(index).xyz).add(this.visualColor.element(index).xyz),
        vec3(0),
      );
      const totalTemperature = fluidCell.select(
        this.transientEffects.length ? this.visualDensity.element(index).y
          : density.element(index).y.add(this.visualDensity.element(index).y),
        float(0),
      );
      const exportCoordinate = coordinate.sub(ivec3(this.exportOffset));
      If(vec3(exportCoordinate).greaterThanEqual(0).all()
        .and(vec3(exportCoordinate).lessThan(this.exportDimensions).all()), () => {
        textureStore(this.densityTextureNode, vec3(exportCoordinate),
          this.outputParameters(index, totalDensity, totalTemperature, this.transientEffects.length
            ? vec3(this.visualDensity.element(index).zw, this.visualColor.element(index).w) : undefined)).toWriteOnly();
        textureStore(this.colorTextureNode, vec3(exportCoordinate), vec4(
          this.outputColor(totalColor, totalDensity),
          totalDensity.greaterThan(0).select(1, 0),
        )).toWriteOnly();
      });
    });
    this.visualOutputNodes.set(density, output);
    this.benchmarks.span('volumeFieldUpdate', () => renderer.compute(output));
    this.volumeGrid.recordPhase(renderer, 'render');
    this.density.version += 1;
    this.colorField.version += 1;
  }

  protected override onParticleStateReset(): void {
    this.occupiedGasBounds.makeEmpty();
    this.requiredBrickCapacity = 0;
    this.onGridResolutionChanged();
  }

  protected override onBoundsChanged(previous: THREE.Box3): void {
    // Same-tier topology updates preserve compatible pressure and all compiled graphs.
    void previous;
    this.density.version += 1;
    this.colorField.version += 1;
  }

  protected override onGridResolutionChanged(): void {
    this.occupiedGasBounds.makeEmpty();
    this.cancelQualityPreparation();
    this.poolAllocation?.cancelPending(); this.poolAllocation = undefined;
    this.volumeGrid?.dispose();
    this.volumeGrid = new SparseVolumeGrid({
      ...this.spatialGridOptions,
      brickSubdivisions: this.spatialGrid!.brickSubdivisions,
      cellSubdivisions: this.spatialGrid!.cellSubdivisions,
      bounds: this.bounds,
    }, Math.min(this.initialBrickCapacity, this.maxActiveBricks), this.gridDimensions);
    this.resizeGridFields(this.volumeGrid.cellCount);
    this.clearNewNodes = [];
    this.clearTexturesNode = undefined;
    this.disposeGasFields();
    this.allocateGasFields();
    this.density.texture = this.densityTexture;
    this.density.resolution.copy(this.gridDimensions);
    this.density.version += 1;
    this.colorField.texture = this.colorTexture;
    this.colorField.resolution.copy(this.gridDimensions);
    this.colorField.version += 1;
    this.pendingPreviousBounds = undefined;
    this.resetGasNodes();
  }

  private resetGasNodes(): void {
    this.gpuCacheKey = '';
    this.effectNodes = new Map();
    this.visualStateNodes = new WeakMap();
    this.remapNodes = new WeakMap();
    this.remapVelocityNode = undefined;
    this.velocityNodes = new WeakMap();
    this.velocitySourceNode = undefined;
    this.sourceNodes = new WeakMap();
    this.scalarModuleNodes = new WeakMap();
    this.scalarSourceNodes = new WeakMap();
    this.solidClearNodes = new WeakMap();
    this.outputNodes = new WeakMap();
    this.visualCacheKey = '';
    this.visualSourceNode = undefined;
    this.visualOutputNodes = new WeakMap();
    this.maximaNodes = new WeakMap();
    this.maximaResetNode = undefined;
    this.curlNode = undefined;
    this.confinementNodes = new WeakMap();
    this.advectionNodes = new WeakMap();
  }

  private qualityPreparation?: {
    key: string; ready: boolean; grid?: SparseVolumeGrid; pressure?: FluidPressureProjection; error?: unknown;
    completion?: Promise<void>;
    spacing?: ReturnType<typeof uniform<'float'>>;
    stage?: string;
    blockedUntil?: number;
    remaps?: WeakMap<object, ComputeNode>; copyVelocity?: ComputeNode; nodes?: ComputeNode[];
  };

  /** Prepare only the expensive pressure/directory replacement; no live fields or uniforms are advanced. */
  protected override prepareQualityChange(domain: SpatialGridDomain, renderer: ParticleSpatialGridRenderer): boolean {
    // Rectangle dimensions and resident capacity are runtime storage state, not program specialization.
    const keyForCurrentPool = () => [
      this.pressureSolver, this.pressureIterations, this.pressureMinIterations, this.pressureMaxIterations,
      this.pressureTolerance, this.pressureDiagnostics, JSON.stringify(this.multigrid)].join(':');
    const key = keyForCurrentPool();
    const pending = this.qualityPreparation;
    if (pending?.key === key) {
      if (pending.blockedUntil && performance.now() >= pending.blockedUntil) {
        this.qualityPreparation = undefined;
        return this.prepareQualityChange(domain, renderer);
      }
      // Optional background quality work must never stop the live simulation/render loop.
      if (pending.error) return false;
      if (!pending.ready) return false;
      if (pending.grid!.cellSize !== domain.cellSize) {
        this.retargetPreparedQuality(pending, domain.cellSize, renderer);
        return false;
      }
      if (pending.grid!.capacity !== this.volumeGrid.capacity) {
        this.growPreparedQuality(pending, renderer);
        return false;
      }
      if (!pending.grid!.ensureDirectory(renderer, domain.gridDimensions)) return false;
      pending.grid!.setLayoutMetadata(domain.bounds, domain.gridDimensions);
      pending.pressure!.updateTopology();
      return true;
    }
    if (pending) {
      if (!pending.ready) return false;
      pending.pressure?.dispose(); pending.grid?.dispose(renderer); pending.nodes?.forEach(node => node.dispose());
    }
    const candidate = { key, ready: false } as NonNullable<GasSimulation['qualityPreparation']>;
    this.qualityPreparation = candidate;
    const started = performance.now();
    // Yield before allocation, then compile a small batch per turn so animation can continue.
    candidate.completion = new Promise(resolve => setTimeout(resolve, 0)).then(async () => {
      if (this.qualityPreparation !== candidate) return;
      if (domain.cellSize < this.cellSize) {
        // Finer cells can require eight times as many pages. Reserve from actual live support
        // before replacing the mapping, otherwise a refinement can discard unadmitted gas.
        const diagnostics = await this.readGridDiagnostics(renderer);
        const ratio = this.cellSize / domain.cellSize;
        const targetPages = domain.gridDimensions.x * domain.gridDimensions.y * domain.gridDimensions.z
          / this.volumeGrid.cellsPerBrick;
        const required = Math.ceil(Math.min(targetPages, diagnostics.activeBricks * ratio ** 3));
        const maximum = this.poolAllocation?.maximumCapacity ?? this.volumeGrid.capacity;
        if (required > maximum) {
          candidate.blockedUntil = performance.now() + 250;
          this.benchmarks.set('qualityCapacityShortfall', required - maximum);
          return;
        }
        if (required > this.volumeGrid.capacity) this.poolAllocation?.request(required);
        while (this.volumeGrid.capacity < required && this.qualityPreparation === candidate) {
          await new Promise(resolve => setTimeout(resolve, 4));
        }
        if (this.qualityPreparation !== candidate) return;
        candidate.key = keyForCurrentPool();
      }
      const replacement = new SparseVolumeGrid({ ...this.spatialGridOptions, bounds: domain.bounds },
        this.volumeGrid.capacity, domain.gridDimensions.clone());
      candidate.grid = replacement;
      replacement.reductionCellCount = this.volumeGrid.reductionCellCount;
      candidate.spacing = uniform(domain.cellSize);
      const pressure = this.createPressureProjection(replacement, candidate.spacing,
        domain.gridDimensions.clone());
      candidate.pressure = pressure;
      candidate.stage = 'layout';
      const remaps = new WeakMap<object, ComputeNode>(); candidate.remaps = remaps;
      const forward = this.getRemapNode(this.densityCurrent, this.colorCurrent, this.densityNext, this.colorNext,
        replacement, this.volumeGrid, remaps);
      const backward = this.getRemapNode(this.densityNext, this.colorNext, this.densityCurrent, this.colorCurrent,
        replacement, this.volumeGrid, remaps);
      const copyVelocity = replacement.compute(index => {
        this.velocityCurrent.element(index).assign(this.velocityNext.element(index));
      });
      candidate.copyVelocity = copyVelocity; candidate.nodes = [forward, backward, copyVelocity];
      const compiler = { ...renderer, compute: renderer.compute.bind(renderer),
        compileComputeAsync: (nodes: ComputeNode[]) => prepareComputePrograms(renderer, nodes,
          () => this.qualityPreparation === candidate) };
      await replacement.prepareLayout(compiler);
      if (this.qualityPreparation !== candidate) return;
      candidate.stage = 'pressure';
      await pressure.prepare(compiler, this.velocityNext, this.velocityCurrent, this.pressureIterations);
      if (this.qualityPreparation !== candidate) return;
      // Initialization samples the retained velocity before transport; prepare that input variant too.
      await pressure.prepare(compiler, this.velocityCurrent, this.velocityCurrent, this.pressureIterations);
      if (this.qualityPreparation !== candidate) return;
      candidate.stage = 'remaps';
      await compiler.compileComputeAsync([forward, backward, copyVelocity]);
      if (this.qualityPreparation !== candidate) return;
      candidate.ready = true;
      candidate.stage = 'ready';
      this.benchmarks.set('qualityPreparationMs', performance.now() - started);
    }).catch(error => {
      candidate.error = error; candidate.ready = true;
      if (this.qualityPreparation === candidate) {
        console.warn('Gas quality preparation failed; retaining current tier.', error);
      }
    }).finally(() => {
      if (this.qualityPreparation !== candidate) {
        candidate.pressure?.dispose(); candidate.grid?.dispose(renderer);
        candidate.nodes?.forEach(node => node.dispose());
      }
    });
    return false;
  }

  /** Pressure programs already use runtime spacing; only the conservative transfer stencil changes. */
  private retargetPreparedQuality(candidate: NonNullable<GasSimulation['qualityPreparation']>, cellSize: number,
    renderer: ParticleSpatialGridRenderer): void {
    candidate.ready = false;
    candidate.stage = 'retarget';
    candidate.completion = candidate.completion!.then(async () => {
      const grid = candidate.grid!;
      grid.cellSize = cellSize; grid.brickSize = cellSize * grid.brickSide;
      candidate.spacing!.value = cellSize;
      candidate.nodes?.forEach(node => node.dispose());
      const remaps = new WeakMap<object, ComputeNode>(); candidate.remaps = remaps;
      const forward = this.getRemapNode(this.densityCurrent, this.colorCurrent, this.densityNext, this.colorNext,
        grid, this.volumeGrid, remaps);
      const backward = this.getRemapNode(this.densityNext, this.colorNext, this.densityCurrent, this.colorCurrent,
        grid, this.volumeGrid, remaps);
      const copy = grid.compute(index => this.velocityCurrent.element(index).assign(this.velocityNext.element(index)));
      candidate.copyVelocity = copy; candidate.nodes = [forward, backward, copy];
      await new Promise(resolve => setTimeout(resolve, 0));
      if (this.qualityPreparation !== candidate) return;
      await prepareComputePrograms(renderer, candidate.nodes, () => this.qualityPreparation === candidate);
      candidate.ready = true;
    }).catch(error => { candidate.error = error; candidate.ready = true; }).finally(() => {
      if (this.qualityPreparation !== candidate) {
        candidate.pressure?.dispose(); candidate.grid?.dispose(renderer);
        candidate.nodes?.forEach(node => node.dispose());
      }
    });
  }

  /** A preparing tier must not restart compilation whenever the live resident pool grows. */
  private growPreparedQuality(candidate: NonNullable<GasSimulation['qualityPreparation']>,
    renderer: ParticleSpatialGridRenderer): void {
    candidate.ready = false;
    candidate.stage = 'capacity';
    candidate.completion = candidate.completion!.then(async () => {
      const grid = candidate.grid!, pressure = candidate.pressure!;
      const backing = new SparseVolumeGrid({ ...this.spatialGridOptions, bounds: grid.bounds },
        this.volumeGrid.capacity, grid.gridDimensions, grid.directoryCapacity);
      const storage = pressure.createCapacityStorage(backing.capacity);
      const attributes = [...backing.capacityAttributes, ...storage.attributes];

      // This replacement has never simulated: new zeroed scratch needs no field migration.
      for (let i = 0; i < attributes.length; i++) {
        initializeStorageAttribute(renderer, attributes[i], false);
        if (i % 4 === 3) await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (this.qualityPreparation !== candidate) {
        backing.dispose(renderer);
        storage.attributes.forEach(attribute => {
          destroyGPUStorageAttribute(renderer, attribute); attribute.dispose();
        });
        return;
      }
      const retired = [...grid.adoptCapacity(backing), ...pressure.adoptCapacityStorage(storage)];
      retired.forEach(attribute => { destroyGPUStorageAttribute(renderer, attribute); attribute.dispose(); });
      backing.dispatchAttributes.forEach(attribute => attribute.dispose());
      candidate.ready = true;
    }).catch(error => {
      candidate.error = error; candidate.ready = true;
      console.warn('Gas quality storage preparation failed; retaining current tier.', error);
    }).finally(() => {
      if (this.qualityPreparation !== candidate) {
        candidate.pressure?.dispose(); candidate.grid?.dispose(renderer);
        candidate.nodes?.forEach(node => node.dispose());
      }
    });
  }

  private cancelQualityPreparation(): void {
    const preparation = this.qualityPreparation; this.qualityPreparation = undefined;
    if (preparation?.ready) {
      preparation.pressure?.dispose(); preparation.grid?.dispose(); preparation.nodes?.forEach(node => node.dispose());
    }
  }

  private pendingPreviousGrid?: SparseVolumeGrid;
  private pendingPreviousPreparation?: Promise<void>;

  protected override ensureGridResolution(renderer: ParticleSpatialGridRenderer, grid: ParticleSpatialGrid): void {
    const key = [grid.brickSubdivisions, grid.cellSubdivisions].join('|');
    if (key !== this.sparseStructureKey) {
      this.resolution = grid.cellsPerAxis;
      this.gridDimensions.copy(grid.gridDimensions); this.dimensionsNode.value.copy(this.gridDimensions);
      this.cellSize = grid.cellSize; this.cellSizeNode.value = this.cellSize;
      this.onGridResolutionChanged(); this.sparseStructureKey = key;
      return;
    }
    const old = this.volumeGrid;
    if (old.gridDimensions.equals(grid.gridDimensions) && old.bounds.equals(this.bounds)
      && Math.abs(old.cellSize - grid.cellSize) < 1e-9) return;
    const sameTier = Math.abs(old.cellSize - grid.cellSize) < 1e-9;
    if (sameTier) {
      const start = performance.now();
      if (!old.updateLayout(renderer, this.bounds, grid.gridDimensions)) {
        // Keep simulating the old rectangle while directory capacity prepares. Latest target wins.
        const requested = this.bounds.clone();
        this.bounds.copy(old.bounds); this.boundsMinNode.value.copy(old.bounds.min);
        // This is a coverage rollback, not a quality request. Reinterpreting the old rectangle
        // with automatic quality can change tier before the staged solver is ready.
        grid.setBounds(grid.resolveBounds(old.bounds.clone()));
        this.pendingBounds = { grid, bounds: requested };
        return;
      }
      this.gridDimensions.copy(grid.gridDimensions);
      this.dimensionsNode.value.copy(this.gridDimensions);
      this.pressureProjection?.updateTopology();
      this.domainChanges.logical++;
      this.benchmarks.set('logicalResizeSubmissionMs', performance.now() - start);
      return;
    }
    this.domainChanges.quality++;
    this.textureAllocation?.cancelPending(); this.textureAllocation = undefined;
    this.poolAllocation?.cancelPending(); this.poolAllocation = undefined;
    const pressure = this.pressureProjection; this.pressureProjection = undefined;
    this.gridDimensions.copy(grid.gridDimensions); this.dimensionsNode.value.copy(this.gridDimensions);
    this.cellSize = grid.cellSize; this.cellSizeNode.value = this.cellSize;
    const prepared = this.qualityPreparation;
    if (prepared?.ready && prepared.grid && Math.abs(prepared.grid.cellSize - this.cellSize) < 1e-9
      && prepared.grid.gridDimensions.equals(this.gridDimensions) && prepared.grid.capacity === old.capacity) {
      prepared.grid.updateLayout(renderer, this.bounds, this.gridDimensions);
      this.volumeGrid = prepared.grid; this.pressureProjection = prepared.pressure;
      this.qualityPreparation = undefined;
    } else {
      // Explicit edits or a changed target can bypass the automatic readiness gate. Cancel the
      // old candidate, but keep its source directory alive until its in-flight compiler returns.
      this.cancelQualityPreparation();
      this.volumeGrid = this.benchmarks.span('qualityDirectoryAllocation', () => (
        new SparseVolumeGrid({ ...this.spatialGridOptions, bounds: this.bounds }, old.capacity, this.gridDimensions)
      ));
    }
    this.resetGasNodes();
    this.resetGridNodes();
    if (prepared?.ready && this.pressureProjection === prepared.pressure) {
      this.remapNodes = prepared.remaps!; this.remapVelocityNode = prepared.copyVelocity;
    }
    this.clearNewNodes = [];
    this.clearTexturesNode = undefined;
    // Export textures are derived render resources, not quality-specialized storage. Retain their
    // backing and let updateExportLayout stage any necessary growth while simulation continues.
    this.density.resolution.copy(this.gridDimensions); this.colorField.resolution.copy(this.gridDimensions);
    this.pendingPreviousGrid = old; this.pendingPreviousBounds = old.bounds.clone();
    this.pendingPreviousPreparation = prepared?.completion;
    this.previousMinimum.value.copy(old.bounds.min); this.previousCellSize.value = old.cellSize;
    this.retireGridResources(renderer, () => pressure?.dispose(), prepared?.completion);
    this.density.version++; this.colorField.version++;
  }

  private retireGridResources(renderer: ParticleSpatialGridRenderer, release: () => void,
    preparation?: Promise<void>): void {
    const device = (renderer.backend as {
      device?: { queue: { onSubmittedWorkDone(): Promise<void> } };
    } | undefined)?.device;
    // A queue fence alone cannot protect CPU-side asynchronous shader construction.
    void (preparation ?? Promise.resolve()).then(() => device?.queue.onSubmittedWorkDone()).then(release, release);
  }

  private get allocatedBytes(): number {
    return this.fieldAttributes.reduce((sum, attribute) => sum + attribute.array.byteLength, 0)
      + this.volumeGrid.allocatedBytes + (this.pressureProjection?.allocatedBytes ?? 0)
      + 2 * this.textureDimensions.x * this.textureDimensions.y * this.textureDimensions.z * 4 * 2;
  }

  private get fieldAttributes(): StorageBufferAttribute[] {
    return [this.velocityCurrentAttribute, this.velocityNextAttribute, this.pressureCurrentAttribute,
      this.pressureNextAttribute, this.divergenceAttribute, this.solidAttribute, this.boundaryAttribute,
      this.densityAttributeA, this.densityAttributeB, this.colorAttributeA, this.colorAttributeB,
      this.visualAttribute, this.maximaAttribute, this.curlAttribute, ...this.advectionAttributes];
  }

  /** Capacity/binding state changes do not invalidate numerical graphs or program templates. */
  private ensurePoolAllocation(renderer: ParticleSpatialGridRenderer, context: GPUParticleUpdateContext,
    grid: ParticleSpatialGrid): void {
    void context; void grid;
    const configuration = `${this.advectionMethod}`;
    if (configuration !== this.poolConfiguration) {
      this.poolAllocation?.cancelPending();
      this.poolConfiguration = configuration;
    }
    if (this.poolAllocation) return;
    const backend = renderer.backend as { device: { limits: { maxStorageBufferBindingSize: number };
      queue: { onSubmittedWorkDone(): Promise<void> } } };
    const maximum = this.maximumResidentCapacity(renderer);
    this.volumeGrid.reductionCellCount = maximum * this.volumeGrid.cellsPerBrick + 1;
    const pressure = this.getPressureProjection();
    this.poolAllocation = new StagedGPUAllocation<GasPool>({ attributes: this.fieldAttributes,
      count: this.cellCount, retired: [], adopted: true }, this.volumeGrid.capacity, {
      maximumCapacity: maximum,
      create: capacity => {
        const volume = new SparseVolumeGrid({ ...this.spatialGridOptions, bounds: this.bounds },
          capacity, this.gridDimensions, this.volumeGrid.directoryCapacity);
        const count = volume.cellCount;
        const attributes = this.fieldAttributes.map(attribute => {
          // Maxima are fixed-size reduction output, not resident-cell storage.
          if (attribute === this.maximaAttribute) return attribute;
          const planes = attribute.count / this.cellCount;
          return new StorageBufferAttribute(new Float32Array(count * planes * attribute.itemSize), attribute.itemSize);
        });
        const pressureStorage = pressure.createCapacityStorage(capacity);
        this.peakAllocatedBytes = Math.max(this.peakAllocatedBytes, this.allocatedBytes + volume.allocatedBytes
          + [...attributes.filter(attribute => attribute !== this.maximaAttribute), ...pressureStorage.attributes]
            .reduce((sum, attribute) => sum + attribute.array.byteLength, 0));
        return { grid: volume, attributes, count, pressure: pressureStorage, retired: [] };
      },
      prepare: async pool => {
        const started = performance.now();
        const attributes = [...pool.attributes.filter(attribute => attribute !== this.maximaAttribute),
          ...pool.grid!.capacityAttributes, ...pool.pressure!.attributes];
        let sliceStarted = performance.now();
        for (let index = 0; index < attributes.length; index++) {
          initializeStorageAttribute(renderer, attributes[index], false);
          if (performance.now() - sliceStarted >= 2 && index + 1 < attributes.length) {
            await new Promise(resolve => setTimeout(resolve, 0));
            sliceStarted = performance.now();
          }
        }
        this.capacityMetrics.storagePreparationMs = performance.now() - started;
        this.capacityMetrics.graphConstructionMs = 0;
        this.capacityMetrics.compilationMs = 0;
      },
      canCommit: (_current, replacement) => {
        if (!pressure.canAdoptCapacityStorage(replacement.pressure!)) {
          this.requiredBrickCapacity = Math.max(this.requiredBrickCapacity, replacement.grid!.capacity);
          this.poolAllocation!.cancelPending();
          return false;
        }
        return replacement.grid!.ensureDirectory(renderer, this.gridDimensions, this.volumeGrid.directoryCapacity);
      },
      migrate: (current, replacement) => {
        current.attributes = this.fieldAttributes;
        current.count = this.cellCount;
        const count = this.cellCount - 1, nextCount = replacement.count;
        const copies = current.attributes.flatMap((attribute, index) => {
          const target = replacement.attributes[index];
          if (attribute === target) return [];
          // Runtime plane offsets avoid capacity-specific shaders; two GPU copies preserve packed fields.
          if (attribute === this.boundaryAttribute || attribute === this.visualAttribute) return [
            { source: attribute, target, byteLength: count * 16 },
            { source: attribute, target, sourceOffset: this.cellCount * 16,
              targetOffset: nextCount * 16, byteLength: count * 16 },
          ];
          return [{ source: attribute, target, byteLength: count * attribute.itemSize * 4 }];
        });
        copyStorageAttributes(renderer, copies);
        this.volumeGrid.migrateCapacity(renderer, replacement.grid!);
        pressure.migrateCapacityStorage(renderer, replacement.pressure!);
      },
      swap: pool => {
        const previous = this.fieldAttributes;
        const replacements = new Map(previous.map((attribute, index) => [attribute, pool.attributes[index]]));
        // Every graph retains these storage nodes. Rebinding updates Three's bind groups, not its programs.
        for (const node of [this.velocityCurrent, this.velocityNext, this.pressureCurrent, this.pressureNext,
          this.divergence, this.solid, this.faceOpenness, this.densityCurrent, this.densityNext,
          this.colorCurrent, this.colorNext, this.visualDensity, this.curl,
          this.velocityAdvected, this.densityAdvected, this.colorAdvected]) {
          const binding = node as unknown as { value: StorageBufferAttribute } | undefined;
          const replacement = binding && replacements.get(binding.value);
          if (binding && replacement) binding.value = replacement;
        }
        const names = ['velocityCurrentAttribute', 'velocityNextAttribute', 'pressureCurrentAttribute',
          'pressureNextAttribute', 'divergenceAttribute', 'solidAttribute', 'boundaryAttribute',
          'densityAttributeA', 'densityAttributeB', 'colorAttributeA', 'colorAttributeB',
          'visualAttribute', 'maximaAttribute', 'curlAttribute'] as const;
        names.forEach((key, index) => { this[key] = pool.attributes[index]; });
        this.advectionAttributes = pool.attributes.slice(names.length);
        this.cellCount = pool.count;
        this.fieldStrideNode.value = this.cellCount;
        const retiredGrid = this.volumeGrid.adoptCapacity(pool.grid!);
        const retiredPressure = pressure.adoptCapacityStorage(pool.pressure!);
        // Attach old storage to the retiring payload; the live grid/projection themselves retain identity.
        const old = this.poolAllocation!.current;
        old.retired.push(...retiredGrid, ...retiredPressure);
        pool.grid!.dispatchAttributes.forEach(attribute => attribute.dispose());
        pool.adopted = true;
        this.growthEvents++;
        this.domainChanges.capacity++;
      },
      dispose: pool => {
        const live = new Set(this.fieldAttributes);
        [...new Set([...pool.attributes, ...pool.retired])].forEach(attribute => {
          if (!live.has(attribute)) { destroyGPUStorageAttribute(renderer, attribute); attribute.dispose(); }
        });
        if (pool.grid && !pool.adopted) {
          pool.grid.dispose(renderer);
          pool.pressure?.attributes.forEach(attribute => {
            destroyGPUStorageAttribute(renderer, attribute); attribute.dispose();
          });
        }
      },
      fence: () => backend.device.queue.onSubmittedWorkDone(),
    });
  }

  private maximumResidentCapacity(renderer: ParticleSpatialGridRenderer): number {
    const device = (renderer.backend as { device: { limits: { maxStorageBufferBindingSize: number } } }).device;
    const bytesPerBrick = Math.max(this.volumeGrid.cellsPerBrick * 32, (this.volumeGrid.brickSide + 1) ** 3 * 16);
    const maximum = Math.min(this.maxActiveBricks,
      Math.floor((device.limits.maxStorageBufferBindingSize - 32) / bytesPerBrick));
    if (maximum < this.volumeGrid.capacity) throw new Error('Initial gas pool exceeds this device storage limit.');
    return maximum;
  }

  /** Explicit preparation/testing can await a grow; normal simulation only requests and polls. */
  private async growBrickPool(renderer: ParticleSpatialGridRenderer, required: number): Promise<void> {
    if (!this.poolContext || !this.poolParticleGrid) {
      throw new Error('Prepare an initial gas update before pool growth.');
    }
    this.ensurePoolAllocation(renderer, this.poolContext, this.poolParticleGrid);
    this.poolAllocation!.request(required);
    await this.poolAllocation!.whenPrepared();
    this.poolAllocation!.commit();
  }

  private remapFields(renderer: ParticleSpatialGridRenderer): void {
    const previous = this.pendingPreviousBounds;
    if (!previous) return;
    this.pendingPreviousBounds = undefined;
    this.previousMinimum.value.copy(previous.min);
    this.previousCellSize.value = this.pendingPreviousGrid?.cellSize ?? this.previousDomain?.cellSize ?? this.cellSize;
    const remap = this.getRemapNode(this.densityCurrent, this.colorCurrent, this.densityNext, this.colorNext);
    this.benchmarks.span('boundsRemap', () => renderer.compute(remap));
    [this.densityCurrent, this.densityNext] = [this.densityNext, this.densityCurrent];
    [this.colorCurrent, this.colorNext] = [this.colorNext, this.colorCurrent];
    const copyVelocity = this.remapVelocityNode ?? this.computeCells(index => {
      this.velocityCurrent.element(index).assign(this.velocityNext.element(index));
    });
    this.remapVelocityNode = copyVelocity;
    renderer.compute(copyVelocity);
    const retired = this.pendingPreviousGrid; this.pendingPreviousGrid = undefined;
    const preparation = this.pendingPreviousPreparation; this.pendingPreviousPreparation = undefined;
    if (retired) this.retireGridResources(renderer, () => retired.dispose(renderer), preparation);
  }

  private getRemapNode(
    oldDensity: Vec4Storage, oldColor: Vec4Storage, newDensity: Vec4Storage, newColor: Vec4Storage,
    targetGrid = this.volumeGrid, sourceGrid = this.pendingPreviousGrid ?? this.volumeGrid,
    cache = this.remapNodes,
  ): ComputeNode {
    const previousDimensions = sourceGrid.getDimensionsNode();
    const previousPages = sourceGrid !== targetGrid ? sourceGrid.pages : sourceGrid.previousPages;
    const ratio = targetGrid.cellSize / sourceGrid.cellSize;
    const oldVelocity = this.velocityCurrent;
    const node = cache.get(oldDensity) ?? targetGrid.compute(index => {
      const center = vec3(targetGrid.coordinate(index)).add(0.5).mul(this.cellSizeNode).add(this.boundsMinNode);
      const read = (field: Vec4Storage, coordinate: Node<'ivec3'>) => {
        const inside = vec3(coordinate).greaterThanEqual(0).all()
          .and(vec3(coordinate).lessThan(vec3(previousDimensions)).all());
        const address = sourceGrid.index(ivec3(clamp(vec3(coordinate), vec3(0), vec3(previousDimensions).sub(1))),
          previousPages);
        return inside.select(field.element(address), vec4(0));
      };
      const density = vec4(0).toVar(), color = vec4(0).toVar(), velocity = vec3(0).toVar();
      if (ratio > 1 && Math.abs(ratio - Math.round(ratio)) < 1e-6) {
        const side = Math.round(ratio);
        const corner = center.sub(this.cellSizeNode.mul(0.5)).sub(this.previousMinimum)
          .div(this.previousCellSize).round();
        // A 2x coarsening averages eight scalar cells; MAC components average four fine faces.
        Loop(side ** 3, ({ i }) => {
          const offset = ivec3(i.mod(side), i.div(side).mod(side), i.div(side * side));
          const coordinate = ivec3(corner).add(offset);
          density.addAssign(read(oldDensity, coordinate).div(side ** 3));
          color.addAssign(read(oldColor, coordinate).div(side ** 3));
          const value = read(oldVelocity, coordinate).xyz;
          velocity.addAssign(vec3(offset.x.equal(0).select(value.x, 0), offset.y.equal(0).select(value.y, 0),
            offset.z.equal(0).select(value.z, 0)).div(side ** 2));
        });
      } else if (ratio < 1 - 1e-6) {
        const coordinate = center.sub(this.previousMinimum).div(this.previousCellSize);
        const interpolate = (field: Vec4Storage, offset: Node<'vec3'>) => {
          const p = coordinate.sub(offset), base = p.floor(), fraction = p.sub(base);
          const value = vec4(0).toVar();
          Loop(8, ({ i }) => {
            const delta = ivec3(i.mod(2), i.div(2).mod(2), i.div(4));
            const weights = vec3(delta.x.equal(0).select(float(1).sub(fraction.x), fraction.x),
              delta.y.equal(0).select(float(1).sub(fraction.y), fraction.y),
              delta.z.equal(0).select(float(1).sub(fraction.z), fraction.z));
            value.addAssign(read(field, ivec3(base).add(delta)).mul(weights.x.mul(weights.y).mul(weights.z)));
          });
          return value;
        };
        density.assign(interpolate(oldDensity, vec3(0.5)));
        color.assign(interpolate(oldColor, vec3(0.5)));
        velocity.assign(vec3(interpolate(oldVelocity, vec3(ratio * 0.5, 0.5, 0.5)).x,
          interpolate(oldVelocity, vec3(0.5, ratio * 0.5, 0.5)).y,
          interpolate(oldVelocity, vec3(0.5, 0.5, ratio * 0.5)).z));
      } else {
        const coordinate = ivec3(center.sub(this.previousMinimum).div(this.previousCellSize).floor());
        density.assign(read(oldDensity, coordinate)); color.assign(read(oldColor, coordinate));
        velocity.assign(read(oldVelocity, coordinate).xyz);
      }
      newDensity.element(index).assign(density);
      newColor.element(index).assign(color);
      this.velocityNext.element(index).assign(vec4(velocity, 0));
    });
    cache.set(oldDensity, node);
    return node;
  }

  public override cleanup(): void {
    this.cancelQualityPreparation();
    this.poolAllocation?.cancelPending(); this.poolAllocation = undefined;
    super.cleanup();
    this.sourceGrid?.dispose();
    this.sourceGrid = undefined;
    this.disposeGasFields();
    this.volumeGrid.dispose();
  }

  /** Small asynchronous allocation readback, without transferring field values. */
  /** @internal Explicit watched-brick probe; never runs automatically during simulation. */
  readBrickDiagnostics(renderer: ParticleSpatialGridRenderer, centers: readonly THREE.Vector3[],
    occupancy?: { texture: THREE.Texture; resolution: THREE.Vector3 }) {
    return readFluidBrickStates(renderer, this.volumeGrid, this.densityCurrent, this.densityTexture,
      this.textureDimensions, centers, occupancy,
      { offset: this.exportOffset.value, resolution: this.exportDimensions.value });
  }

  public async readGridDiagnostics(renderer: ParticleSpatialGridRenderer): Promise<{
    activeBricks: number; overflowedBricks: number; capacity: number; logicalBricks: number;
    requestedBricks: number; freshBricks: number; releasedBricks: number; activeDispatchEntries: number;
    priorityDemand: number[]; frame: number;
  }> {
    const grid = this.volumeGrid, frame = grid.frameNumber;
    const values = new Uint32Array(await renderer.getArrayBufferAsync(grid.diagnosticsAttribute));
    return { activeBricks: values[0], overflowedBricks: values[1],
      capacity: grid.capacity, logicalBricks: grid.brickCount, frame,
      requestedBricks: values[2], freshBricks: values[3], releasedBricks: values[4], activeDispatchEntries: values[5],
      priorityDemand: [...values.slice(6, 11)] };
  }

  protected override onBoundaryChanged(): void {
    // Removed walls must not retain a pressure solution belonging to a disconnected domain.
    this.pressureProjection?.invalidate();
    // Pending boundary pipelines may still reference disposed geometry fields from the previous scene.
    if (!this.preparingPool) this.poolAllocation?.cancelPending();
  }

  protected override get cacheSolidOccupancy(): boolean { return true; }

  protected override computeNewSolidCells(callback: (index: Node<'uint'>) => void): ComputeNode {
    return this.volumeGrid.compute(callback, false, true);
  }

  protected override diagnosticCellActive(index: Node<'uint'>): Node<'bool'> {
    return this.volumeGrid.active(index);
  }

  protected override cellIndex(coordinate: Node<'ivec3'>): Node<'uint'> {
    return this.volumeGrid.index(coordinate);
  }

  protected override cellCoordinate(index: Node<'uint'>): Node<'ivec3'> {
    return this.volumeGrid.coordinate(index);
  }

  protected override computeCells(callback: (index: Node<'uint'>) => void): ComputeNode {
    return this.volumeGrid.compute(callback);
  }

  private clearNewBricks(renderer: ParticleSpatialGridRenderer): void {
    if (!this.clearNewNodes.length) {
      const vectors = [this.velocityCurrent, this.velocityNext, this.densityCurrent, this.densityNext,
        this.colorCurrent, this.colorNext, this.curl, this.visualDensity, this.visualColor];
      const scalars = [this.pressureCurrent, this.pressureNext, this.divergence, this.solid];
      const clears = [
        ...vectors.map(field => (index: Node<'uint'>) => { field.element(index).assign(vec4(0)); }),
        ...scalars.map(field => (index: Node<'uint'>) => { field.element(index).assign(0); }),
      ];
      // Seven targets plus the packed slot metadata fit WebGPU's eight-buffer minimum.
      for (let start = 0; start < clears.length; start += 7) {
        const group = clears.slice(start, start + 7);
        this.clearNewNodes.push(this.volumeGrid.compute(index => {
          group.forEach(clear => clear(index));
        }, false, true));
      }
    }
    this.clearNewNodes.forEach(node => renderer.compute(node));
  }

  private clearOutputTextures(renderer: ParticleSpatialGridRenderer): void {
    this.clearTexturesNode ??= Fn(() => {
      const size = this.exportDimensions;
      const coordinate = ivec3(int(instanceIndex.mod(uint(size.x))),
        int(instanceIndex.div(uint(size.x)).mod(uint(size.y))), int(instanceIndex.div(uint(size.x.mul(size.y)))));
      textureStore(this.densityTextureNode, coordinate, vec4(0)).toWriteOnly();
      textureStore(this.colorTextureNode, coordinate, vec4(0)).toWriteOnly();
    })().compute(1);
    const size = this.exportDimensions.value;
    this.clearTexturesNode.count = size.x * size.y * size.z;
    renderer.compute(this.clearTexturesNode);
  }

  private allocateGasFields(): void {
    this.curlAttribute = new StorageBufferAttribute(new Float32Array(this.cellCount * 4), 4);
    this.curl = storage(this.curlAttribute, 'vec4', this.cellCount) as Vec4Storage;
    this.densityAttributeA = new StorageBufferAttribute(new Float32Array(this.cellCount * 4), 4);
    this.densityAttributeB = new StorageBufferAttribute(new Float32Array(this.cellCount * 4), 4);
    this.colorAttributeA = new StorageBufferAttribute(new Float32Array(this.cellCount * 4), 4);
    this.colorAttributeB = new StorageBufferAttribute(new Float32Array(this.cellCount * 4), 4);
    this.visualAttribute = new StorageBufferAttribute(new Float32Array(this.cellCount * 8), 4);
    this.maximaAttribute = new StorageBufferAttribute(new Uint32Array(12), 1);
    this.densityCurrent = storage(this.densityAttributeA, 'vec4', this.cellCount) as Vec4Storage;
    this.densityNext = storage(this.densityAttributeB, 'vec4', this.cellCount) as Vec4Storage;
    this.colorCurrent = storage(this.colorAttributeA, 'vec4', this.cellCount) as Vec4Storage;
    this.colorNext = storage(this.colorAttributeB, 'vec4', this.cellCount) as Vec4Storage;
    // Both transient targets share one binding so a single gather fits the eight-buffer limit.
    const visual = storage(this.visualAttribute, 'vec4', this.cellCount * 2) as Vec4Storage;
    const stride = this.fieldStrideNode;
    this.visualDensity = visual;
    this.visualColor = { element: index => visual.element(uint(index as Node<'uint'>).add(stride)) };
    this.maxima = storage(this.maximaAttribute, 'uint', 12).toAtomic() as AtomicUintStorage;
    this.densityTexture = this.makeTexture();
    this.colorTexture = this.makeTexture();
    this.densityTextureNode = storageTexture(this.densityTexture);
    this.colorTextureNode = storageTexture(this.colorTexture);
  }

  private disposeGasFields(): void {
    this.textureAllocation?.cancelPending(); this.textureAllocation = undefined;
    this.pressureProjection?.dispose();
    this.pressureProjection = undefined;
    this.densityTexture?.dispose();
    this.colorTexture?.dispose();
    [
      this.densityAttributeA,
      this.densityAttributeB,
      this.colorAttributeA,
      this.colorAttributeB,
      this.visualAttribute,
      this.maximaAttribute,
      this.curlAttribute,
      ...this.advectionAttributes,
    ].forEach((attribute) => attribute?.dispose());
    this.advectionAttributes = [];
  }

  private pressureSelection(): PressureSolver {
    if (this.pressureSolver !== PressureSolver.Auto) return this.pressureSolver as PressureSolver;
    const maximum = this.pressureMaxIterations ?? this.pressureIterations;
    const minimum = this.pressureMinIterations ?? this.pressureIterations;
    // Ordinary fixed-budget warm solves have no demonstrated general MG advantage.
    if (maximum < pressureAutoPolicy.minimumWork || !(this.pressureTolerance > 0) || minimum >= maximum) {
      this.autoPressureSolver = PressureSolver.Iterative;
      return PressureSolver.Iterative;
    }
    if (this.preparingPool || this.pressureProjection?.isPreparing) return PressureSolver.Multigrid;
    const hierarchy = pressureHierarchy(this.gridDimensions.toArray(), this.multigrid);
    this.autoPressureSolver = selectPressureSolver(this.brickDiagnostics.resident * this.volumeGrid.cellsPerBrick,
      hierarchy.usefulLevels, this.autoPressureSolver);
    return this.autoPressureSolver;
  }

  private getPressureProjection(): FluidPressureProjection {
    return this.pressureProjection ??= this.createPressureProjection();
  }

  private createPressureProjection(grid = this.volumeGrid, spacing: Node<'float'> = this.cellSizeNode,
    dimensions = this.gridDimensions): FluidPressureProjection {
    const projection: FluidPressureProjection = this.benchmarks.span('pressureResourceCreation',
      () => new FluidPressureProjection(
        dimensions, spacing, this.maxVelocityNode, this.solid, this.pressureCurrent, this.divergence,
        this.closedMinNode, this.closedMaxNode, grid, undefined, undefined, undefined,
        this.faceOpenness, this.solidVelocity, () => ({ ...this.pressureControls,
          multigrid: this.pressureSelection() === PressureSolver.Multigrid
            || (projection?.isPreparing && this.pressureSolver === PressureSolver.Auto
              && (this.pressureMaxIterations ?? this.pressureIterations) >= pressureAutoPolicy.minimumWork
              && this.pressureTolerance > 0
              && (this.pressureMinIterations ?? this.pressureIterations)
                < (this.pressureMaxIterations ?? this.pressureIterations)),
          autoMultigrid: this.pressureSolver === PressureSolver.Auto,
          multigridOptions: { preSmooth: this.multigrid?.preSmoothing ?? 2,
            postSmooth: this.multigrid?.postSmoothing ?? 4, coarseIterations: this.multigrid?.bottomIterations ?? 12 },
          topologyVersion: this.pressureTopologyVersion }),
    ));
    return projection;
  }

  protected override sampleVelocity(position: Node<'vec3'>, field = this.velocityCurrent): Node<'vec3'> {
    if (field !== this.velocityCurrent) return super.sampleVelocity(position, field);
    return this.getPressureProjection().sample(position.sub(this.boundsMinNode).div(this.cellSizeNode));
  }

  protected override solveProjection(
    renderer: ParticleSpatialGridRenderer,
    input: Vec4Storage,
    output: Vec4Storage,
  ): void {
    this.benchmarks.span('pressureSolve', () => {
      this.getPressureProjection().solve(renderer, input, output, this.pressureIterations);
    });
  }

  private ensureAdvectionFields(): void {
    if (this.advectionAttributes.length) return;
    this.poolAllocation?.cancelPending();
    this.advectionAttributes = Array.from({ length: 3 }, () => (
      new StorageBufferAttribute(new Float32Array(this.cellCount * 4), 4)
    ));
    [this.velocityAdvected, this.densityAdvected, this.colorAdvected] = this.advectionAttributes
      .map((attribute) => storage(attribute, 'vec4', this.cellCount) as Vec4Storage);
  }

  /** Texture preparation must never hold back simulation coverage or page admission. */
  private updateExportLayout(renderer: ParticleSpatialGridRenderer): void {
    this.ensureTextureCapacity(renderer, this.gridDimensions);
    const size = this.exportDimensions.value.copy(this.gridDimensions).min(this.textureDimensions);
    const offset = this.exportOffset.value;
    const support = this.occupiedBounds.isEmpty() ? this.bounds : this.occupiedBounds;
    const center = support.getCenter(new THREE.Vector3()).sub(this.bounds.min).divideScalar(this.cellSize);
    for (const axis of ['x', 'y', 'z'] as const) {
      // Retain the occupied region while a larger derived texture prepares in the background.
      offset[axis] = Math.max(0, Math.min(this.gridDimensions[axis] - size[axis],
        Math.floor((center[axis] - size[axis] / 2) / this.volumeGrid.brickSide) * this.volumeGrid.brickSide));
    }
    const minimum = offset.clone().multiplyScalar(this.cellSize).add(this.bounds.min);
    for (const field of [this.density, this.colorField]) {
      const maximum = minimum.clone().addScaledVector(size, this.cellSize);
      if (!field.bounds.min.equals(minimum) || !field.bounds.max.equals(maximum) || !field.resolution.equals(size)) {
        field.bounds.set(minimum, maximum);
        field.resolution.copy(size);
        field.version++;
      }
    }
  }

  private ensureTextureCapacity(renderer: ParticleSpatialGridRenderer, dimensions: THREE.Vector3): boolean {
    this.requestedTextureDimensions.copy(dimensions);
    this.textureAllocation?.commit();
    if (dimensions.toArray().every((size, axis) => size <= this.textureDimensions.getComponent(axis))) return true;
    const device = (renderer.backend as { device: { limits: { maxTextureDimension3D: number };
      queue: { onSubmittedWorkDone(): Promise<void> } } }).device;
    this.textureAllocation ??= new StagedGPUAllocation<GasTexturePool>({
      dimensions: this.textureDimensions.clone(), density: this.densityTexture, color: this.colorTexture,
    }, 1, {
      maximumCapacity: 2 ** 30,
      create: () => {
        const next = this.textureDimensions.clone(), brick = this.volumeGrid.brickSide;
        for (const axis of ['x', 'y', 'z'] as const) if (this.requestedTextureDimensions[axis] > next[axis]) {
          next[axis] = Math.ceil(Math.max(this.requestedTextureDimensions[axis], next[axis] * 1.5) / brick) * brick;
        }
        if (Math.max(...next.toArray()) > device.limits.maxTextureDimension3D) {
          throw new RangeError('Gas texture capacity exceeds maxTextureDimension3D.');
        }
        return { dimensions: next, density: this.createTexture(next), color: this.createTexture(next) };
      },
      prepare: async next => {
        const textures = renderer as ParticleSpatialGridRenderer & { initTexture(texture: THREE.Texture): void };
        textures.initTexture(next.density);
        await new Promise(resolve => setTimeout(resolve, 0));
        textures.initTexture(next.color);
      },
      // Export textures are derived fields. Re-exporting uses the authoritative resident values after swap.
      migrate: () => {},
      swap: next => {
        this.textureDimensions.copy(next.dimensions);
        this.densityTexture = next.density; this.colorTexture = next.color;
        this.densityTextureNode.value = next.density; this.colorTextureNode.value = next.color;
        this.density.texture = next.density; this.colorField.texture = next.color;
        this.domainChanges.capacity++;
      },
      dispose: previous => { previous.density.dispose(); previous.color.dispose(); },
      fence: () => device.queue.onSubmittedWorkDone(),
    });
    this.textureAllocation.request(this.textureAllocation.capacity);
    return false;
  }

  private makeTexture(): Storage3DTexture {
    if (this.textureDimensions.lengthSq() === 0) {
      this.textureDimensions.copy(this.gridDimensions).addScalar(2 * (2 ** this.spatialGridOptions!.cellSubdivisions!));
    }
    this.textureDimensions.max(this.gridDimensions);
    return this.createTexture(this.textureDimensions);
  }

  private createTexture(dimensions: THREE.Vector3): Storage3DTexture {
    const texture = new Storage3DTexture(dimensions.x, dimensions.y, dimensions.z);
    texture.format = THREE.RGBAFormat;
    texture.type = THREE.HalfFloatType;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    (texture as Storage3DTexture & { mipmapsAutoUpdate: boolean }).mipmapsAutoUpdate = false;
    return texture;
  }

  private syncBehaviorParameters(): void {
    for (const [range, node] of [[this.temperatureRange, this.behaviorTemperatureRange],
      [this.densityRange, this.behaviorDensityRange]] as const) {
      if (!range.every(Number.isFinite) || range[1] <= range[0]) {
        throw new RangeError('Gas behavior temperatureRange/densityRange must be finite and increasing.');
      }
      node.value.set(...range);
    }
    this.evaluateDynamicGPU.sync();
    this.behaviorKey = [this.evaluateDynamicGPU.version, ...behaviorCoefficients.flatMap(name => [
      this[`${name}ByTemperature`] != null, this[`${name}ByDensity`] != null,
    ])].join(':');
  }

  /** Shared physical normalization, materialized once per cell only for requested state inputs. */
  private behaviorState(field: Node<'vec4'>, coefficients: readonly BehaviorCoefficient[]): BehaviorState {
    const result: BehaviorState = {};
    if (coefficients.some(name => this[`${name}ByTemperature`] != null)) {
      const range = this.behaviorTemperatureRange;
      result.temperature = field.y.div(field.x.max(1e-6)).sub(range.x)
        .div(range.y.sub(range.x)).clamp(0, 1).toVar('gasBehaviorTemperature');
    }
    if (coefficients.some(name => this[`${name}ByDensity`] != null)) {
      const range = this.behaviorDensityRange;
      result.density = field.x.sub(range.x).div(range.y.sub(range.x)).clamp(0, 1).toVar('gasBehaviorDensity');
    }
    return result;
  }

  private effectiveBehavior(name: BehaviorCoefficient, base: Node<'float'>, state: BehaviorState): Node<'float'> {
    let value = base;
    for (const [suffix, parameter] of [['Temperature', state.temperature], ['Density', state.density]] as const) {
      const key = `${name}By${suffix}` as const;
      if (this[key] == null) continue;
      const multiplier = this.evaluateDynamicGPU.parameterNumber(key, () => this[key], parameter!, 1).max(0);
      value = value.mul(multiplier);
    }
    return value;
  }

  /** Inline rules at the existing coefficient sites; no coefficient fields or additional dispatches. */
  private evaluateGasModules(
    field: Node<'vec4'>, color: Node<'vec4'>, velocity: Node<'vec3'>,
    position: Node<'vec3'>, context: GPUParticleUpdateContext, coefficientField = field,
  ): { cell: GPUGasCell; coefficients: GasModuleContext } | undefined {
    if (!this.gasModules.length) return undefined;
    const mass = field.x.max(1e-6);
    const cell: GPUGasCell = {
      position, density: field.x.toVar(), temperature: field.y.div(mass).toVar(),
      velocity: velocity.toVar(), color: color.xyz.div(mass).toVar(),
    };
    const state = this.behaviorState(coefficientField, behaviorCoefficients);
    const coefficients: GasModuleContext = {
      module: this.gasModules[0], deltaTime: context.deltaTimeNode, elapsedTime: context.elapsedTimeNode,
      buoyancy: float(this.buoyancy).toVar(), scalarDiffusion: this.scalarDiffusionNode.toVar(),
      turbulenceNoiseStrength: this.effectiveBehavior('turbulenceNoiseStrength',
        float(this.turbulenceNoiseStrength), state).toVar(),
      turbulenceNoiseFrequency: this.effectiveBehavior('turbulenceNoiseFrequency',
        float(this.turbulenceNoiseFrequency), state).toVar(),
      vorticityStrength: this.effectiveBehavior('vorticityStrength', this.vorticityNode, state).toVar(),
      densityDissipation: this.effectiveBehavior('densityDissipation', this.densityDissipationNode, state).toVar(),
      temperatureDissipation: this.effectiveBehavior('temperatureDissipation',
        this.temperatureDissipationNode, state).toVar(),
      colorDissipation: this.effectiveBehavior('colorDissipation', this.colorDissipationNode, state).toVar(),
      velocityDissipation: this.effectiveBehavior('velocityDissipation', this.velocityDissipationNode, state).toVar(),
    };
    for (const module of this.gasModules) module.modifyGasGPU!(cell, { ...coefficients, module });
    return { cell, coefficients };
  }

  private syncSimulationUniforms(): void {
    this.syncBehaviorParameters();
    this.vorticityNode.value = Math.max(0, this.vorticityStrength);
    this.densityDissipationNode.value = Math.max(0, this.densityDissipation);
    this.densityCutoffNode.value = Math.max(0, this.densityCutoff);
    this.temperatureDissipationNode.value = Math.max(0, this.temperatureDissipation);
    this.colorDissipationNode.value = Math.max(0, this.colorDissipation);
    this.velocityDissipationNode.value = Math.max(0, this.velocityDissipation);
    this.scalarDiffusionNode.value = Math.max(0, this.scalarDiffusion);
  }

  private applyVorticity(context: GPUParticleUpdateContext, renderer: ParticleSpatialGridRenderer): void {
    if (!(this.vorticityNode.value > 0) && !this.gasModules.length) return;
    const sample = (field: Vec4Storage, coordinate: Node<'ivec3'>, x: number, y: number, z: number) => (
      field.element(this.cellIndex(ivec3(clamp(
        vec3(coordinate.add(ivec3(x, y, z))), vec3(0), this.dimensionsNode.sub(1),
      ))))
    );
    const curl = this.curlNode ?? this.computeCells(index => {
      const coordinate = this.cellCoordinate(index);
      const dx = sample(this.velocityNext, coordinate, 1, 0, 0).xyz
        .sub(sample(this.velocityNext, coordinate, -1, 0, 0).xyz);
      const dy = sample(this.velocityNext, coordinate, 0, 1, 0).xyz
        .sub(sample(this.velocityNext, coordinate, 0, -1, 0).xyz);
      const dz = sample(this.velocityNext, coordinate, 0, 0, 1).xyz
        .sub(sample(this.velocityNext, coordinate, 0, 0, -1).xyz);
      const rotation = vec3(dy.z.sub(dz.y), dz.x.sub(dx.z), dx.y.sub(dy.x))
        .mul(0.5).div(this.cellSizeNode).toVar('gasCurl');
      this.curl.element(index).assign(this.isSolid(index).select(vec4(0), vec4(rotation, rotation.length())));
    });
    this.curlNode = curl;
    this.benchmarks.span('curl', () => renderer.compute(curl));
    // Capture the field identity as well as the cache key: staged compilation happens after ping-pong swaps.
    const densityField = this.densityCurrent;
    const confinement = this.confinementNodes.get(densityField) ?? this.computeCells(index => {
      const coordinate = this.cellCoordinate(index);
      const gradient = vec3(
        sample(this.curl, coordinate, 1, 0, 0).w.sub(sample(this.curl, coordinate, -1, 0, 0).w),
        sample(this.curl, coordinate, 0, 1, 0).w.sub(sample(this.curl, coordinate, 0, -1, 0).w),
        sample(this.curl, coordinate, 0, 0, 1).w.sub(sample(this.curl, coordinate, 0, 0, -1).w),
      ).toVar('gasCurlGradient');
      const normal = gradient.div(gradient.length().max(1e-6));
      // Fedkiw et al.: epsilon * h * (normalized grad |curl u|) cross curl u.
      const state = this.behaviorState(densityField.element(index), ['vorticityStrength']);
      const modules = this.evaluateGasModules(densityField.element(index), this.colorCurrent.element(index),
        this.velocityNext.element(index).xyz, this.cellCenter(coordinate), context);
      const strength = modules?.coefficients.vorticityStrength
        ?? this.effectiveBehavior('vorticityStrength', this.vorticityNode, state);
      const force = normal.cross(this.curl.element(index).xyz)
        .mul(strength).mul(this.cellSizeNode);
      const velocity = this.velocityNext.element(index);
      velocity.assign(this.isSolid(index).select(vec4(0), vec4(
        this.clampVelocity(velocity.xyz.add(force.mul(context.deltaTimeNode))), 0,
      )));
    });
    this.confinementNodes.set(densityField, confinement);
    this.benchmarks.span('vorticity', () => renderer.compute(confinement));
  }

  private predictAdvection(
    source: Vec4Storage,
    target: Vec4Storage,
    context: GPUParticleUpdateContext,
    renderer: ParticleSpatialGridRenderer,
  ): void {
    const node = this.advectionNodes.get(source) ?? this.computeCells(index => {
      const center = this.cellCenter(this.cellCoordinate(index));
      const position = center.sub(this.sampleVelocity(center).mul(context.deltaTimeNode));
      const blocked = this.isSolid(this.cellIndex(this.worldToCell(position)));
      const value = blocked.select(source.element(index), this.sampleField(position, source));
      target.element(index).assign(this.isSolid(index).select(vec4(0), value));
    });
    this.advectionNodes.set(source, node);
    renderer.compute(node);
  }

  private advectField(
    source: Vec4Storage,
    predicted: Vec4Storage,
    center: Node<'vec3'>,
    dt: Node<'float'>,
    index: Node<'uint'>,
  ): Node<'vec4'> {
    const displacement = this.sampleVelocity(center).mul(dt).toVar('gasDisplacement');
    const backtrace = center.sub(displacement);
    const blocked = this.isSolid(this.cellIndex(this.worldToCell(backtrace)));
    const firstOrder = blocked.select(source.element(index), this.sampleField(backtrace, source));
    if (this.advectionMethod === AdvectionMethod.SemiLagrangian) return firstOrder as Node<'vec4'>;

    const reversePosition = center.add(displacement);
    const reversed = this.sampleField(reversePosition, predicted);
    const corrected = predicted.element(index).add(source.element(index).sub(reversed).mul(0.5));
    const base = backtrace.sub(this.boundsMinNode).div(this.cellSizeNode).sub(0.5).floor();
    const lower = vec4(1e30).toVar('gasDonorMinimum');
    const upper = vec4(-1e30).toVar('gasDonorMaximum');
    const valid = displacement.abs().lessThanEqual(vec3(this.cellSizeNode)).all()
      .toVar('gasAdvectionValid');
    // Limit against the original donor cells, reverting near solids or domain edges.
    for (let z = 0; z < 2; z += 1) {
      for (let y = 0; y < 2; y += 1) {
        for (let x = 0; x < 2; x += 1) {
          const coordinate = base.add(vec3(x, y, z));
          const index = this.cellIndex(ivec3(clamp(coordinate, vec3(0), this.dimensionsNode.sub(1))));
          const value = source.element(index);
          lower.assign(min(lower, value));
          upper.assign(max(upper, value));
          valid.assign(valid.and(coordinate.greaterThanEqual(vec3(0)).all())
            .and(coordinate.lessThan(this.dimensionsNode).all()).and(this.isSolid(index).not()));
          const reverseCoordinate = reversePosition.sub(this.boundsMinNode).div(this.cellSizeNode)
            .sub(0.5).floor().add(vec3(x, y, z));
          const reverseIndex = this.cellIndex(ivec3(clamp(reverseCoordinate, vec3(0), this.dimensionsNode.sub(1))));
          valid.assign(valid.and(reverseCoordinate.greaterThanEqual(vec3(0)).all())
            .and(reverseCoordinate.lessThan(this.dimensionsNode).all()).and(this.isSolid(reverseIndex).not()));
        }
      }
    }
    return valid.select(clamp(corrected, lower, upper), firstOrder) as Node<'vec4'>;
  }

  private limitSpecificFields(
    transportedDensity: Node<'vec4'>,
    transportedColor: Node<'vec4'>,
    density: Vec4Storage,
    color: Vec4Storage,
    position: Node<'vec3'>,
  ): [Node<'vec4'>, Node<'vec4'>] {
    const base = position.sub(this.boundsMinNode).div(this.cellSizeNode).sub(0.5).floor();
    const lower = vec4(1e30).toVar('gasSpecificMinimum');
    const upper = vec4(-1e30).toVar('gasSpecificMaximum');
    const found = float(0).toVar('gasSpecificDonors');
    for (let z = 0; z < 2; z += 1) {
      for (let y = 0; y < 2; y += 1) {
        for (let x = 0; x < 2; x += 1) {
          const index = this.cellIndex(ivec3(clamp(base.add(vec3(x, y, z)), vec3(0), this.dimensionsNode.sub(1))));
          const state = density.element(index);
          const specific = vec4(state.y, color.element(index).xyz).div(state.x.max(1e-6));
          const present = state.x.greaterThan(1e-6).and(this.isSolid(index).not());
          lower.assign(present.select(min(lower, specific), lower));
          upper.assign(present.select(max(upper, specific), upper));
          found.addAssign(present.select(1, 0));
        }
      }
    }
    // Bounding heat and density separately does not bound heat / density.
    const state = transportedDensity.toVar('gasTransportedDensity');
    const specific = vec4(state.y, transportedColor.xyz).div(state.x.max(1e-6));
    const weighted = found.greaterThan(0).select(clamp(specific, lower, upper), specific).mul(state.x);
    return [vec4(state.x, weighted.x, 0, 0), vec4(weighted.yzw, 0)];
  }

  private splatRadius(scale: Node<'vec3'>): Node<'float'> {
    const minimum = this.cellSizeNode;
    const particleRadius = max(scale.x.abs(), max(scale.y.abs(), scale.z.abs())).mul(0.5);
    return max(particleRadius, minimum) as Node<'float'>;
  }

  private sourceStep(particle: GPUParticleLike, dt: Node<'float'>): Node<'float'> {
    // Sources are sampled before aging/integration. Do not emit gas for the
    // portion of a long update during which this particle has already expired.
    return min(dt, max(particle.lifetime.sub(particle.realtime.div(1000)), float(0)));
  }

  protected override guardSources(): FluidGuardSource[] {
    const density = this.densityCurrent, grid = this.volumeGrid;
    // Field nodes survive a quality swap, but their compact dispatch/page directory does not.
    if (this.guardBehaviorKey !== this.behaviorKey || this.guardGrid !== grid) {
      this.guardGrid = grid;
      this.guardBehaviorKey = this.behaviorKey; this.guardGasKeys = new WeakMap();
    }
    let key = this.guardGasKeys.get(density);
    if (!key) { key = {}; this.guardGasKeys.set(density, key); }
    return [...super.guardSources(), { key, compute: callback => grid.compute(callback),
      sample: index => {
        const physical = density.element(index);
        const rate = this.effectiveBehavior('densityDissipation', this.densityDissipationNode,
          this.behaviorState(physical, ['densityDissipation']));
        const lifetime = rate.greaterThan(0).and(this.densityCutoffNode.greaterThan(0)).select(
          physical.x.div(this.densityCutoffNode.max(1e-12)).max(1).log().div(rate.max(1e-12)),
          float(GUARD_PREDICTION_HORIZON),
        );
        return { position: this.cellCenter(this.cellCoordinate(index)),
          velocity: this.velocityCurrent.element(index).xyz, remainingLifetime: lifetime,
          active: physical.x.greaterThan(0).and(physical.x.greaterThanEqual(this.densityCutoffNode)), gas: true };
      } }];
  }

  protected override async readOccupiedFieldBounds(renderer: ParticleSpatialGridRenderer): Promise<THREE.Box3> {
    const grid = this.volumeGrid;
    const minimum = this.maximaMinimum.clone(), cellSize = this.maximaCellSize;
    const coordinates = new Uint32Array(await renderer.getArrayBufferAsync(this.maximaAttribute));
    const occupied = new THREE.Box3();
    if (grid !== this.volumeGrid) return occupied;
    if (coordinates[2] !== 0xffffffff && coordinates[5] > 0) {
      occupied.min.set(coordinates[2], coordinates[3], coordinates[4]).multiplyScalar(cellSize).add(minimum);
      occupied.max.set(coordinates[5], coordinates[6], coordinates[7]).multiplyScalar(cellSize).add(minimum);
    }
    this.occupiedGasBounds.copy(occupied);
    return occupied;
  }

  private particleTemperature(time: Node<'float'>, seed: Node): Node<'float'> {
    return float(this.sourceTemperature).mul(this.evaluateDynamicGPU.number(
      'temperatureOverLifetime',
      () => this.temperatureOverLifetime,
      time,
      1,
      seed,
    )) as Node<'float'>;
  }

  private reduceFieldMaxima(renderer: ParticleSpatialGridRenderer, density: Vec4Storage): void {
    // Keep the mapping associated with this reduction, even when the following frame remaps the domain.
    this.maximaMinimum.copy(this.bounds.min);
    this.maximaCellSize = this.cellSize;
    const reset = this.maximaResetNode ?? Fn(() => {
      const minimum = instanceIndex.greaterThanEqual(2).and(instanceIndex.lessThan(5));
      atomicStore(this.maxima.element(instanceIndex), minimum.select(uint(0xffffffff), uint(0)));
    })().compute(12);
    this.maximaResetNode = reset;
    renderer.compute(reset);

    const reduce = this.maximaNodes.get(density) ?? this.computeCells(index => {
      const value = density.element(index);
      const cellDensity = max(value.x, float(0));
      const temperature = max(value.y.div(max(cellDensity, float(1e-6))), float(0));
      atomicMax(this.maxima.element(0), floatBitsToUint(cellDensity));
      atomicMax(this.maxima.element(1), floatBitsToUint(temperature));
      If(cellDensity.greaterThan(0).and(cellDensity.greaterThanEqual(this.densityCutoffNode)), () => {
        const coordinate = this.cellCoordinate(index);
        (['x', 'y', 'z'] as const).forEach((axis, i) => {
          atomicMin(this.maxima.element(2 + i), uint(coordinate[axis]));
          atomicMax(this.maxima.element(5 + i), uint(coordinate[axis]).add(1));
        });
        atomicMax(this.maxima.element(8), floatBitsToUint(this.velocityCurrent.element(index).xyz.length()));
        (['x', 'y', 'z'] as const).forEach((axis, i) => {
          atomicMax(this.maxima.element(9 + i), floatBitsToUint(this.velocityCurrent.element(index)[axis].abs()));
        });
      });
    });
    this.maximaNodes.set(density, reduce);
    renderer.compute(reduce);
  }

  private neighborAverage(field: Vec4Storage, coordinate: Node<'ivec3'>): Node<'vec4'> {
    const sample = (x: number, y: number, z: number) => field.element(this.cellIndex(ivec3(clamp(
      vec3(coordinate).add(vec3(x, y, z)), vec3(0), this.dimensionsNode.sub(1),
    ))));
    return sample(-1, 0, 0).add(sample(1, 0, 0))
      .add(sample(0, -1, 0)).add(sample(0, 1, 0))
      .add(sample(0, 0, -1)).add(sample(0, 0, 1))
      .div(6) as Node<'vec4'>;
  }

  /** Export physical quantities; visualization belongs to the volume renderer. */
  private outputParameters(index: Node<'uint'>, density: Node<'float'>,
    temperatureMass: Node<'float'>, visualVelocity?: Node<'vec3'>): Node<'vec4'> {
    const coordinate = this.cellCoordinate(index);
    const velocity = (x: number, y: number, z: number) => this.velocityCurrent.element(this.cellIndex(
      ivec3(clamp(vec3(coordinate).add(vec3(x, y, z)), vec3(0), this.dimensionsNode.sub(1))),
    )).xyz;
    const dx = velocity(1, 0, 0).sub(velocity(-1, 0, 0));
    const dy = velocity(0, 1, 0).sub(velocity(0, -1, 0));
    const dz = velocity(0, 0, 1).sub(velocity(0, 0, -1));
    const curl = vec3(dy.z.sub(dz.y), dz.x.sub(dx.z), dx.y.sub(dy.x)).mul(0.5).div(this.cellSizeNode);
    // Represent mixed-cell visual coverage without changing solver mass, heat or collision blocking.
    // Premultiplied physical channels receive the same coverage, preserving specific temperature/speed/curl.
    const coverage = this.faceOpenness.element(index).w.clamp(0, 1);
    return density.greaterThan(0).select(vec4(density,
      temperatureMass,
      (visualVelocity ?? this.velocityCurrent.element(index).xyz).length().mul(density), curl.length().mul(density),
    ).mul(coverage), vec4(0));
  }

  private outputColor(accumulatedColor: Node<'vec3'>, density: Node<'float'>): Node<'vec3'> {
    return accumulatedColor.div(max(density, float(1e-6))) as Node<'vec3'>;
  }

}

// Gas transport uses staggered face fluxes so D, G and the pressure Laplacian
// describe the same operator. Center velocities remain the force/source workspace.
export default GasSimulation;
