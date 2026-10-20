import * as THREE from 'three';
import { Storage3DTexture, StorageBufferAttribute, type ComputeNode, type Node } from 'three/webgpu';
import {
  Fn, atomicMax, atomicStore, clamp, float, floatBitsToUint, instanceIndex, ivec3,
  max, min, mix, pow, storage, textureStore, uint, uniform, vec3, vec4,
} from 'three/tsl';
import type { GPUParticleRenderBufferState, GPUParticleUpdateContext } from '../gpu/Particle';
import ParticleSpatialGrid, { type ParticleSpatialGridRenderer } from '../gpu/ParticleSpatialGrid';
import { generateGPUParticleNoise4D } from '../helpers/noise';
import type { VolumeField } from '../interfaces/VolumeField';
import type { ValueByParameter } from '../types/ValueByParameter';
import type { DynamicValue } from '../types/DynamicValue';
import FluidSimulation, { type FluidSimulationOptions } from './FluidSimulation';

type Vec4Storage = { element(index: Node | number): Node<'vec4'> };
type AtomicUintStorage = { element(index: Node | number): Node<'uint'> };
type FloatUniform = Node<'float'> & { value: number };

export interface GasSimulationOptions extends FluidSimulationOptions {
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
  vorticityStrength: number;
  noiseFrequency: number;
  noiseSpeed: number;
  noiseOctaves: number;
}

class GasSimulation extends FluidSimulation {
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

  constructor(options: Partial<GasSimulationOptions> = {}) {
    super({
      ...options,
      automaticPadding: options.automaticPadding ?? true,
    });
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
    this.ensureGridResolution(renderer, grid);
    this.syncSimulationUniforms();
    this.refreshBounds(grid, renderer);
    this.remapFields(renderer);
    this.computeSolidField(context, renderer);
    const dt = context.deltaTimeNode;
    const tagMask = context.system.getGPUFilterTagMask(this.tags);

    const cacheKey = [grid.resourceVersion, context.buffers.version, tagMask,
      this.buoyancy, this.weight, this.velocitySourceStrength, this.sourceStrength,
      this.sourceTemperature, Boolean(this.temperatureOverLifetime), this.temperatureRange.join(','),
      Boolean(this.temperatureColor), this.vorticityStrength, this.noiseFrequency,
      this.noiseSpeed, this.noiseOctaves].join('|');
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

    const velocity = this.velocityNodes.get(this.densityCurrent) ?? Fn(() => {
      const coordinate = this.cellCoordinate(instanceIndex);
      const center = this.cellCenter(coordinate);
      const backtrace = center.sub(this.sampleVelocity(center).mul(dt));
      const backtraceSolid = this.isSolid(this.cellIndex(this.worldToCell(backtrace)));
      const previous = backtraceSolid.select(
        this.velocityCurrent.element(instanceIndex).xyz,
        this.sampleVelocity(backtrace),
      );
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
      ).mul(2).sub(1).mul(this.vorticityStrength);
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
        const mass = max(particle.mass, float(0)).mul(particle.alpha).mul(weight);
        sourceMass.addAssign(mass);
        momentum.addAssign(particle.velocity.mul(mass));
      }, { tagMask });
      const blend = clamp(sourceMass.mul(this.velocitySourceStrength).mul(dt), 0, 1);
      const previous = vec3(this.velocityNext.element(instanceIndex).xyz);
      const updated = mix(previous, momentum.div(max(sourceMass, float(1e-6))), blend);
      this.velocityNext.element(instanceIndex).assign(vec4(this.clampVelocity(updated), 0));
    })().compute(this.cellCount);
    this.velocitySourceNode = velocitySources;
    renderer.compute(velocitySources);

    this.solveProjection(renderer, this.velocityNext, this.velocityCurrent, false, this.solid);

    const densityCurrent = this.densityCurrent;
    const colorCurrent = this.colorCurrent;
    const densityNext = this.densityNext;
    const colorNext = this.colorNext;
    const sources = this.sourceNodes.get(densityCurrent) ?? Fn(() => {
      const coordinate = this.cellCoordinate(instanceIndex);
      const center = this.cellCenter(coordinate);
      const backtrace = center.sub(this.sampleVelocity(center).mul(dt));
      const backtraceSolid = this.isSolid(this.cellIndex(this.worldToCell(backtrace)));
      const previousDensity = backtraceSolid.select(
        densityCurrent.element(instanceIndex),
        this.sampleField(backtrace, densityCurrent),
      );
      const previousColor = backtraceSolid.select(
        colorCurrent.element(instanceIndex),
        this.sampleField(backtrace, colorCurrent),
      );
      const diffusion = clamp(this.scalarDiffusionNode.mul(dt), 0, 1);
      const mixedDensity = mix(previousDensity, this.neighborAverage(densityCurrent, coordinate), diffusion);
      const mixedColor = mix(previousColor, this.neighborAverage(colorCurrent, coordinate), diffusion);
      const gridCoordinate = vec3(coordinate);
      const edgeDistance = min(
        min(gridCoordinate.x, gridCoordinate.y),
        min(gridCoordinate.z, min(
          float(this.resolution - 1).sub(gridCoordinate.x),
          min(
            float(this.resolution - 1).sub(gridCoordinate.y),
            float(this.resolution - 1).sub(gridCoordinate.z),
          ),
        )),
      );
      const boundaryFade = clamp(edgeDistance.div(2), 0, 1);
      const densityRetention = pow(float(Math.E), dt.mul(this.densityDissipationNode).mul(-1));
      const temperatureRetention = pow(float(Math.E), dt.mul(this.temperatureDissipationNode).mul(-1));
      const colorRetention = pow(float(Math.E), dt.mul(this.colorDissipationNode).mul(-1));
      const rawDensity = max(float(0), mixedDensity.x
        .mul(densityRetention).mul(boundaryFade));
      const keep = rawDensity.greaterThanEqual(this.densityCutoffNode);
      const density = keep.select(rawDensity, float(0));
      const temperature = keep.select(
        max(float(0), mixedDensity.y
          .mul(densityRetention).mul(temperatureRetention).mul(boundaryFade)),
        float(0),
      );
      const color = keep.select(
        vec3(mixedColor.xyz).mul(colorRetention).mul(boundaryFade),
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
          .mul(weight).mul(this.sourceStrength).mul(dt);
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
        const contribution = max(particle.mass, float(0)).mul(particle.alpha).mul(weight).mul(this.sourceStrength).mul(dt);
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
    ].forEach((attribute) => attribute?.dispose());
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
    this.densityDissipationNode.value = Math.max(0, this.densityDissipation);
    this.densityCutoffNode.value = Math.max(0, this.densityCutoff);
    this.temperatureDissipationNode.value = Math.max(0, this.temperatureDissipation);
    this.colorDissipationNode.value = Math.max(0, this.colorDissipation);
    this.velocityDissipationNode.value = Math.max(0, this.velocityDissipation);
    this.scalarDiffusionNode.value = Math.max(0, this.scalarDiffusion);
  }

  private splatRadius(scale: Node<'vec3'>): Node<'float'> {
    const minimum = this.cellSizeNode;
    const particleRadius = max(scale.x.abs(), max(scale.y.abs(), scale.z.abs())).mul(0.5);
    return max(particleRadius, minimum) as Node<'float'>;
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

export default GasSimulation;
