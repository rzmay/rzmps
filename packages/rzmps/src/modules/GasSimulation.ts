import * as THREE from 'three';
import { Storage3DTexture, StorageBufferAttribute, type ComputeNode, type Node } from 'three/webgpu';
import { Fn, clamp, float, instanceIndex, ivec3, max, mix, storage, textureStore, vec3, vec4 } from 'three/tsl';
import type { GPUParticleRenderBufferState, GPUParticleUpdateContext } from '../gpu/Particle';
import ParticleSpatialGrid, { type ParticleSpatialGridRenderer } from '../gpu/ParticleSpatialGrid';
import type { VolumeField } from '../interfaces/VolumeField';
import FluidSimulation, { type FluidSimulationOptions } from './FluidSimulation';

type Vec4Storage = { element(index: Node | number): Node<'vec4'> };

export interface GasSimulationOptions extends FluidSimulationOptions {
  densityDissipation: number;
  temperatureDissipation: number;
  colorDissipation: number;
  velocityDissipation: number;
  buoyancy: number;
  weight: number;
  sourceStrength: number;
  velocitySourceStrength: number;
  sourceTemperature: number;
  maxSplatRadius: number;
}

class GasSimulation extends FluidSimulation {
  density: VolumeField;
  colorField: VolumeField;
  densityDissipation: number;
  temperatureDissipation: number;
  colorDissipation: number;
  velocityDissipation: number;
  buoyancy: number;
  weight: number;
  sourceStrength: number;
  velocitySourceStrength: number;
  sourceTemperature: number;
  maxSplatRadius: number;

  private readonly densityAttributeA: StorageBufferAttribute;
  private readonly densityAttributeB: StorageBufferAttribute;
  private readonly colorAttributeA: StorageBufferAttribute;
  private readonly colorAttributeB: StorageBufferAttribute;
  private readonly visualDensityAttribute: StorageBufferAttribute;
  private readonly visualColorAttribute: StorageBufferAttribute;
  private densityCurrent: Vec4Storage;
  private densityNext: Vec4Storage;
  private colorCurrent: Vec4Storage;
  private colorNext: Vec4Storage;
  private readonly visualDensity: Vec4Storage;
  private readonly visualColor: Vec4Storage;
  private readonly densityTexture: Storage3DTexture;
  private readonly colorTexture: Storage3DTexture;
  private gpuCacheKey = '';
  private velocityNodes = new WeakMap<object, ComputeNode>();
  private velocitySourceNode?: ComputeNode;
  private sourceNodes = new WeakMap<object, ComputeNode>();
  private densitySourceNodes = new WeakMap<object, ComputeNode>();
  private colorSourceNodes = new WeakMap<object, ComputeNode>();
  private outputNodes = new WeakMap<object, ComputeNode>();
  private pendingPreviousBounds?: THREE.Box3;
  private visualCacheKey = '';
  private visualDensityNode?: ComputeNode;
  private visualColorNode?: ComputeNode;
  private visualOutputNodes = new WeakMap<object, ComputeNode>();

