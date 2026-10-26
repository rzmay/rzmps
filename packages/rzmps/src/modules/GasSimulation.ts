import * as THREE from 'three';
import { Storage3DTexture, StorageBufferAttribute, type ComputeNode, type Node } from 'three/webgpu';
import {
  Fn, If, atomicMax, atomicStore, clamp, float, floatBitsToUint, floor, instanceIndex, int, ivec3,
  max, min, mix, pow, storage, textureStore, uint, uniform, vec3, vec4,
} from 'three/tsl';
import type { GPUParticleLike, GPUParticleRenderBufferState, GPUParticleUpdateContext } from '../gpu/Particle';
import ParticleSpatialGrid, { type ParticleSpatialGridRenderer } from '../gpu/ParticleSpatialGrid';
import { generateGPUParticleNoise4D } from '../helpers/noise';
import type { VolumeField } from '../interfaces/VolumeField';
import type { ValueByParameter } from '../types/ValueByParameter';
import type { DynamicValue } from '../types/DynamicValue';
import FluidSimulation, { type FluidSimulationOptions } from './FluidSimulation';
import { AdvectionMethod } from '../enums/AdvectionMethod';

type Vec4Storage = { element(index: Node | number): Node<'vec4'> };
type FloatStorage = { element(index: Node | number): Node<'float'> };
type AtomicUintStorage = { element(index: Node | number): Node<'uint'> };
type FloatUniform = Node<'float'> & { value: number };

export interface GasSimulationOptions extends FluidSimulationOptions {
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
  temperatureColor: ValueByParameter<THREE.Color> | undefined;
  temperatureRange: [number, number];
  /** Curl-confinement strength; restores small-scale rotation lost to advection. */
  vorticityStrength: number;
  /** Independent animated noise acceleration in simulation units per second squared. */
  turbulenceStrength: number;
  noiseFrequency: number;
  noiseSpeed: number;
  noiseOctaves: number;
}

class GasSimulation extends FluidSimulation {
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
  temperatureColor?: ValueByParameter<THREE.Color>;
  temperatureRange: [number, number];
  vorticityStrength: number;
  turbulenceStrength: number;
  noiseFrequency: number;
  noiseSpeed: number;
  noiseOctaves: number;

  private densityAttributeA!: StorageBufferAttribute;
  private densityAttributeB!: StorageBufferAttribute;
  private colorAttributeA!: StorageBufferAttribute;
  private colorAttributeB!: StorageBufferAttribute;
  private visualDensityAttribute!: StorageBufferAttribute;
  private visualColorAttribute!: StorageBufferAttribute;
  private densityCurrent!: Vec4Storage;
  private densityNext!: Vec4Storage;
  private colorCurrent!: Vec4Storage;
  private colorNext!: Vec4Storage;
  private visualDensity!: Vec4Storage;
  private visualColor!: Vec4Storage;
  private maximaAttribute!: StorageBufferAttribute;
  private maxima!: AtomicUintStorage;
  private densityTexture!: Storage3DTexture;
  private colorTexture!: Storage3DTexture;
  private gpuCacheKey = '';
  private velocityNodes = new WeakMap<object, ComputeNode>();
  private velocitySourceNode?: ComputeNode;
  private sourceNodes = new WeakMap<object, ComputeNode>();
  private densitySourceNodes = new WeakMap<object, ComputeNode>();
  private colorSourceNodes = new WeakMap<object, ComputeNode>();
  private solidClearNodes = new WeakMap<object, ComputeNode>();
  private outputNodes = new WeakMap<object, ComputeNode>();
  private pendingPreviousBounds?: THREE.Box3;
  private visualCacheKey = '';
  private visualDensityNode?: ComputeNode;
  private visualColorNode?: ComputeNode;
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
  private confinementNode?: ComputeNode;
  private readonly vorticityNode = uniform(0) as FloatUniform;
  private advectionAttributes: StorageBufferAttribute[] = [];
  private velocityAdvected!: Vec4Storage;
  private densityAdvected!: Vec4Storage;
  private colorAdvected!: Vec4Storage;
  private advectionNodes = new WeakMap<object, ComputeNode>();
  private pressureProjection?: GasPressureProjection;

