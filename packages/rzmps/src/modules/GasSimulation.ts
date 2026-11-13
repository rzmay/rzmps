import SpatialEffect from '../spatial/effects/SpatialEffect';
import GasAffector from '../spatial/effects/GasAffector';
import FluidCollider from '../spatial/effects/FluidCollider';
import ParticleForceField from '../spatial/effects/ParticleForceField';
import acceptMultiple from '../utils/acceptMultiple';
import type { GasCellGPU } from '../spatial/effects/GasAffector';
import type { ModuleExecutionContext } from '../core/Module';
import type ParticleSystem from '../core/ParticleSystem';
import tagsIntersect from '../core/tags/tagsIntersect';
import { sampleGasEffectGPU } from '../simulation/gpu/gasSpatialEffects.utils';
import * as THREE from 'three';
import { Storage3DTexture, StorageBufferAttribute, type ComputeNode, type Node } from 'three/webgpu';
import {
  Fn, If, atomicMax, atomicMin, atomicStore, clamp, float, floatBitsToUint, instanceIndex, int, ivec3,
  max, min, mix, pow, storage, textureStore, uint, uniform, vec3, vec4,
} from 'three/tsl';
import type {
  GPUParticleLike, GPUParticleRenderBufferState, GPUParticleUpdateContext,
} from '../simulation/gpu/Particle';
import ParticleSpatialGrid, { type ParticleSpatialGridRenderer } from '../spatial/structures/ParticleSpatialGrid';
import { generateGPUParticleNoise4D } from '../utils/noise.utils';
import type { VolumeField } from '../rendering/volumeField.types';
import type { VolumeFieldProvider } from '../rendering/volumeField.types';
import averageDynamicNumber from '../values/averageDynamicNumber';
import evaluateByParameterNumber from '../values/evaluateByParameterNumber';
import type { ValueByParameter } from '../values/valueByParameter.types';
import type { DynamicValue } from '../values/dynamicValue.types';
import FluidSimulation, { type FluidSimulationOptions } from './FluidSimulation';
import SparseVolumeGrid from '../spatial/structures/gpu/SparseVolumeGrid';
import FluidPressureProjection from '../simulation/gpu/FluidPressureProjection';
import StagedGPUAllocation from '../utils/gpu/StagedGPUAllocation';
import { copyStorageAttributes, initializeStorageAttribute } from '../utils/gpu/storage.utils';
import { AdvectionMethod } from '../enums/AdvectionMethod';

interface GasPool {
  context: GasSimulation;
  attributes: StorageBufferAttribute[];
  grid: SparseVolumeGrid;
  projection?: FluidPressureProjection;
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

  /** Initially reserved bricks. Omission selects a modest reserve; growth is automatic and geometric. */
  initialBrickCapacity: number;
  /** Sparse V-cycle corrections, or the iterative reference path. Defaults to Iterative. */
  pressureSolver: 'Multigrid' | 'Iterative';
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
  /** Particle-motion lookahead for automatic domain padding, in seconds. Defaults to one. */
  velocityPaddingLookahead: number;
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
  pressureSolver: 'Multigrid' | 'Iterative';
  get maxBrickCapacity(): number { return this.maxActiveBricks; }
  set maxBrickCapacity(value: number) { this.maxActiveBricks = value; }
  private requiredBrickCapacity = 0;
  private growthEvents = 0;
  private peakAllocatedBytes = 0;
  private volumeGrid: SparseVolumeGrid;
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
  /** Particle-motion lookahead for automatic domain padding, in seconds. Defaults to one. */
  velocityPaddingLookahead: number;
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
  private poolContext?: GPUParticleUpdateContext;
  private poolParticleGrid?: ParticleSpatialGrid;
  private preparingPool = false;

  private permanentEffects: SpatialEffect[] = [];
  private transientEffects: SpatialEffect[] = [];
  private spatialEffectsKey = '';
  private effectNodes = new Map<string, WeakMap<object, ComputeNode>>();
  private visualStateNodes = new WeakMap<object, ComputeNode>();

  public override prepare(context: ModuleExecutionContext): void {
    super.prepare(context);
    this.prepareGasEffects(context.system);
  }

  /** Virtual shorthand for editing the force-field constructor in requireSpatialEffects. */
  get supportForceFields(): boolean { return this.requireSpatialEffects?.includes(ParticleForceField) ?? false; }
  set supportForceFields(enabled: boolean) {
    const requirements = this.requireSpatialEffects ?? [];
    this.requireSpatialEffects = enabled
      ? [...new Set([...requirements, ParticleForceField])]
      : requirements.filter(entry => entry !== ParticleForceField);
  }