  constructor(options: Partial<GasSimulationOptions> = {}) {
    super(options);
    this.densityDissipation = options.densityDissipation ?? 0.99;
    this.temperatureDissipation = options.temperatureDissipation ?? 0.98;
    this.colorDissipation = options.colorDissipation ?? this.densityDissipation;
    this.velocityDissipation = options.velocityDissipation ?? 0.99;
    this.buoyancy = options.buoyancy ?? 1;
    this.weight = options.weight ?? 0;
    this.sourceStrength = options.sourceStrength ?? 1;
    this.velocitySourceStrength = options.velocitySourceStrength ?? 0.12;
    this.sourceTemperature = options.sourceTemperature ?? 0;
    this.maxSplatRadius = options.maxSplatRadius ?? 1.5;

    this.densityAttributeA = new StorageBufferAttribute(new Float32Array(this.cellCount * 4), 4);
    this.densityAttributeB = new StorageBufferAttribute(new Float32Array(this.cellCount * 4), 4);
    this.colorAttributeA = new StorageBufferAttribute(new Float32Array(this.cellCount * 4), 4);
    this.colorAttributeB = new StorageBufferAttribute(new Float32Array(this.cellCount * 4), 4);
    this.visualDensityAttribute = new StorageBufferAttribute(new Float32Array(this.cellCount * 4), 4);
    this.visualColorAttribute = new StorageBufferAttribute(new Float32Array(this.cellCount * 4), 4);
    this.densityCurrent = storage(this.densityAttributeA, 'vec4', this.cellCount) as Vec4Storage;
    this.densityNext = storage(this.densityAttributeB, 'vec4', this.cellCount) as Vec4Storage;
    this.colorCurrent = storage(this.colorAttributeA, 'vec4', this.cellCount) as Vec4Storage;
    this.colorNext = storage(this.colorAttributeB, 'vec4', this.cellCount) as Vec4Storage;
    this.visualDensity = storage(this.visualDensityAttribute, 'vec4', this.cellCount) as Vec4Storage;
    this.visualColor = storage(this.visualColorAttribute, 'vec4', this.cellCount) as Vec4Storage;

    this.densityTexture = this.makeTexture();
    this.colorTexture = this.makeTexture();
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
    this.refreshBounds(grid, renderer);
    this.remapFields(renderer);
    const dt = context.deltaTimeNode;
    const tagMask = context.system.getGPUFilterTagMask(this.tags);

    const cacheKey = [grid.resourceVersion, context.buffers.version, tagMask, this.velocityDissipation,
      this.buoyancy, this.weight, this.velocitySourceStrength, this.densityDissipation,
      this.temperatureDissipation, this.colorDissipation, this.sourceStrength,
      this.sourceTemperature, this.maxSplatRadius].join('|');
    if (cacheKey !== this.gpuCacheKey) {
      this.gpuCacheKey = cacheKey;
      this.velocityNodes = new WeakMap();
      this.velocitySourceNode = undefined;
      this.sourceNodes = new WeakMap();
      this.densitySourceNodes = new WeakMap();
      this.colorSourceNodes = new WeakMap();
      this.outputNodes = new WeakMap();
    }

    const velocity = this.velocityNodes.get(this.densityCurrent) ?? Fn(() => {
      const coordinate = this.cellCoordinate(instanceIndex);
      const center = this.cellCenter(coordinate);
      const previous = this.sampleVelocity(center.sub(
        this.sampleVelocity(center).mul(dt),
      ));
      const density = this.densityCurrent.element(instanceIndex);
      const lift = density.y.mul(this.buoyancy).sub(density.x.mul(this.weight));
      const advected = vec3(previous)
        .mul(this.velocityDissipation)
        .add(this.forceNode.mul(dt))
        .add(vec3(0, 1, 0).mul(lift.mul(dt)));
      this.velocityNext.element(instanceIndex).assign(vec4(this.clampVelocity(advected), 0));
    })().compute(this.cellCount);
    this.velocityNodes.set(this.densityCurrent, velocity);
    renderer.compute(velocity);

    const velocitySources = this.velocitySourceNode ?? Fn(() => {
      const coordinate = this.cellCoordinate(instanceIndex);
      const center = this.cellCenter(coordinate);
      const momentum = vec3(0).toVar('gasSourceMomentum');
      const sourceMass = float(0).toVar('gasSourceMass');
      const radius = max(this.cellSizeNode.mul(1.5), float(this.maxSplatRadius));
      grid.forEachParticleInRadius(center, radius, (particle, distanceSq) => {
        const particleRadius = max(
          max(particle.scale.x, max(particle.scale.y, particle.scale.z)).mul(0.5),
          this.cellSizeNode.mul(0.75),
        );
        const weight = max(float(0), float(1).sub(distanceSq.sqrt().div(particleRadius)));
        const mass = max(particle.mass, float(0)).mul(particle.alpha).mul(weight);
        sourceMass.addAssign(mass);
        momentum.addAssign(particle.velocity.mul(mass));
      }, { tagMask });
      const blend = clamp(sourceMass.mul(this.velocitySourceStrength), 0, 1);
      const previous = vec3(this.velocityNext.element(instanceIndex).xyz);
      const updated = mix(previous, momentum.div(max(sourceMass, float(1e-6))), blend);
      this.velocityNext.element(instanceIndex).assign(vec4(this.clampVelocity(updated), 0));
    })().compute(this.cellCount);
    this.velocitySourceNode = velocitySources;
    renderer.compute(velocitySources);

    this.solveProjection(renderer, this.velocityNext, this.velocityCurrent);

    const densityCurrent = this.densityCurrent;
    const colorCurrent = this.colorCurrent;
    const densityNext = this.densityNext;
    const colorNext = this.colorNext;
    const sources = this.sourceNodes.get(densityCurrent) ?? Fn(() => {
      const coordinate = this.cellCoordinate(instanceIndex);
      const center = this.cellCenter(coordinate);
      const backtrace = center.sub(this.sampleVelocity(center).mul(dt));
      const previousIndex = this.cellIndex(this.worldToCell(backtrace));
      const previousDensity = densityCurrent.element(previousIndex);
      const previousColor = colorCurrent.element(previousIndex);
      const density = max(float(0), previousDensity.x.mul(this.densityDissipation));
      const temperature = max(float(0), previousDensity.y.mul(this.temperatureDissipation));
      const color = vec3(previousColor.xyz).mul(this.colorDissipation);
      densityNext.element(instanceIndex).assign(vec4(density, temperature, 0, 0));
      colorNext.element(instanceIndex).assign(vec4(color, 0));
    })().compute(this.cellCount);
    this.sourceNodes.set(densityCurrent, sources);
    renderer.compute(sources);

    const densitySources = this.densitySourceNodes.get(densityNext) ?? Fn(() => {
      const center = this.cellCenter(this.cellCoordinate(instanceIndex));
      const sourceDensity = float(0).toVar('gasSourceDensity');
      const radius = max(this.cellSizeNode.mul(1.5), float(this.maxSplatRadius));
      grid.forEachParticleInRadius(center, radius, (particle, distanceSq) => {
        const particleRadius = max(max(particle.scale.x, max(particle.scale.y, particle.scale.z)).mul(0.5), this.cellSizeNode.mul(0.75));
        const weight = max(float(0), float(1).sub(distanceSq.sqrt().div(particleRadius)));
        sourceDensity.addAssign(max(particle.mass, float(0)).mul(particle.alpha).mul(weight).mul(this.sourceStrength));
      }, { tagMask });
      const previous = densityNext.element(instanceIndex);
      densityNext.element(instanceIndex).assign(vec4(
        previous.x.add(sourceDensity), previous.y.add(sourceDensity.mul(this.sourceTemperature)), 0, 0,
      ));
    })().compute(this.cellCount);
    this.densitySourceNodes.set(densityNext, densitySources);
    renderer.compute(densitySources);

    const colorSources = this.colorSourceNodes.get(colorNext) ?? Fn(() => {
      const center = this.cellCenter(this.cellCoordinate(instanceIndex));
      const sourceColor = vec3(0).toVar('gasSourceColor');
      const radius = max(this.cellSizeNode.mul(1.5), float(this.maxSplatRadius));
      grid.forEachParticleInRadius(center, radius, (particle, distanceSq) => {
        const particleRadius = max(max(particle.scale.x, max(particle.scale.y, particle.scale.z)).mul(0.5), this.cellSizeNode.mul(0.75));
        const weight = max(float(0), float(1).sub(distanceSq.sqrt().div(particleRadius)));
        const contribution = max(particle.mass, float(0)).mul(particle.alpha).mul(weight).mul(this.sourceStrength);
        sourceColor.addAssign(particle.color.mul(contribution));
      }, { tagMask });
      colorNext.element(instanceIndex).assign(vec4(colorNext.element(instanceIndex).xyz.add(sourceColor), 0));
    })().compute(this.cellCount);
    this.colorSourceNodes.set(colorNext, colorSources);
    renderer.compute(colorSources);
    [this.densityCurrent, this.densityNext] = [this.densityNext, this.densityCurrent];
    [this.colorCurrent, this.colorNext] = [this.colorNext, this.colorCurrent];

    const outputDensity = this.densityCurrent;
    const outputColor = this.colorCurrent;
    const output = this.outputNodes.get(outputDensity) ?? Fn(() => {
      const coordinate = this.cellCoordinate(instanceIndex);
      const density = outputDensity.element(instanceIndex).x;
      const color = outputColor.element(instanceIndex).xyz;
      const normalized = vec3(color).div(max(density, float(1e-6)));
      textureStore(this.densityTexture, vec3(coordinate), vec4(density, 0, 0, 1)).toWriteOnly();
      textureStore(this.colorTexture, vec3(coordinate), vec4(normalized, density.greaterThan(0).select(1, 0))).toWriteOnly();
    })().compute(this.cellCount);
    this.outputNodes.set(outputDensity, output);
    renderer.compute(output);
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
      tagMask, this.sourceStrength, this.maxSplatRadius].join('|');
    if (cacheKey !== this.visualCacheKey) {
      this.visualCacheKey = cacheKey;
      this.visualDensityNode = undefined;
      this.visualColorNode = undefined;
    }