  constructor(options: Partial<GasSimulationOptions> = {}) {
    super({
      ...options,
      automaticPadding: options.automaticPadding ?? true,
    });
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
    this.temperatureColor = options.temperatureColor;
    this.temperatureRange = [...(options.temperatureRange ?? [0, 1])];
    this.vorticityStrength = Math.max(0, options.vorticityStrength ?? 0);
    this.turbulenceStrength = Math.max(0, options.turbulenceStrength ?? 0);
    this.noiseFrequency = Math.max(0, options.noiseFrequency ?? 0.75);
    this.noiseSpeed = options.noiseSpeed ?? 0.2;
    this.noiseOctaves = Math.max(1, Math.floor(options.noiseOctaves ?? 2));

    this.allocateGasFields();
    this.density = {
      texture: this.densityTexture,
      bounds: this.bounds.clone(),
      resolution: new THREE.Vector3(this.resolution, this.resolution, this.resolution),
      channels: 4,
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

  public override computeGPU(
    context: GPUParticleUpdateContext,
    renderer: ParticleSpatialGridRenderer,
    grid?: ParticleSpatialGrid,
  ): void {
    if (!grid) throw new Error('GasSimulation requires a GPU spatial grid.');
    if (!Object.values(AdvectionMethod).includes(this.advectionMethod as AdvectionMethod)) {
      throw new RangeError('Unknown gas advectionMethod.');
    }
    super.computeGPU(context, renderer, grid);
    this.ensureGridResolution(renderer, grid);
    if (this.advectionMethod === AdvectionMethod.MacCormack) this.ensureAdvectionFields();
    this.syncSimulationUniforms();
    this.refreshBounds(grid, renderer);
    this.remapFields(renderer);
    this.computeSolidField(context, renderer);
    this.getPressureProjection().initialize(renderer, this.velocityCurrent);
    const dt = context.deltaTimeNode;
    const tagMask = context.system.getGPUFilterTagMask(this.tags);

    const cacheKey = [grid.resourceVersion, context.buffers.version, tagMask,
      this.buoyancy, this.weight, this.velocitySourceStrength, this.sourceStrength,
      this.sourceTemperature, Boolean(this.temperatureOverLifetime), this.temperatureRange.join(','),
      Boolean(this.temperatureColor), this.turbulenceStrength, this.noiseFrequency,
      this.noiseSpeed, this.noiseOctaves, this.advectionMethod].join('|');
    if (cacheKey !== this.gpuCacheKey) {
      this.gpuCacheKey = cacheKey;
      this.velocityNodes = new WeakMap();
      this.velocitySourceNode = undefined;
      this.sourceNodes = new WeakMap();
      this.densitySourceNodes = new WeakMap();
      this.colorSourceNodes = new WeakMap();
      this.solidClearNodes = new WeakMap();
      this.outputNodes = new WeakMap();
    }

    if (this.advectionMethod === AdvectionMethod.MacCormack) {
      this.predictAdvection(this.velocityCurrent, this.velocityAdvected, context, renderer);
    }
    const velocity = this.velocityNodes.get(this.densityCurrent) ?? Fn(() => {
      const coordinate = this.cellCoordinate(instanceIndex);
      const center = this.cellCenter(coordinate);
      const previous = this.advectField(this.velocityCurrent, this.velocityAdvected, center, dt).xyz;
      const density = this.densityCurrent.element(instanceIndex);
      const temperature = density.y.div(max(density.x, float(1e-6)));
      const lift = temperature.mul(this.buoyancy).sub(density.x.mul(this.weight));
      const noiseTime = context.elapsedTimeNode.mul(this.noiseSpeed);
      const noiseSettings = {
        octaves: this.noiseOctaves,
        frequency: this.noiseFrequency,
        lacunarity: 2,
        persistence: 0.5,
        time: 0,
        offset: new THREE.Vector3(),
      };
      const turbulence = vec3(
        generateGPUParticleNoise4D(center, { ...noiseSettings, offset: new THREE.Vector3(17.1, 31.7, 47.3) }, noiseTime),
        generateGPUParticleNoise4D(center, { ...noiseSettings, offset: new THREE.Vector3(59.7, 11.3, 23.9) }, noiseTime),
        generateGPUParticleNoise4D(center, { ...noiseSettings, offset: new THREE.Vector3(37.5, 71.9, 5.7) }, noiseTime),
      ).mul(2).sub(1).mul(this.turbulenceStrength);
      const velocityRetention = pow(float(Math.E), dt.mul(this.velocityDissipationNode).mul(-1));
      const advected = vec3(previous)
        .mul(velocityRetention)
        .add(this.forceNode.mul(dt))
        .add(vec3(0, 1, 0).mul(lift.mul(dt)))
        .add(turbulence.mul(dt));
      this.velocityNext.element(instanceIndex).assign(
        this.isSolid().select(vec4(0), vec4(this.clampVelocity(advected), 0)),
      );
    })().compute(this.cellCount);
    this.velocityNodes.set(this.densityCurrent, velocity);
    renderer.compute(velocity);

    const velocitySources = this.velocitySourceNode ?? Fn(() => {
      const coordinate = this.cellCoordinate(instanceIndex);
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
      const previous = vec3(this.velocityNext.element(instanceIndex).xyz);
      const updated = mix(previous, momentum.div(max(sourceMass, float(1e-6))), blend);
      this.velocityNext.element(instanceIndex).assign(vec4(this.clampVelocity(updated), 0));
    })().compute(this.cellCount);
    this.velocitySourceNode = velocitySources;
    renderer.compute(velocitySources);

    this.applyVorticity(context, renderer);
    this.solveProjection(renderer, this.velocityNext, this.velocityCurrent);

    const densityCurrent = this.densityCurrent;
    const colorCurrent = this.colorCurrent;
    const densityNext = this.densityNext;
    const colorNext = this.colorNext;
    if (this.advectionMethod === AdvectionMethod.MacCormack) {
      this.predictAdvection(densityCurrent, this.densityAdvected, context, renderer);
      this.predictAdvection(colorCurrent, this.colorAdvected, context, renderer);
    }
    const sources = this.sourceNodes.get(densityCurrent) ?? Fn(() => {
      const coordinate = this.cellCoordinate(instanceIndex);
      const center = this.cellCenter(coordinate);
      let previousDensity = this.advectField(densityCurrent, this.densityAdvected, center, dt);
      let previousColor = this.advectField(colorCurrent, this.colorAdvected, center, dt);
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
      const densityRetention = pow(float(Math.E), dt.mul(this.densityDissipationNode).mul(-1));
      const temperatureRetention = pow(float(Math.E), dt.mul(this.temperatureDissipationNode).mul(-1));
      const colorRetention = pow(float(Math.E), dt.mul(this.colorDissipationNode).mul(-1));
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
      densityNext.element(instanceIndex).assign(
        this.isSolid().select(vec4(0), vec4(density, temperature, 0, 0)),
      );
      colorNext.element(instanceIndex).assign(
        this.isSolid().select(vec4(0), vec4(color, 0)),
      );
    })().compute(this.cellCount);
    this.sourceNodes.set(densityCurrent, sources);
    renderer.compute(sources);

    const densitySources = this.densitySourceNodes.get(densityNext) ?? Fn(() => {
      const center = this.cellCenter(this.cellCoordinate(instanceIndex));
      const sourceDensity = float(0).toVar('gasSourceDensity');
      const sourceTemperature = float(0).toVar('gasSourceTemperature');
      const radius = max(this.cellSizeNode.mul(1.5), grid.getMaxParticleRadiusNode());
      grid.forEachParticleInRadius(center, radius, (particle, distanceSq) => {
        const particleRadius = this.splatRadius(particle.scale);
        const weight = max(float(0), float(1).sub(distanceSq.sqrt().div(particleRadius)));
        const contribution = max(particle.mass, float(0)).mul(particle.alpha)
          .mul(weight).mul(this.sourceStrength).mul(this.sourceStep(particle, dt));
        sourceDensity.addAssign(contribution);
        sourceTemperature.addAssign(contribution.mul(this.particleTemperature(particle.time, particle.index)));
      }, { tagMask });
      const previous = densityNext.element(instanceIndex);
      densityNext.element(instanceIndex).assign(vec4(
        previous.x.add(sourceDensity), previous.y.add(sourceTemperature), 0, 0,
      ));
    })().compute(this.cellCount);
    this.densitySourceNodes.set(densityNext, densitySources);
    renderer.compute(densitySources);

    const colorSources = this.colorSourceNodes.get(colorNext) ?? Fn(() => {
      const center = this.cellCenter(this.cellCoordinate(instanceIndex));
      const sourceColor = vec3(0).toVar('gasSourceColor');
      const radius = max(this.cellSizeNode.mul(1.5), grid.getMaxParticleRadiusNode());
      grid.forEachParticleInRadius(center, radius, (particle, distanceSq) => {
        const particleRadius = this.splatRadius(particle.scale);
        const weight = max(float(0), float(1).sub(distanceSq.sqrt().div(particleRadius)));
        const contribution = max(particle.mass, float(0)).mul(particle.alpha).mul(weight)
          .mul(this.sourceStrength).mul(this.sourceStep(particle, dt));
        sourceColor.addAssign(particle.color.mul(contribution));
      }, { tagMask });
      colorNext.element(instanceIndex).assign(vec4(
        colorNext.element(instanceIndex).xyz.add(sourceColor), 0,
      ));
    })().compute(this.cellCount);
    this.colorSourceNodes.set(colorNext, colorSources);
    renderer.compute(colorSources);

    const clearSolid = this.solidClearNodes.get(densityNext) ?? Fn(() => {
      densityNext.element(instanceIndex).assign(
        this.isSolid().select(vec4(0), densityNext.element(instanceIndex)),
      );
      colorNext.element(instanceIndex).assign(
        this.isSolid().select(vec4(0), colorNext.element(instanceIndex)),
      );
    })().compute(this.cellCount);
    this.solidClearNodes.set(densityNext, clearSolid);
    renderer.compute(clearSolid);
    [this.densityCurrent, this.densityNext] = [this.densityNext, this.densityCurrent];
    [this.colorCurrent, this.colorNext] = [this.colorNext, this.colorCurrent];

    const outputDensity = this.densityCurrent;
    const outputColor = this.colorCurrent;
    const output = this.outputNodes.get(outputDensity) ?? Fn(() => {
      const coordinate = this.cellCoordinate(instanceIndex);
      const density = outputDensity.element(instanceIndex).x;
      const normalized = this.outputColor(
        outputColor.element(instanceIndex).xyz,
        density,
        outputDensity.element(instanceIndex).y,
      );
      textureStore(this.densityTexture, vec3(coordinate), vec4(density, 0, 0, 1)).toWriteOnly();
      textureStore(this.colorTexture, vec3(coordinate), vec4(normalized, density.greaterThan(0).select(1, 0))).toWriteOnly();
    })().compute(this.cellCount);
    this.outputNodes.set(outputDensity, output);
    renderer.compute(output);
    this.reduceFieldMaxima(renderer, outputDensity);
    this.density.version += 1;
    this.colorField.version += 1;
  }

  public override renderGPU(
    context: GPUParticleUpdateContext,
    renderBuffers: GPUParticleRenderBufferState,
    renderer: ParticleSpatialGridRenderer,
    grid?: ParticleSpatialGrid,
  ): void {
    if (!grid) return;
    const tagMask = context.system.getGPUFilterTagMask(this.tags);
    const cacheKey = [grid.resourceVersion, context.buffers.version, renderBuffers.version,
      tagMask, this.sourceStrength, this.sourceTemperature, Boolean(this.temperatureOverLifetime),
      this.temperatureRange.join(','),
      Boolean(this.temperatureColor)].join('|');
    if (cacheKey !== this.visualCacheKey) {
      this.visualCacheKey = cacheKey;
      this.visualDensityNode = undefined;
      this.visualColorNode = undefined;
    }

    const densityNode = this.visualDensityNode ?? Fn(() => {
      const center = this.cellCenter(this.cellCoordinate(instanceIndex));
      const total = float(0).toVar('visualGasDensity');
      const temperature = float(0).toVar('visualGasTemperature');
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
      }, { tagMask });
      this.visualDensity.element(instanceIndex).assign(vec4(total, temperature, 0, 0));
    })().compute(this.cellCount);
    this.visualDensityNode = densityNode;
    renderer.compute(densityNode);

    const colorNode = this.visualColorNode ?? Fn(() => {
      const center = this.cellCenter(this.cellCoordinate(instanceIndex));
      const total = vec3(0).toVar('visualGasColor');
      const radius = max(this.cellSizeNode.mul(1.5), grid.getMaxParticleRadiusNode());
      grid.forEachParticleInRadius(center, radius, (particle) => {
        const vectors = renderBuffers.storage.createVectorNodes(particle.index);
        const scalars = renderBuffers.storage.createScalarNodes(particle.index);
        const particleRadius = this.splatRadius(vectors.scale);
        const weight = max(float(0), float(1).sub(vectors.position.distance(center).div(particleRadius)));
        const contribution = max(particle.mass, float(0)).mul(scalars.alpha).mul(weight).mul(this.sourceStrength).mul(context.deltaTimeNode);
        total.addAssign(vectors.color.mul(contribution));
      }, { tagMask });
      this.visualColor.element(instanceIndex).assign(vec4(total, 0));
    })().compute(this.cellCount);
    this.visualColorNode = colorNode;
    renderer.compute(colorNode);

    const density = this.densityCurrent;
    const color = this.colorCurrent;
    const output = this.visualOutputNodes.get(density) ?? Fn(() => {
      const coordinate = this.cellCoordinate(instanceIndex);
      const fluidCell = this.isSolid().not();
      const totalDensity = fluidCell.select(
        density.element(instanceIndex).x.add(this.visualDensity.element(instanceIndex).x),
        float(0),
      );
      const totalColor = fluidCell.select(
        vec3(color.element(instanceIndex).xyz).add(this.visualColor.element(instanceIndex).xyz),
        vec3(0),
      );
      const totalTemperature = fluidCell.select(
        density.element(instanceIndex).y.add(this.visualDensity.element(instanceIndex).y),
        float(0),
      );
      textureStore(this.densityTexture, vec3(coordinate), vec4(totalDensity, 0, 0, 1)).toWriteOnly();
      textureStore(this.colorTexture, vec3(coordinate), vec4(
        this.outputColor(totalColor, totalDensity, totalTemperature),
        totalDensity.greaterThan(0).select(1, 0),
      )).toWriteOnly();
    })().compute(this.cellCount);
    this.visualOutputNodes.set(density, output);
    renderer.compute(output);
    this.density.version += 1;
    this.colorField.version += 1;
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
    this.disposeGasFields();
    this.allocateGasFields();
    this.density.texture = this.densityTexture;
    this.density.resolution.setScalar(this.resolution);
    this.density.version += 1;
    this.colorField.texture = this.colorTexture;
    this.colorField.resolution.setScalar(this.resolution);
    this.colorField.version += 1;
    this.pendingPreviousBounds = undefined;
    this.gpuCacheKey = '';
    this.velocityNodes = new WeakMap();
    this.velocitySourceNode = undefined;
    this.sourceNodes = new WeakMap();
    this.densitySourceNodes = new WeakMap();
    this.colorSourceNodes = new WeakMap();
    this.solidClearNodes = new WeakMap();
    this.outputNodes = new WeakMap();
    this.visualCacheKey = '';
    this.visualDensityNode = undefined;
    this.visualColorNode = undefined;
    this.visualOutputNodes = new WeakMap();
    this.maximaNodes = new WeakMap();
    this.maximaResetNode = undefined;
    this.curlNode = undefined;
    this.confinementNode = undefined;
    this.advectionNodes = new WeakMap();
  }