  private prepareGasEffects(system: ParticleSystem): void {
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
      requireSpatialEffects: [...new Set([FluidCollider, GasAffector,
        ...(acceptMultiple(options.requireSpatialEffects) ?? [])])],
      automaticPadding: options.automaticPadding ?? true,
    });
    if (options.supportForceFields !== undefined) this.supportForceFields = options.supportForceFields;
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
    this.velocityPaddingLookahead = Math.max(0, options.velocityPaddingLookahead ?? 1);
    this.turbulenceNoiseFrequency = Math.max(0, options.turbulenceNoiseFrequency ?? 0.75);
    this.turbulenceNoiseSpeed = options.turbulenceNoiseSpeed ?? 0.2;
    this.turbulenceNoiseOctaves = Math.max(1, Math.floor(options.turbulenceNoiseOctaves ?? 2));

    this.pressureSolver = options.pressureSolver ?? 'Iterative';
    this.maxActiveBricks = options.maxBrickCapacity ?? options.maxActiveBricks ?? Number.MAX_SAFE_INTEGER;
    this.initialBrickCapacity = options.initialBrickCapacity ?? Math.min(64, this.maxActiveBricks,
      Math.max(1, Math.floor(262144 / (2 ** (this.spatialGridOptions!.cellSubdivisions ?? 3)) ** 3)));
    if (!Number.isSafeInteger(this.initialBrickCapacity) || this.initialBrickCapacity < 1
      || !Number.isSafeInteger(this.maxActiveBricks) || this.maxActiveBricks < this.initialBrickCapacity) {
      throw new RangeError('Gas brick capacities must be positive integers with initial <= maximum.');
    }
    this.volumeGrid = new SparseVolumeGrid(this.spatialGridOptions!, this.initialBrickCapacity);
    this.benchmarks.register('allocatedBricks', { type: 'gauge', get: () => this.volumeGrid.capacity });
    this.benchmarks.register('peakAllocatedBytes', { type: 'gauge', unit: 'bytes',
      get: () => this.peakAllocatedBytes = Math.max(this.peakAllocatedBytes, this.allocatedBytes) });
    this.benchmarks.register('growthEvents', { type: 'counter', get: () => this.growthEvents });
    this.benchmarks.register('allocatedBytes', { type: 'gauge', unit: 'bytes', get: () => this.allocatedBytes });
    this.sparseStructureKey = [this.volumeGrid.brickSubdivisions,
      this.volumeGrid.cellSubdivisions].join('|');
    this.resizeGridFields(this.volumeGrid.cellCount);
    this.allocateGasFields();
    this.density = {
      texture: this.densityTexture,
      bounds: this.bounds.clone(),
      resolution: new THREE.Vector3(this.resolution, this.resolution, this.resolution),
      channels: 4,
      parameterChannels: { temperature: 1, speed: 2, vorticity: 3 },
      parametersPremultiplied: true,
      version: 0,
    };
    this.colorField = {
      texture: this.colorTexture,
      bounds: this.bounds.clone(),
      resolution: this.density.resolution.clone(),
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
    await super.prepareResources(system, renderer);
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
  }

  public override computeGPU(
    context: GPUParticleUpdateContext,
    renderer: ParticleSpatialGridRenderer,
    grid?: ParticleSpatialGrid,
  ): void {
    if (!grid) throw new Error('GasSimulation requires a GPU spatial grid.');
    if (!['Multigrid', 'Iterative'].includes(this.pressureSolver)) throw new RangeError('Unknown gas pressureSolver.');
    if (!Object.values(AdvectionMethod).includes(this.advectionMethod as AdvectionMethod)) {
      throw new RangeError('Unknown gas advectionMethod.');
    }
    super.computeGPU(context, renderer, grid);
    this.ensureGridResolution(renderer, grid);
    this.poolContext = context;
    this.poolParticleGrid = grid;
    this.ensurePoolAllocation(renderer, context, grid);
    this.poolAllocation!.commit();
    this.poolAllocation!.request(this.requiredBrickCapacity);
    this.requiredBrickCapacity = 0;
    if (this.advectionMethod === AdvectionMethod.MacCormack) this.ensureAdvectionFields();
    this.syncSimulationUniforms();
    this.refreshBounds(grid, renderer);
    this.volumeGrid.bounds.copy(this.bounds);
    this.benchmarks.span('brickActivation', () => {
      this.volumeGrid.rebuild(context, renderer, this.densityCurrent, this.velocityCurrent,
        this.boundsMinNode, this.cellSizeNode, this.densityCutoffNode,
        context.system.getGPUFilterTagMask(this.tags), this.pendingPreviousBounds);
    });
    if ((++this.sparseReadFrame % 60 === 0 || this.benchmarks.enabled || this.volumeGrid.capacity < Math.min(
      this.maxActiveBricks, this.volumeGrid.brickCount,
    )) && !this.sparseReadPending) {
      this.sparseReadPending = true;
      const volumeGrid = this.volumeGrid;
      void this.readGridDiagnostics(renderer).then(diagnostics => {
        if (volumeGrid !== this.volumeGrid) return;
        this.requiredBrickCapacity = diagnostics.activeBricks + diagnostics.overflowedBricks;
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
  }

  /** Resource-local graphs can be compiled off to the side without advancing the current fields. */
  private computeTransport(context: GPUParticleUpdateContext, renderer: ParticleSpatialGridRenderer,
    grid: ParticleSpatialGrid): void {
    const dt = context.deltaTimeNode;
    const tagMask = context.system.getGPUFilterTagMask(this.tags);

    const cacheKey = [grid.resourceVersion, context.buffers.version, tagMask,
      this.buoyancy, this.weight, this.velocitySourceStrength, this.sourceStrength,
      this.sourceTemperature, Boolean(this.temperatureOverLifetime), this.turbulenceNoiseStrength,
      this.turbulenceNoiseFrequency,
      this.turbulenceNoiseSpeed, this.turbulenceNoiseOctaves, this.advectionMethod, this.behaviorKey].join('|');
    if (cacheKey !== this.gpuCacheKey) {
      this.gpuCacheKey = cacheKey;
      this.velocityNodes = new WeakMap();
      this.velocitySourceNode = undefined;
      this.sourceNodes = new WeakMap();
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
      const previous = this.advectField(this.velocityCurrent, this.velocityAdvected, center, dt, index).xyz;
      const density = velocityDensity.element(index);
      const temperature = density.y.div(max(density.x, float(1e-6)));
      const state = this.behaviorState(density, [
        'turbulenceNoiseStrength', 'turbulenceNoiseFrequency', 'velocityDissipation',
      ]);
      const lift = temperature.mul(this.buoyancy).sub(density.x.mul(this.weight));
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
      const frequency = this.effectiveBehavior('turbulenceNoiseFrequency',
        float(Math.max(0, this.turbulenceNoiseFrequency)), state);
      const variableFrequency = this.turbulenceNoiseFrequencyByTemperature != null
        || this.turbulenceNoiseFrequencyByDensity != null;
      const noise = (offset: THREE.Vector3) => variableFrequency
        ? generateGPUParticleNoise4D(center.add(vec3(offset)).mul(frequency),
          { ...noiseSettings, frequency: 1, offset: new THREE.Vector3() }, noiseTime)
        : generateGPUParticleNoise4D(center, { ...noiseSettings, offset }, noiseTime);
      const turbulence = vec3(
        noise(new THREE.Vector3(17.1, 31.7, 47.3)),
        noise(new THREE.Vector3(59.7, 11.3, 23.9)),
        noise(new THREE.Vector3(37.5, 71.9, 5.7)),
      ).mul(2).sub(1).mul(this.effectiveBehavior('turbulenceNoiseStrength',
        float(this.turbulenceNoiseStrength), state));
      const velocityRate = this.effectiveBehavior('velocityDissipation', this.velocityDissipationNode, state);
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
        const radius = max(this.cellSizeNode.mul(1.5), grid.getMaxParticleRadiusNode());
        grid.forEachParticleInRadius(center, radius, (particle, distanceSq) => {
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
    const densityNext = this.densityNext;
    const colorNext = this.colorNext;
    if (this.advectionMethod === AdvectionMethod.MacCormack) {
      this.predictAdvection(densityCurrent, this.densityAdvected, context, renderer);
      this.predictAdvection(colorCurrent, this.colorAdvected, context, renderer);
    }
    const targets = this.advectionMethod === AdvectionMethod.MacCormack ? [false, true] : [null];
    const sources = this.sourceNodes.get(densityCurrent) ?? targets.map(writeColor => this.computeCells(index => {
      const coordinate = this.cellCoordinate(index);
      const center = this.cellCenter(coordinate);
      let previousDensity = this.advectField(densityCurrent, this.densityAdvected, center, dt, index);
      let previousColor = this.advectField(colorCurrent, this.colorAdvected, center, dt, index);
      if (this.advectionMethod === AdvectionMethod.MacCormack) {
        [previousDensity, previousColor] = this.limitSpecificFields(
          previousDensity, previousColor, densityCurrent, colorCurrent,
          center.sub(this.sampleVelocity(center).mul(dt)),
        );
      }
      const diffusion = clamp(this.scalarDiffusionNode.mul(dt), 0, 1);
      const mixedDensity = mix(previousDensity, this.neighborAverage(densityCurrent, coordinate), diffusion);
      const mixedColor = mix(previousColor, this.neighborAverage(colorCurrent, coordinate), diffusion);
      const gridCoordinate = vec3(coordinate);
      const edgeDistances = (['x', 'y', 'z'] as const).flatMap((axis) => [
        this.closedMinNode[axis].greaterThan(0).select(float(this.resolution), gridCoordinate[axis]),
        this.closedMaxNode[axis].greaterThan(0).select(float(this.resolution),
          float(this.resolution - 1).sub(gridCoordinate[axis])),
      ]);
      const edgeDistance = edgeDistances.reduce((distance, value) => min(distance, value));
      // An absorbing edge layer with a decay rate, not a per-frame multiplier.
      const boundaryRetention = pow(clamp(edgeDistance.div(2), 0, 1), dt.mul(60));
      // Evaluate coefficients from the transported/mixed state before any decay is applied.
      const state = this.behaviorState(mixedDensity, [
        'densityDissipation', 'temperatureDissipation', 'colorDissipation',
      ]);
      const densityRate = this.effectiveBehavior('densityDissipation', this.densityDissipationNode, state);
      const temperatureRate = this.effectiveBehavior('temperatureDissipation', this.temperatureDissipationNode, state);
      const colorRate = this.effectiveBehavior('colorDissipation', this.colorDissipationNode, state);
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
      if (writeColor !== false) colorNext.element(index).assign(this.isSolid(index).select(vec4(0), vec4(color, 0)));
      if (writeColor !== true) densityNext.element(index).assign(
        this.isSolid(index).select(vec4(0), vec4(density, temperature, 0, 0)),
      );
    }));
    this.sourceNodes.set(densityCurrent, sources);
    this.benchmarks.span('scalarAdvectionDiffusionDecay', () => sources.forEach(node => renderer.compute(node)));

    const scalarSources = this.scalarSourceNodes.get(densityNext) ?? this.computeCells(index => {
      If(this.volumeGrid.sourceActive(index), () => {
        const center = this.cellCenter(this.cellCoordinate(index));
        const sourceDensity = float(0).toVar('gasSourceDensity');
        const sourceTemperature = float(0).toVar('gasSourceTemperature');
        const sourceColor = vec3(0).toVar('gasSourceColor');
        const radius = max(this.cellSizeNode.mul(1.5), grid.getMaxParticleRadiusNode());
        grid.forEachParticleInRadius(center, radius, (particle, distanceSq) => {
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
      textureStore(this.densityTexture, vec3(coordinate),
        this.outputParameters(index, density, outputDensity.element(index).y)).toWriteOnly();
      textureStore(
        this.colorTexture, vec3(coordinate), vec4(normalized, density.greaterThan(0).select(1, 0)),
      ).toWriteOnly();
    });
    this.outputNodes.set(outputDensity, output);
    this.benchmarks.span('volumeFieldUpdate', () => renderer.compute(output));
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
        const radius = max(this.cellSizeNode.mul(1.5), grid.getMaxParticleRadiusNode());
        grid.forEachParticleInRadius(center, radius, (particle) => {
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
      textureStore(this.densityTexture, vec3(coordinate),
        this.outputParameters(index, totalDensity, totalTemperature, this.transientEffects.length
          ? vec3(this.visualDensity.element(index).zw, this.visualColor.element(index).w) : undefined)).toWriteOnly();
      textureStore(this.colorTexture, vec3(coordinate), vec4(
        this.outputColor(totalColor, totalDensity),
        totalDensity.greaterThan(0).select(1, 0),
      )).toWriteOnly();
    });
    this.visualOutputNodes.set(density, output);
    this.benchmarks.span('volumeFieldUpdate', () => renderer.compute(output));
    this.density.version += 1;
    this.colorField.version += 1;
  }

  protected override onParticleStateReset(): void {
    this.requiredBrickCapacity = 0;
    this.onGridResolutionChanged();
  }

  protected override onBoundsChanged(previous: THREE.Box3): void {
    this.pressureProjection?.invalidate();
    this.pendingPreviousBounds ??= previous;
    this.density.bounds.copy(this.bounds);
    this.colorField.bounds.copy(this.bounds);
    this.density.version += 1;
    this.colorField.version += 1;
  }

  protected override onGridResolutionChanged(): void {
    this.poolAllocation?.cancelPending(); this.poolAllocation = undefined;
    this.volumeGrid?.dispose();
    this.volumeGrid = new SparseVolumeGrid({
      ...this.spatialGridOptions,
      brickSubdivisions: this.spatialGrid!.brickSubdivisions,
      cellSubdivisions: this.spatialGrid!.cellSubdivisions,
    }, Math.min(this.initialBrickCapacity, this.maxActiveBricks));
    this.resizeGridFields(this.volumeGrid.cellCount);
    this.clearNewNodes = [];
    this.clearTexturesNode = undefined;
    this.disposeGasFields();
    this.allocateGasFields();
    this.density.texture = this.densityTexture;
    this.density.resolution.setScalar(this.resolution);
    this.density.version += 1;
    this.colorField.texture = this.colorTexture;
    this.colorField.resolution.setScalar(this.resolution);
    this.colorField.version += 1;
    this.pendingPreviousBounds = undefined;
    this.resetGasNodes();
  }

  private resetGasNodes(): void {
    this.gpuCacheKey = '';
    this.effectNodes = new Map();
    this.visualStateNodes = new WeakMap();
    this.occupiedGasBounds.makeEmpty();
    this.remapNodes = new WeakMap();
    this.remapVelocityNode = undefined;
    this.velocityNodes = new WeakMap();
    this.velocitySourceNode = undefined;
    this.sourceNodes = new WeakMap();
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

  protected override ensureGridResolution(renderer: ParticleSpatialGridRenderer, grid: ParticleSpatialGrid): void {
    const key = [grid.brickSubdivisions, grid.cellSubdivisions].join('|');
    const previousResolution = this.resolution;
    super.ensureGridResolution(renderer, grid);
    if (key !== this.sparseStructureKey && previousResolution === this.resolution) {
      this.onGridResolutionChanged();
    }
    this.sparseStructureKey = key;
  }

  private get allocatedBytes(): number {
    return this.fieldAttributes.reduce((sum, attribute) => sum + attribute.array.byteLength, 0)
      + this.volumeGrid.allocatedBytes + (this.pressureProjection?.allocatedBytes ?? 0)
      + 2 * this.resolution ** 3 * 4 * 2;
  }

  private get fieldAttributes(): StorageBufferAttribute[] {
    return [this.velocityCurrentAttribute, this.velocityNextAttribute, this.pressureCurrentAttribute,
      this.pressureNextAttribute, this.divergenceAttribute, this.solidAttribute, this.boundaryAttribute,
      this.densityAttributeA, this.densityAttributeB, this.colorAttributeA, this.colorAttributeB,
      this.visualAttribute, this.maximaAttribute, this.curlAttribute, ...this.advectionAttributes];
  }

  private ensurePoolAllocation(renderer: ParticleSpatialGridRenderer, context: GPUParticleUpdateContext,
    grid: ParticleSpatialGrid): void {
    if (this.poolAllocation) return;
    const backend = renderer.backend as { device: { limits: { maxStorageBufferBindingSize: number };
      queue: { onSubmittedWorkDone(): Promise<void> } } };
    const bytesPerBrick = Math.max(this.volumeGrid.cellsPerBrick * 32, (this.volumeGrid.brickSide + 1) ** 3 * 16);
    const deviceMaximum = Math.floor((backend.device.limits.maxStorageBufferBindingSize - 32) / bytesPerBrick);
    const maximum = Math.min(this.volumeGrid.brickCount, this.maxActiveBricks, deviceMaximum);
    if (maximum < this.volumeGrid.capacity) throw new Error('Initial gas pool exceeds this device storage limit.');
    this.poolAllocation = new StagedGPUAllocation<GasPool>({ context: this, attributes: this.fieldAttributes,
      grid: this.volumeGrid, projection: this.getPressureProjection() }, this.volumeGrid.capacity, {
      maximumCapacity: maximum,
      create: capacity => {
        const volume = new SparseVolumeGrid(this.spatialGridOptions!, capacity);
        volume.bounds.copy(this.bounds);
        const target = this.forkGridResources(volume.cellCount);
        Object.defineProperty(target, 'occupiedGasBounds', { value: new THREE.Box3() });
        target.maximaMinimum = this.maximaMinimum.clone();
        target.volumeGrid = volume;
        target.resolution = this.resolution;
        target.advectionAttributes = [];
        target.pressureProjection = undefined;
        target.allocateGasFields();
        // Export textures remain stable. Replacement preparation must never write the live textures.
        target.densityTexture.dispose(); target.colorTexture.dispose();
        target.densityTexture = this.densityTexture; target.colorTexture = this.colorTexture;
        target.clearNewNodes = []; target.clearTexturesNode = undefined;
        target.resetGasNodes();
        target.preparingPool = true;
        if (this.advectionMethod === AdvectionMethod.MacCormack) target.ensureAdvectionFields();
        return { context: target, grid: volume, attributes: target.fieldAttributes };
      },
      prepare: async pool => {
        const target = pool.context;
        const compiler = renderer as ParticleSpatialGridRenderer & {
          compileComputeAsync(nodes: ComputeNode[]): Promise<void>;
        };
        for (const attribute of pool.attributes) {
          initializeStorageAttribute(renderer, attribute);
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        const collect = (build: () => void) => {
          const nodes: ComputeNode[] = [], original = renderer.compute;
          renderer.compute = node => { nodes.push(...(Array.isArray(node) ? node : [node])); };
          try { build(); } finally { renderer.compute = original; }
          return nodes;
        };
        await compiler.compileComputeAsync(collect(() => {
          target.volumeGrid.updateDispatch(renderer);
          target.clearNewBricks(renderer);
          target.computeSolidField(context, renderer);
        }));
        // Compile both scalar ping-pong identities sequentially; no solver dispatch is submitted.
        for (let phase = 0; phase < 2; phase++) {
          await compiler.compileComputeAsync(collect(() => target.getPressureProjection().forPreparation(
            () => target.computeTransport(context, renderer, grid))));
        }
        pool.projection = target.getPressureProjection();
        target.preparingPool = false;
      },
      migrate: (current, replacement) => {
        current.attributes = this.fieldAttributes;
        current.projection = this.pressureProjection;
        const next = replacement.context, count = this.cellCount - 1;
        this.volumeGrid.migrateTo(renderer, replacement.grid);
        const old = current.attributes, fresh = replacement.attributes;
        const copies = old.flatMap((attribute, index) => {
          if (index >= fresh.length) return [];
          const target = fresh[index];
          // Packed boundary/visual planes change stride when the pool grows.
          if (attribute === this.boundaryAttribute || attribute === this.visualAttribute) return [
            { source: attribute, target, byteLength: count * 16 },
            { source: attribute, target, sourceOffset: this.cellCount * 16,
              targetOffset: next.cellCount * 16, byteLength: count * 16 },
          ];
          return [{ source: attribute, target,
            byteLength: Math.min(attribute.array.byteLength, target.array.byteLength) }];
        });
        copyStorageAttributes(renderer, copies);
        this.pressureProjection?.migrateTo(renderer, replacement.projection!);
        replacement.projection!.retainPressure();
        if ((this.densityCurrent as unknown as { value: StorageBufferAttribute }).value === this.densityAttributeB) {
          [next.densityCurrent, next.densityNext] = [next.densityNext, next.densityCurrent];
          [next.colorCurrent, next.colorNext] = [next.colorNext, next.colorCurrent];
        }
        this.peakAllocatedBytes = Math.max(this.peakAllocatedBytes,
          this.allocatedBytes + replacement.attributes.reduce((sum, a) => sum + a.array.byteLength, 0)
            + replacement.grid.allocatedBytes + (replacement.projection?.allocatedBytes ?? 0));
      },
      swap: pool => {
        const target = pool.context;
        this.adoptGridResources(target);
        for (const key of ['volumeGrid', 'densityAttributeA', 'densityAttributeB', 'colorAttributeA',
          'colorAttributeB', 'visualAttribute', 'densityCurrent', 'densityNext', 'colorCurrent', 'colorNext',
          'visualDensity', 'visualColor', 'maximaAttribute', 'maxima', 'curlAttribute', 'curl',
          'advectionAttributes', 'velocityAdvected', 'densityAdvected', 'colorAdvected', 'pressureProjection',
          'clearNewNodes', 'clearTexturesNode', 'gpuCacheKey', 'velocityNodes', 'velocitySourceNode',
          'sourceNodes', 'scalarSourceNodes', 'solidClearNodes', 'outputNodes', 'visualCacheKey',
          'visualSourceNode', 'visualOutputNodes', 'maximaNodes', 'maximaResetNode', 'curlNode',
          'confinementNodes', 'advectionNodes', 'remapNodes', 'remapVelocityNode',
          'effectNodes', 'visualStateNodes'] as const) {
          (this as unknown as Record<string, unknown>)[key] = target[key];
        }
        this.growthEvents++;
      },
      dispose: pool => {
        pool.attributes.forEach(attribute => attribute.dispose());
        pool.projection?.dispose(); pool.grid.dispose(renderer);
      },
      fence: () => backend.device.queue.onSubmittedWorkDone(),
    });
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
    this.previousCellSize.value = previous.getSize(new THREE.Vector3()).x / this.resolution;
    const remap = this.getRemapNode(this.densityCurrent, this.colorCurrent, this.densityNext, this.colorNext);
    this.benchmarks.span('boundsRemap', () => renderer.compute(remap));
    [this.densityCurrent, this.densityNext] = [this.densityNext, this.densityCurrent];
    [this.colorCurrent, this.colorNext] = [this.colorNext, this.colorCurrent];
    const copyVelocity = this.remapVelocityNode ?? this.computeCells(index => {
      this.velocityCurrent.element(index).assign(this.velocityNext.element(index));
    });
    this.remapVelocityNode = copyVelocity;
    renderer.compute(copyVelocity);
  }

  private getRemapNode(
    oldDensity: Vec4Storage, oldColor: Vec4Storage, newDensity: Vec4Storage, newColor: Vec4Storage,
  ): ComputeNode {
    const node = this.remapNodes.get(oldDensity) ?? this.computeCells(index => {
      const center = this.cellCenter(this.cellCoordinate(index));
      const oldCoordinate = center.sub(this.previousMinimum).div(this.previousCellSize).floor();
      const inside = oldCoordinate.greaterThanEqual(vec3(0)).all()
        .and(oldCoordinate.lessThan(vec3(this.resolution)).all());
      const clamped = this.volumeGrid.index(ivec3(clamp(oldCoordinate, vec3(0), vec3(this.resolution - 1))),
        this.volumeGrid.previousPages);
      newDensity.element(index).assign(inside.select(oldDensity.element(clamped), vec4(0)));
      newColor.element(index).assign(inside.select(oldColor.element(clamped), vec4(0)));
      this.velocityNext.element(index).assign(inside.select(this.velocityCurrent.element(clamped), vec4(0)));
    });
    this.remapNodes.set(oldDensity, node);
    return node;
  }

  public override cleanup(): void {
    this.poolAllocation?.cancelPending(); this.poolAllocation = undefined;
    super.cleanup();
    this.disposeGasFields();
    this.volumeGrid.dispose();
  }

  /** Small asynchronous allocation readback, without transferring field values. */
  public async readGridDiagnostics(renderer: ParticleSpatialGridRenderer): Promise<{
    activeBricks: number; overflowedBricks: number; capacity: number; logicalBricks: number;
  }> {
    const values = new Uint32Array(await renderer.getArrayBufferAsync(this.volumeGrid.diagnosticsAttribute));
    return { activeBricks: values[0], overflowedBricks: values[1],
      capacity: this.volumeGrid.capacity, logicalBricks: this.volumeGrid.brickCount };
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
      const n = this.resolution;
      const coordinate = ivec3(int(instanceIndex.mod(n)), int(instanceIndex.div(n).mod(n)),
        int(instanceIndex.div(n * n)));
      textureStore(this.densityTexture, coordinate, vec4(0)).toWriteOnly();
      textureStore(this.colorTexture, coordinate, vec4(0)).toWriteOnly();
    })().compute(this.resolution ** 3);
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
    const stride = this.cellCount;
    this.visualDensity = visual;
    this.visualColor = { element: index => visual.element(typeof index === 'number'
      ? index + stride : uint(index as Node<'uint'>).add(stride)) };
    this.maxima = storage(this.maximaAttribute, 'uint', 12).toAtomic() as AtomicUintStorage;
    this.densityTexture = this.makeTexture();
    this.colorTexture = this.makeTexture();
  }

  private disposeGasFields(): void {
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

  private getPressureProjection(): FluidPressureProjection {
    this.pressureProjection ??= new FluidPressureProjection(
      this.resolution, this.cellSizeNode, this.maxVelocityNode, this.solid, this.pressureCurrent, this.divergence,
      this.closedMinNode, this.closedMaxNode, this.volumeGrid, undefined, undefined, undefined,
      this.faceOpenness, this.solidVelocity, () => ({ ...this.pressureControls,
        multigrid: this.pressureSolver === 'Multigrid' }),
    );
    return this.pressureProjection;
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
    this.advectionAttributes = Array.from({ length: 3 }, () => (
      new StorageBufferAttribute(new Float32Array(this.cellCount * 4), 4)
    ));
    [this.velocityAdvected, this.densityAdvected, this.colorAdvected] = this.advectionAttributes
      .map((attribute) => storage(attribute, 'vec4', this.cellCount) as Vec4Storage);
  }

  private makeTexture(): Storage3DTexture {
    const texture = new Storage3DTexture(this.resolution, this.resolution, this.resolution);
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

  /** Representative local decay for the short predictor; actual occupied support protects persistent gas. */
  private sampledBehaviorRate(name: BehaviorCoefficient): number {
    let rate = Math.max(0, this[name]);
    for (const suffix of ['Temperature', 'Density'] as const) {
      const value = this[`${name}By${suffix}`];
      if (value == null) continue;
      rate *= averageDynamicNumber(t => Math.max(0, evaluateByParameterNumber(value, t)), 16, 1);
    }
    return rate;
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
    if (!(this.vorticityNode.value > 0)) return;
    const sample = (field: Vec4Storage, coordinate: Node<'ivec3'>, x: number, y: number, z: number) => (
      field.element(this.cellIndex(ivec3(clamp(
        vec3(coordinate.add(ivec3(x, y, z))), vec3(0), vec3(this.resolution - 1),
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
      const strength = this.effectiveBehavior('vorticityStrength', this.vorticityNode, state);
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
          const index = this.cellIndex(ivec3(clamp(coordinate, vec3(0), vec3(this.resolution - 1))));
          const value = source.element(index);
          lower.assign(min(lower, value));
          upper.assign(max(upper, value));
          valid.assign(valid.and(coordinate.greaterThanEqual(vec3(0)).all())
            .and(coordinate.lessThan(vec3(this.resolution)).all()).and(this.isSolid(index).not()));
          const reverseCoordinate = reversePosition.sub(this.boundsMinNode).div(this.cellSizeNode)
            .sub(0.5).floor().add(vec3(x, y, z));
          const reverseIndex = this.cellIndex(ivec3(clamp(reverseCoordinate, vec3(0), vec3(this.resolution - 1))));
          valid.assign(valid.and(reverseCoordinate.greaterThanEqual(vec3(0)).all())
            .and(reverseCoordinate.lessThan(vec3(this.resolution)).all()).and(this.isSolid(reverseIndex).not()));
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
          const index = this.cellIndex(ivec3(clamp(base.add(vec3(x, y, z)), vec3(0), vec3(this.resolution - 1))));
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

  protected override async readAutomaticPadding(
    renderer: ParticleSpatialGridRenderer,
    _grid: ParticleSpatialGrid,
    maxParticleVelocity: THREE.Vector3,
  ): Promise<THREE.Vector3> {
    // Predict only until the next bounds observations, not over the entire smoke lifetime.
    // Persistent gas support is measured separately, so old smoke is retained without forecasting it again.
    const horizon = Math.max(0, this.velocityPaddingLookahead);
    const minimum = this.maximaMinimum.clone(), cellSize = this.maximaCellSize;
    const data = await renderer.getArrayBufferAsync(this.maximaAttribute);
    const values = new Float32Array(data), coordinates = new Uint32Array(data);
    this.occupiedGasBounds.makeEmpty();
    if (coordinates[2] !== 0xffffffff && coordinates[5] > 0) {
      this.occupiedGasBounds.min.set(coordinates[2], coordinates[3], coordinates[4])
        .multiplyScalar(cellSize).add(minimum);
      this.occupiedGasBounds.max.set(coordinates[5], coordinates[6], coordinates[7])
        .multiplyScalar(cellSize).add(minimum);
    }
    const maximumDensity = Math.max(0, values[0] ?? 0);
    const maximumTemperature = Math.max(0, values[1] ?? 0);
    const damping = this.sampledBehaviorRate('velocityDissipation');
    const motionTime = damping > 1e-6 ? -Math.expm1(-damping * horizon) / damping : horizon;
    // Integrate decaying gas velocity instead of extending its instantaneous peak unchanged.
    // Emitting particles keep a ballistic guard: gas damping need not apply to their own modules.
    const motionPadding = maxParticleVelocity.clone().multiplyScalar(horizon).max(new THREE.Vector3(
      Math.max(0, values[9] ?? 0), Math.max(0, values[10] ?? 0), Math.max(0, values[11] ?? 0),
    ).multiplyScalar(motionTime));
    if (maximumDensity <= 0) return motionPadding;

    const estimate = this.estimateBuoyantTravel(maximumDensity, maximumTemperature, horizon);
    const diffusionDistance = cellSize * Math.sqrt(Math.max(0, this.scalarDiffusion) * horizon);
    // Diffusion is isotropic, but buoyancy contributes only on the vertical axis.
    return motionPadding.max(new THREE.Vector3(
      diffusionDistance, diffusionDistance + estimate.distance, diffusionDistance,
    ));
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

  private estimateBuoyantTravel(
    maximumDensity: number,
    maximumTemperature: number,
    horizon = 1,
  ): { distance: number; frames: number } {
    const threshold = this.densityCutoff;
    const dt = 1 / 60;
    const densityRetention = Math.exp(-this.sampledBehaviorRate('densityDissipation') * dt);
    const temperatureRetention = Math.exp(-this.sampledBehaviorRate('temperatureDissipation') * dt);
    const velocityRetention = Math.exp(-this.sampledBehaviorRate('velocityDissipation') * dt);
    let density = maximumDensity;
    let temperatureMass = maximumTemperature * maximumDensity;
    let velocity = 0;
    let distance = 0;
    let frames = 0;

    while (density > threshold && frames < Math.min(600, Math.ceil(horizon / dt))) {
      const temperature = temperatureMass / Math.max(density, Number.EPSILON);
      const acceleration = Math.max(0, temperature * this.buoyancy - density * this.weight);
      velocity = Math.min(this.maxVelocity, velocity * velocityRetention + acceleration * dt);
      distance += velocity * dt;
      density *= densityRetention;
      temperatureMass *= densityRetention * temperatureRetention;
      frames += 1;
    }
    return { distance, frames };
  }

  private neighborAverage(field: Vec4Storage, coordinate: Node<'ivec3'>): Node<'vec4'> {
    const sample = (x: number, y: number, z: number) => field.element(this.cellIndex(ivec3(clamp(
      vec3(coordinate).add(vec3(x, y, z)), vec3(0), vec3(this.resolution - 1),
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
      ivec3(clamp(vec3(coordinate).add(vec3(x, y, z)), vec3(0), vec3(this.resolution - 1))),
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