    const densityNode = this.visualDensityNode ?? Fn(() => {
      const center = this.cellCenter(this.cellCoordinate(instanceIndex));
      const total = float(0).toVar('visualGasDensity');
      const radius = max(this.cellSizeNode.mul(1.5), float(this.maxSplatRadius));
      grid.forEachParticleInRadius(center, radius, (particle) => {
        const vectors = renderBuffers.storage.createVectorNodes(particle.index);
        const scalars = renderBuffers.storage.createScalarNodes(particle.index);
        const particleRadius = max(max(vectors.scale.x, max(vectors.scale.y, vectors.scale.z)).mul(0.5), this.cellSizeNode.mul(0.75));
        const weight = max(float(0), float(1).sub(vectors.position.distance(center).div(particleRadius)));
        total.addAssign(max(particle.mass, float(0)).mul(scalars.alpha).mul(weight).mul(this.sourceStrength));
      }, { tagMask });
      this.visualDensity.element(instanceIndex).assign(vec4(total, 0, 0, 0));
    })().compute(this.cellCount);
    this.visualDensityNode = densityNode;
    renderer.compute(densityNode);

    const colorNode = this.visualColorNode ?? Fn(() => {
      const center = this.cellCenter(this.cellCoordinate(instanceIndex));
      const total = vec3(0).toVar('visualGasColor');
      const radius = max(this.cellSizeNode.mul(1.5), float(this.maxSplatRadius));
      grid.forEachParticleInRadius(center, radius, (particle) => {
        const vectors = renderBuffers.storage.createVectorNodes(particle.index);
        const scalars = renderBuffers.storage.createScalarNodes(particle.index);
        const particleRadius = max(max(vectors.scale.x, max(vectors.scale.y, vectors.scale.z)).mul(0.5), this.cellSizeNode.mul(0.75));
        const weight = max(float(0), float(1).sub(vectors.position.distance(center).div(particleRadius)));
        const contribution = max(particle.mass, float(0)).mul(scalars.alpha).mul(weight).mul(this.sourceStrength);
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
      const totalDensity = density.element(instanceIndex).x.add(this.visualDensity.element(instanceIndex).x);
      const totalColor = vec3(color.element(instanceIndex).xyz).add(this.visualColor.element(instanceIndex).xyz);
      textureStore(this.densityTexture, vec3(coordinate), vec4(totalDensity, 0, 0, 1)).toWriteOnly();
      textureStore(this.colorTexture, vec3(coordinate), vec4(
        totalColor.div(max(totalDensity, float(1e-6))), totalDensity.greaterThan(0).select(1, 0),
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
    this.densityTexture.dispose();
    this.colorTexture.dispose();
    [
      this.densityAttributeA,
      this.densityAttributeB,
      this.colorAttributeA,
      this.colorAttributeB,
      this.visualDensityAttribute,
      this.visualColorAttribute,
    ].forEach((attribute) => attribute.dispose());
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
}

export default GasSimulation;