  private remapFields(renderer: ParticleSpatialGridRenderer): void {
    const previous = this.pendingPreviousBounds;
    if (!previous) return;
    this.pendingPreviousBounds = undefined;
    const oldMin = vec3(previous.min);
    const oldSize = previous.getSize(new THREE.Vector3()).x / this.resolution;
    const oldDensity = this.densityCurrent;
    const oldColor = this.colorCurrent;
    const newDensity = this.densityNext;
    const newColor = this.colorNext;
    const remap = Fn(() => {
      const center = this.cellCenter(this.cellCoordinate(instanceIndex));
      const oldCoordinate = center.sub(oldMin).div(oldSize).floor();
      const inside = oldCoordinate.greaterThanEqual(vec3(0)).all()
        .and(oldCoordinate.lessThan(vec3(this.resolution)).all());
      const clamped = this.cellIndex(ivec3(clamp(oldCoordinate, vec3(0), vec3(this.resolution - 1))));
      newDensity.element(instanceIndex).assign(inside.select(oldDensity.element(clamped), vec4(0)));
      newColor.element(instanceIndex).assign(inside.select(oldColor.element(clamped), vec4(0)));
      this.velocityNext.element(instanceIndex).assign(inside.select(this.velocityCurrent.element(clamped), vec4(0)));
    })().compute(this.cellCount);
    renderer.compute(remap);
    [this.densityCurrent, this.densityNext] = [this.densityNext, this.densityCurrent];
    [this.colorCurrent, this.colorNext] = [this.colorNext, this.colorCurrent];
    const copyVelocity = Fn(() => {
      this.velocityCurrent.element(instanceIndex).assign(this.velocityNext.element(instanceIndex));
    })().compute(this.cellCount);
    renderer.compute(copyVelocity);
  }

  public override cleanup(): void {
    super.cleanup();
    this.disposeGasFields();
  }

  private allocateGasFields(): void {
    this.curlAttribute = new StorageBufferAttribute(new Float32Array(this.cellCount * 4), 4);
    this.curl = storage(this.curlAttribute, 'vec4', this.cellCount) as Vec4Storage;
    this.densityAttributeA = new StorageBufferAttribute(new Float32Array(this.cellCount * 4), 4);
    this.densityAttributeB = new StorageBufferAttribute(new Float32Array(this.cellCount * 4), 4);
    this.colorAttributeA = new StorageBufferAttribute(new Float32Array(this.cellCount * 4), 4);
    this.colorAttributeB = new StorageBufferAttribute(new Float32Array(this.cellCount * 4), 4);
    this.visualDensityAttribute = new StorageBufferAttribute(new Float32Array(this.cellCount * 4), 4);
    this.visualColorAttribute = new StorageBufferAttribute(new Float32Array(this.cellCount * 4), 4);
    this.maximaAttribute = new StorageBufferAttribute(new Uint32Array(2), 1);
    this.densityCurrent = storage(this.densityAttributeA, 'vec4', this.cellCount) as Vec4Storage;
    this.densityNext = storage(this.densityAttributeB, 'vec4', this.cellCount) as Vec4Storage;
    this.colorCurrent = storage(this.colorAttributeA, 'vec4', this.cellCount) as Vec4Storage;
    this.colorNext = storage(this.colorAttributeB, 'vec4', this.cellCount) as Vec4Storage;
    this.visualDensity = storage(this.visualDensityAttribute, 'vec4', this.cellCount) as Vec4Storage;
    this.visualColor = storage(this.visualColorAttribute, 'vec4', this.cellCount) as Vec4Storage;
    this.maxima = storage(this.maximaAttribute, 'uint', 2).toAtomic() as AtomicUintStorage;
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
      this.visualDensityAttribute,
      this.visualColorAttribute,
      this.maximaAttribute,
      this.curlAttribute,
      ...this.advectionAttributes,
    ].forEach((attribute) => attribute?.dispose());
    this.advectionAttributes = [];
  }

  private getPressureProjection(): GasPressureProjection {
    this.pressureProjection ??= new GasPressureProjection(
      this.resolution, this.cellSizeNode, this.maxVelocityNode, this.solid, this.pressureCurrent, this.divergence,
      this.closedMinNode, this.closedMaxNode,
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
    this.getPressureProjection().solve(renderer, input, output, this.pressureIterations);
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

  private syncSimulationUniforms(): void {
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
    const curl = this.curlNode ?? Fn(() => {
      const coordinate = this.cellCoordinate(instanceIndex);
      const dx = sample(this.velocityNext, coordinate, 1, 0, 0).xyz
        .sub(sample(this.velocityNext, coordinate, -1, 0, 0).xyz);
      const dy = sample(this.velocityNext, coordinate, 0, 1, 0).xyz
        .sub(sample(this.velocityNext, coordinate, 0, -1, 0).xyz);
      const dz = sample(this.velocityNext, coordinate, 0, 0, 1).xyz
        .sub(sample(this.velocityNext, coordinate, 0, 0, -1).xyz);
      const rotation = vec3(dy.z.sub(dz.y), dz.x.sub(dx.z), dx.y.sub(dy.x))
        .mul(0.5).div(this.cellSizeNode).toVar('gasCurl');
      this.curl.element(instanceIndex).assign(this.isSolid().select(vec4(0), vec4(rotation, rotation.length())));
    })().compute(this.cellCount);
    this.curlNode = curl;
    renderer.compute(curl);
    const confinement = this.confinementNode ?? Fn(() => {
      const coordinate = this.cellCoordinate(instanceIndex);
      const gradient = vec3(
        sample(this.curl, coordinate, 1, 0, 0).w.sub(sample(this.curl, coordinate, -1, 0, 0).w),
        sample(this.curl, coordinate, 0, 1, 0).w.sub(sample(this.curl, coordinate, 0, -1, 0).w),
        sample(this.curl, coordinate, 0, 0, 1).w.sub(sample(this.curl, coordinate, 0, 0, -1).w),
      ).toVar('gasCurlGradient');
      const normal = gradient.div(gradient.length().max(1e-6));
      // Fedkiw et al.: epsilon * h * (normalized grad |curl u|) cross curl u.
      const force = normal.cross(this.curl.element(instanceIndex).xyz)
        .mul(this.vorticityNode).mul(this.cellSizeNode);
      const velocity = this.velocityNext.element(instanceIndex);
      velocity.assign(this.isSolid().select(vec4(0), vec4(
        this.clampVelocity(velocity.xyz.add(force.mul(context.deltaTimeNode))), 0,
      )));
    })().compute(this.cellCount);
    this.confinementNode = confinement;
    renderer.compute(confinement);
  }

  private predictAdvection(
    source: Vec4Storage,
    target: Vec4Storage,
    context: GPUParticleUpdateContext,
    renderer: ParticleSpatialGridRenderer,
  ): void {
    const node = this.advectionNodes.get(source) ?? Fn(() => {
      const center = this.cellCenter(this.cellCoordinate(instanceIndex));
      const position = center.sub(this.sampleVelocity(center).mul(context.deltaTimeNode));
      const blocked = this.isSolid(this.cellIndex(this.worldToCell(position)));
      const value = blocked.select(source.element(instanceIndex), this.sampleField(position, source));
      target.element(instanceIndex).assign(this.isSolid().select(vec4(0), value));
    })().compute(this.cellCount);
    this.advectionNodes.set(source, node);
    renderer.compute(node);
  }

  private advectField(
    source: Vec4Storage,
    predicted: Vec4Storage,
    center: Node<'vec3'>,
    dt: Node<'float'>,
  ): Node<'vec4'> {
    const displacement = this.sampleVelocity(center).mul(dt).toVar('gasDisplacement');
    const backtrace = center.sub(displacement);
    const blocked = this.isSolid(this.cellIndex(this.worldToCell(backtrace)));
    const firstOrder = blocked.select(source.element(instanceIndex), this.sampleField(backtrace, source));
    if (this.advectionMethod === AdvectionMethod.SemiLagrangian) return firstOrder as Node<'vec4'>;

    const reversePosition = center.add(displacement);
    const reversed = this.sampleField(reversePosition, predicted);
    const corrected = predicted.element(instanceIndex).add(source.element(instanceIndex).sub(reversed).mul(0.5));
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
    _maxParticleSpeed: number,
  ): Promise<number> {
    const values = new Float32Array(await renderer.getArrayBufferAsync(this.maximaAttribute));
    const maximumDensity = Math.max(0, values[0] ?? 0);
    const maximumTemperature = Math.max(0, values[1] ?? 0);
    if (maximumDensity <= 0) return 0;

    const estimate = this.estimateBuoyantTravel(maximumDensity, maximumTemperature);
    const lifetime = estimate.frames / 60;
    const diffusionDistance = this.cellSize * Math.sqrt(Math.max(0, this.scalarDiffusion) * lifetime);
    return diffusionDistance + estimate.distance;
  }

  private particleTemperature(time: Node<'float'>, seed: Node): Node<'float'> {
    return float(this.sourceTemperature).mul(this.gpuParameters.number(
      'temperatureOverLifetime',
      () => this.temperatureOverLifetime,
      time,
      1,
      seed,
    )) as Node<'float'>;
  }

  private reduceFieldMaxima(renderer: ParticleSpatialGridRenderer, density: Vec4Storage): void {
    const reset = this.maximaResetNode ?? Fn(() => {
      atomicStore(this.maxima.element(instanceIndex), uint(0));
    })().compute(2);
    this.maximaResetNode = reset;
    renderer.compute(reset);

    const reduce = this.maximaNodes.get(density) ?? Fn(() => {
      const value = density.element(instanceIndex);
      const cellDensity = max(value.x, float(0));
      const temperature = max(value.y.div(max(cellDensity, float(1e-6))), float(0));
      atomicMax(this.maxima.element(0), floatBitsToUint(cellDensity));
      atomicMax(this.maxima.element(1), floatBitsToUint(temperature));
    })().compute(this.cellCount);
    this.maximaNodes.set(density, reduce);
    renderer.compute(reduce);
  }

  private estimateBuoyantTravel(
    maximumDensity: number,
    maximumTemperature: number,
  ): { distance: number; frames: number } {
    const threshold = this.densityCutoff;
    const dt = 1 / 60;
    const densityRetention = Math.exp(-Math.max(0, this.densityDissipation) * dt);
    const temperatureRetention = Math.exp(-Math.max(0, this.temperatureDissipation) * dt);
    const velocityRetention = Math.exp(-Math.max(0, this.velocityDissipation) * dt);
    let density = maximumDensity;
    let temperatureMass = maximumTemperature * maximumDensity;
    let velocity = 0;
    let distance = 0;
    let frames = 0;

    while (density > threshold && frames < 600) {
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

  private outputColor(
    accumulatedColor: Node<'vec3'>,
    density: Node<'float'>,
    temperatureMass: Node<'float'>,
  ): Node<'vec3'> {
    const particleColor = accumulatedColor.div(max(density, float(1e-6)));
    if (!this.temperatureColor) return particleColor as Node<'vec3'>;
    const temperature = temperatureMass.div(max(density, float(1e-6)));
    const parameter = temperature.sub(this.temperatureRange[0])
      .div(Math.max(this.temperatureRange[1] - this.temperatureRange[0], Number.EPSILON))
      .clamp(0, 1);
    return this.gpuParameters.parameterColor(
      'temperatureColor',
      () => this.temperatureColor,
      parameter,
      new THREE.Color(0xffffff),
    );
  }
}

// Gas transport uses staggered face fluxes so D, G and the pressure Laplacian
// describe the same operator. Center velocities remain the force/source workspace.
class GasPressureProjection {
  readonly attribute: StorageBufferAttribute;
  private readonly faces: Vec4Storage;
  private readonly faceCount: number;
  private initialized = false;
  private builds = new WeakMap<object, ComputeNode>();
  private centers = new WeakMap<object, ComputeNode>();
  private divergenceNode?: ComputeNode;
  private pressureNodes: ComputeNode[] = [];
  private projectNode?: ComputeNode;

  constructor(
    private readonly n: number,
    private readonly h: Node<'float'>,
    private readonly maxVelocity: Node<'float'>,
    private readonly solid: FloatStorage,
    private readonly pressure: FloatStorage,
    private readonly divergence: FloatStorage,
    private readonly closedMin: Node<'vec3'>,
    private readonly closedMax: Node<'vec3'>,
  ) {
    this.faceCount = (n + 1) ** 3;
    this.attribute = new StorageBufferAttribute(new Float32Array(this.faceCount * 4), 4);
    this.faces = storage(this.attribute, 'vec4', this.faceCount) as Vec4Storage;
  }

  invalidate(): void { this.initialized = false; }

  dispose(): void { this.attribute.dispose(); }

  private coordinate(index: Node<'uint'>, side: number): Node<'ivec3'> {
    return ivec3(int(index.mod(side)), int(index.div(side).mod(side)), int(index.div(side * side)));
  }

  private index(coordinate: Node<'ivec3'>, side: number): Node<'uint'> {
    return uint(coordinate.x.add(coordinate.y.mul(side)).add(coordinate.z.mul(side * side)));
  }

  private cell(coordinate: Node<'ivec3'>): Node<'uint'> {
    return this.index(ivec3(clamp(vec3(coordinate), vec3(0), vec3(this.n - 1))), this.n);
  }

  private inside(coordinate: Node<'ivec3'>): Node<'bool'> {
    return vec3(coordinate).greaterThanEqual(vec3(0)).all()
      .and(vec3(coordinate).lessThan(vec3(this.n)).all());
  }

  private occupied(coordinate: Node<'ivec3'>): Node<'bool'> {
    const wall = (['x', 'y', 'z'] as const).map((axis) => float(coordinate[axis]).lessThan(0)
      .and(this.closedMin[axis].greaterThan(0)).or(float(coordinate[axis]).greaterThanEqual(this.n)
        .and(this.closedMax[axis].greaterThan(0)))).reduce((a, b) => a.or(b));
    return wall.or(this.inside(coordinate).and(this.solid.element(this.cell(coordinate)).greaterThanEqual(0.5)));
  }

  private axis(axis: number): Node<'ivec3'> {
    return ivec3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
  }

  private gradient(face: Node<'ivec3'>, axis: number): Node<'float'> {
    const lower = face.sub(this.axis(axis));
    const upper = face;
    const boundary = this.inside(lower).and(this.inside(upper)).not();
    const p0 = this.inside(lower).select(this.pressure.element(this.cell(lower)), float(0));
    const p1 = this.inside(upper).select(this.pressure.element(this.cell(upper)), float(0));
    return this.occupied(lower).or(this.occupied(upper)).select(
      float(0), p1.sub(p0).mul(boundary.select(2, 1)).div(this.h),
    );
  }

  private build(renderer: ParticleSpatialGridRenderer, input: Vec4Storage): void {
    const node = this.builds.get(input) ?? Fn(() => {
      const face = this.coordinate(instanceIndex, this.n + 1);
      const components = (['x', 'y', 'z'] as const).map((component, axis) => {
        const lower = face.sub(this.axis(axis));
        const a = input.element(this.cell(lower))[component];
        const b = input.element(this.cell(face))[component];
        const average = this.inside(lower).and(this.inside(face)).select(a.add(b).mul(0.5),
          this.inside(lower).select(a, b));
        return this.occupied(lower).or(this.occupied(face)).select(float(0), average);
      });
      this.faces.element(instanceIndex).assign(vec4(components[0], components[1], components[2], 0));
    })().compute(this.faceCount);
    this.builds.set(input, node);
    renderer.compute(node);
    this.initialized = true;
  }

  initialize(renderer: ParticleSpatialGridRenderer, input: Vec4Storage): void {
    if (!this.initialized) this.build(renderer, input);
  }

  sample(position: Node<'vec3'>): Node<'vec3'> {
    const values = (['x', 'y', 'z'] as const).map((component, axis) => {
      const offset = vec3(axis === 0 ? 0 : 0.5, axis === 1 ? 0 : 0.5, axis === 2 ? 0 : 0.5);
      const coordinate = position.sub(offset);
      const base = floor(coordinate);
      const fraction = coordinate.sub(base);
      const limits = vec3(axis === 0 ? this.n : this.n - 1,
        axis === 1 ? this.n : this.n - 1, axis === 2 ? this.n : this.n - 1);
      const at = (x: number, y: number, z: number) => this.faces.element(this.index(
        ivec3(clamp(base.add(vec3(x, y, z)), vec3(0), limits)), this.n + 1,
      ))[component];
      return mix(
        mix(mix(at(0, 0, 0), at(1, 0, 0), fraction.x), mix(at(0, 1, 0), at(1, 1, 0), fraction.x), fraction.y),
        mix(mix(at(0, 0, 1), at(1, 0, 1), fraction.x), mix(at(0, 1, 1), at(1, 1, 1), fraction.x), fraction.y),
        fraction.z,
      );
    });
    return vec3(values[0], values[1], values[2]);
  }

  solve(renderer: ParticleSpatialGridRenderer, input: Vec4Storage, output: Vec4Storage, iterations: number): void {
    this.build(renderer, input);
    this.divergenceNode ??= Fn(() => {
      const c = this.coordinate(instanceIndex, this.n);
      const lower = this.faces.element(this.index(c, this.n + 1));
      const divergence = this.faces.element(this.index(c.add(ivec3(1, 0, 0)), this.n + 1)).x.sub(lower.x)
        .add(this.faces.element(this.index(c.add(ivec3(0, 1, 0)), this.n + 1)).y.sub(lower.y))
        .add(this.faces.element(this.index(c.add(ivec3(0, 0, 1)), this.n + 1)).z.sub(lower.z)).div(this.h);
      this.divergence.element(instanceIndex).assign(this.occupied(c).select(float(0), divergence));
      this.pressure.element(instanceIndex).assign(0);
    })().compute(this.n ** 3);
    renderer.compute(this.divergenceNode);

    // Each color reads only the opposite color, with dispatch boundaries between
    // updates. Solid faces are Neumann; open domain faces have zero pressure at h/2.
    for (let parity = 0; parity < 2; parity += 1) {
      this.pressureNodes[parity] ??= Fn(() => {
        const c = this.coordinate(instanceIndex, this.n);
        If(c.x.add(c.y).add(c.z).mod(2).equal(parity).and(this.occupied(c).not()), () => {
          const sum = float(0).toVar();
          const diagonal = float(0).toVar();
          for (let axis = 0; axis < 3; axis += 1) {
            for (const sign of [-1, 1]) {
              const neighbor = c.add(this.axis(axis).mul(sign));
              const weight = this.occupied(neighbor).select(0, this.inside(neighbor).select(1, 2));
              diagonal.addAssign(weight);
              sum.addAssign(this.inside(neighbor).select(
                this.pressure.element(this.cell(neighbor)).mul(weight), float(0),
              ));
            }
          }
          this.pressure.element(instanceIndex).assign(sum.sub(
            this.divergence.element(instanceIndex).mul(this.h.mul(this.h)),
          ).div(max(diagonal, float(1))));
        });
      })().compute(this.n ** 3);
    }
    for (let iteration = 0; iteration < Math.max(0, Math.floor(iterations)); iteration += 1) {
      renderer.compute(this.pressureNodes[0]);
      renderer.compute(this.pressureNodes[1]);
    }

    this.projectNode ??= Fn(() => {
      const face = this.coordinate(instanceIndex, this.n + 1);
      const gradient = vec3(this.gradient(face, 0), this.gradient(face, 1), this.gradient(face, 2));
      // Safety limits can leave residual divergence when active, as with the
      // center-velocity limit. They are not part of the pressure operator.
      this.faces.element(instanceIndex).xyz.assign(clamp(
        this.faces.element(instanceIndex).xyz.sub(gradient), this.maxVelocity.negate(), this.maxVelocity,
      ));
    })().compute(this.faceCount);
    renderer.compute(this.projectNode);

    const centerNode = this.centers.get(input) ?? Fn(() => {
      const c = this.coordinate(instanceIndex, this.n);
      const gradient = vec3(...[0, 1, 2].map(axis => this.gradient(c, axis)
        .add(this.gradient(c.add(this.axis(axis)), axis)).mul(0.5)) as [Node<'float'>, Node<'float'>, Node<'float'>]);
      const velocity = input.element(instanceIndex).xyz.sub(gradient);
      const limited = velocity.mul(clamp(this.maxVelocity.div(max(velocity.length(), float(1e-6))), 0, 1));
      output.element(instanceIndex).assign(this.occupied(c).select(vec4(0), vec4(limited, 0)));
    })().compute(this.n ** 3);
    this.centers.set(input, centerNode);
    renderer.compute(centerNode);
  }
}

export default GasSimulation;
