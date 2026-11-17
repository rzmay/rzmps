import type { ColorRepresentation } from 'three';
import * as THREE from 'three';
import { Storage3DTexture, type ComputeNode, type Node, type WebGPURenderer } from 'three/webgpu';
import {
  Fn, If, Loop, array, float, instanceIndex, int, ivec3,
  pow, smoothstep, storageTexture, texture, texture3D, textureStore, uint, uniform, vec3, vec4,
} from 'three/tsl';
import Benchmarks from '../../core/Benchmarks';
import SpatialGrid from '../../spatial/structures/SpatialGrid';
import { boundsVector } from '../../spatial/structures/spatialGridDomain.utils';

import { fibonacciDirections, directionTransfer, shRadianceGPU,
  SceneLightingCollection, lightVisible } from './lightingGrid.utils';
import EnvironmentSH from './EnvironmentSH';

export interface LightingGridOptions {
  /** Cascade count. Defaults to two. */
  levels?: number;
  /** Finest direction count (coarser counts double), or explicit counts for every level. Defaults to four. */
  directions?: number | readonly number[];
  /** Requested finest probe spacing; enlarged only if packed textures exceed hardware dimensions. */
  cellSize?: number;
  /** Spatial spacing and interval growth per cascade. Defaults to two. */
  levelScale?: number;
  /** Maximum attenuated ray distance. Defaults to the power-of-two enclosing lighting-domain diagonal. */
  maxDistance?: number;
  /** Extra world-space lighting bounds, on both sides. Defaults to zero. */
  margin?: number | THREE.Vector3;
  /** Midpoint density samples per cascade interval. Defaults to four. */
  samplesPerInterval?: number;
  /** Approximate extra isotropic scattering passes. Defaults to one. */
  scatteringIterations?: number;
  /** Multiply environment/probe radiance. Defaults to one. */
  environmentIntensity?: number;
  /** Explicit raw cubemap/equirectangular environment. Undefined uses scene.environment; null disables it. */
  environment?: THREE.Texture | null;
  /** Unoccluded ambient fallback when no ambient light, probe or environment is available. Defaults to linear 0.2. */
  ambient?: ColorRepresentation;
  /** Disable dynamic injection when baked probes already contain those scene lights. Defaults to true. */
  includeSceneLights?: boolean;
}

export interface LightingGridSource {
  /** Independent consumers can share a grid; release this owner when detaching. */
  owner: object;
  /** Changes when density, opacity, transforms or other extinction inputs change. */
  version: string | number;
  /** Changes only when the density sampling shader structure changes. */
  shaderKey?: string | number;
  /** World-space extinction per unit length; must not write simulation state. */
  extinctionGPU: (position: Node<'vec3'>) => Node<'float'>;
}

type ProbeGrid = THREE.Light & {
  isLightProbeGrid: boolean; texture: THREE.Data3DTexture | null;
  boundingBox: THREE.Box3; resolution: THREE.Vector3;
};
interface Cascade {
  directions: THREE.Vector3[];
  dimensions: THREE.Vector3;
  dimensionsNode: ReturnType<typeof uniform<'vec3'>>;
  interval: ReturnType<typeof uniform<'vec2'>>;
  local: Storage3DTexture;
  merged: Storage3DTexture;
  mean: Storage3DTexture;
  meanRead: ReturnType<typeof texture3D>;
  meanWrite: ReturnType<typeof storageTexture>;
  localRead: ReturnType<typeof texture3D>;
  mergedRead: ReturnType<typeof texture3D>;
  localWrite: ReturnType<typeof storageTexture>;
  mergedWrite: ReturnType<typeof storageTexture>;
  projected: Storage3DTexture;
  projectedRead: ReturnType<typeof texture3D>;
  projectedWrite: ReturnType<typeof storageTexture>;
  projection?: ComputeNode;
  injection?: ComputeNode;
  merge?: ComputeNode;
}
interface SourceRecord {
  bounds: THREE.Box3; source: LightingGridSource;
  minimum: ReturnType<typeof uniform<'vec3'>>; maximum: ReturnType<typeof uniform<'vec3'>>;
}

/** Renderer-side directional radiance/transmittance cascades. No gas simulation resources are owned here. */
export default class LightingGrid {
  private static nextId = 0;
  readonly id = LightingGrid.nextId++;
  readonly bounds = new THREE.Box3();
  readonly benchmarks = new Benchmarks();
  levels!: number;
  directions!: number | readonly number[];
  cellSize?: number;
  levelScale!: number;
  maxDistance?: number;
  margin!: number | THREE.Vector3;
  samplesPerInterval!: number;
  scatteringIterations!: number;
  environmentIntensity!: number;
  environment?: THREE.Texture | null;
  ambient!: THREE.Color;
  includeSceneLights!: boolean;
  /** Changes only when GPU sampling structure changes, not when lights or density change. */
  version = 0;
  readonly statistics = { lights: 0, probes: 0, directionalEntries: 0, memoryBytes: 0, updates: 0, probeSpacing: 0 };
  private readonly collection = new SceneLightingCollection();
  private readonly admittedLights = new Set<THREE.Light>();
  private readonly sources = new Map<object, SourceRecord>();
  private cascades: Cascade[] = [];
  private readonly minimum = uniform(new THREE.Vector3());
  private readonly size = uniform(new THREE.Vector3(1, 1, 1));
  private readonly lightCount = uniform(0, 'int');
  // Texture-backed light records avoid additional storage-buffer bindings in consumer shaders.
  private lightData = new Float32Array(64 * 5 * 4);
  private lightTexture = new THREE.DataTexture(this.lightData, 5, 64, THREE.RGBAFormat, THREE.FloatType);
  private readonly lightsNode = texture(this.lightTexture);
  private readonly ambientNode = uniform(new THREE.Vector3(0.2, 0.2, 0.2));
  private readonly environmentGain = uniform(1);
  private readonly environmentSceneGain = uniform(1);
  private readonly environmentRotation = uniform(new THREE.Matrix3());
  private readonly probeSH = Array.from({ length: 9 }, () => uniform(new THREE.Vector3()));
  private layoutKey = '';
  private stateKey = '';
  private sourceKey = '';
  private forceUpdate = true;
  private disposed = false;
  private farFieldKey = '';
  private lightKey = '';
  private farGridUniforms?: {
    min: ReturnType<typeof uniform<'vec3'>>; max: ReturnType<typeof uniform<'vec3'>>;
    res: ReturnType<typeof uniform<'vec3'>>; intensity: ReturnType<typeof uniform<'float'>>;
  };
  private farField?: (position: Node<'vec3'>, direction: Node<'vec3'>) => Node<'vec3'>;
  private environmentProjection?: EnvironmentSH;
  private readonly finalRead: ReturnType<typeof texture3D>;
  private scatterTexture?: Storage3DTexture;
  private scatterNode?: ComputeNode;
  private scatterCopyNode?: ComputeNode;
  private isotropicNode?: ComputeNode;

  constructor(options: LightingGridOptions = {}) {
    this.setOptions(options);
    this.lightTexture.generateMipmaps = false;
    this.lightTexture.needsUpdate = true;
    this.configure(new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5)));
    this.finalRead = texture3D(this.cascades[0].merged);
  }

  /** Replace configuration; the next update reconciles changed layout and lighting values. */
  setOptions(options: LightingGridOptions = {}): void {
    this.levels = options.levels ?? 2;
    this.directions = options.directions ?? 4;
    this.cellSize = options.cellSize;
    this.levelScale = options.levelScale ?? 2;
    this.maxDistance = options.maxDistance;
    this.margin = options.margin ?? 0;
    this.samplesPerInterval = options.samplesPerInterval ?? 4;
    this.scatteringIterations = options.scatteringIterations ?? 1;
    this.environmentIntensity = options.environmentIntensity ?? 1;
    this.environment = options.environment;
    this.ambient = options.ambient === undefined ? new THREE.Color(0.2, 0.2, 0.2) : new THREE.Color(options.ambient);
    this.includeSceneLights = options.includeSceneLights ?? true;
  }

  set needsUpdate(value: boolean) {
    if (value) { this.forceUpdate = true; this.environmentProjection?.invalidate(); }
  }

  /** Shared rectangular addressing convention; coordinates refer to finest probes. */
  locate(position: THREE.Vector3): THREE.Vector3 {
    return SpatialGrid.locate(position, this.bounds, this.cascades[0].dimensions);
  }

  /** Warm the current lighting resources without advancing any particle simulation. */
  async prepare(renderer: WebGPURenderer, scene: THREE.Scene, bounds: THREE.Box3, source?: LightingGridSource) {
    if (bounds.isEmpty()) return;
    this.update(renderer, scene, bounds, source);
    const nodes = this.cascades.flatMap(level => [level.injection!, level.merge!]);
    if (this.scatterNode) nodes.push(this.scatterNode);
    await renderer.compileComputeAsync(nodes);
  }

  /** Update only changed lighting inputs. Density samplers and bounds are in world space. */
  update(renderer: WebGPURenderer, scene: THREE.Scene, bounds: THREE.Box3, source?: LightingGridSource): void {
    if (this.disposed) throw new Error('LightingGrid has been disposed.');
    if (!(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend) {
      throw new Error('LightingGrid requires a native WebGPU backend.');
    }
    if (bounds.isEmpty()) return;
    if (source) {
      const previous = this.sources.get(source.owner);
      if (previous) {
        if (previous.source.extinctionGPU !== source.extinctionGPU
          || previous.source.shaderKey !== source.shaderKey) this.invalidatePrograms();
        previous.source = source;
        previous.bounds.copy(bounds);
        previous.minimum.value.copy(bounds.min); previous.maximum.value.copy(bounds.max);
      } else {
        this.sources.set(source.owner, { source, bounds: bounds.clone(),
          minimum: uniform(bounds.min.clone()), maximum: uniform(bounds.max.clone()) });
        this.invalidatePrograms();
      }
    }
    const domain = bounds.clone();
    for (const input of this.sources.values()) domain.union(input.bounds);
    this.configure(domain);
    const backend = renderer.backend as unknown as { device: { limits: { maxTextureDimension3D: number } } };
    const limit = backend.device.limits.maxTextureDimension3D;
    if (this.cascades.some(level => Math.max(level.dimensions.x, level.dimensions.y,
      level.dimensions.z * level.directions.length) > limit)) {
      throw new RangeError('LightingGrid exceeds the device 3-D texture limit; increase cellSize.');
    }
    scene.updateMatrixWorld();
    this.collection.update(scene);
    const lights = this.collection.lights.filter(lightVisible);
    const key = this.updateInputs(scene, lights);
    this.environmentProjection?.update(renderer);
    const sourceKey = [...this.sources.values()].map(input => input.source.shaderKey ?? '').join('|');
    if (sourceKey !== this.sourceKey) { this.sourceKey = sourceKey; this.invalidatePrograms(); }
    const state = [key, ...this.bounds.min.toArray(), ...this.bounds.max.toArray(),
      ...[...this.sources.values()].flatMap(input => [input.source.version, ...input.bounds.min.toArray(),
        ...input.bounds.max.toArray()]), this.scatteringIterations].join(':');
    if (!this.forceUpdate && state === this.stateKey) return;
    this.stateKey = state;
    this.buildPrograms();
    for (let i = this.cascades.length - 1; i >= 0; i--) {
      const level = this.cascades[i];
      this.benchmarks.span('injection', () => renderer.compute(level.injection!));
      if (level.projection) this.benchmarks.span('angularTransfer', () => renderer.compute(level.projection!));
      this.benchmarks.span('propagation', () => renderer.compute(level.merge!));
    }
    this.finalRead.value = this.cascades[0].merged;
    this.applyScattering(renderer);
    this.updateIsotropic(renderer);
    const scratch = this.scatterTexture?.image as { width: number; height: number; depth: number } | undefined;
    this.statistics.memoryBytes = this.statistics.directionalEntries * 16 + this.statistics.probes * 8
      + this.cascades.reduce((sum, level) => {
        const image = level.projected.image as { width: number; height: number; depth: number };
        return sum + image.width * image.height * image.depth * 8;
      }, 0)
      + this.lightData.byteLength + (this.environmentProjection?.allocatedBytes ?? 0)
      + (scratch ? scratch.width * scratch.height * scratch.depth * 8 : 0);
    this.statistics.updates++;
    this.forceUpdate = false;
  }

  /** Detach one shared consumer. The grid itself remains externally owned. */
  release(owner: object): void {
    if (this.sources.delete(owner)) { this.forceUpdate = true; this.sourceKey = ''; this.invalidatePrograms(); }
  }

  /** Sample directional incoming radiance; full scattering uses all bins with HG phase weights below. */
  sampleGPU(position: Node<'vec3'>, direction: Node<'vec3'>): Node<'vec3'> {
    const level = this.cascades[0];
    const uv = this.probeUV(level, position);
    return Fn(() => {
      const sum = vec3(0).toVar(), weights = float(0).toVar();
      level.directions.forEach((bin, index) => {
        const weight = pow(direction.dot(vec3(bin)).max(0), Math.max(1, level.directions.length / 2));
        sum.addAssign(this.readBin(this.finalRead, level, uv, index).xyz.mul(weight));
        weights.addAssign(weight);
      });
      return sum.div(weights.max(1e-6));
    })();
  }

  /** Phase-weight incoming bins at shading time only. cameraRayDirection points from camera into the volume.
   * Bins are directions TO light, so positive HG g favors the continuation of photon travel.
   */
  sampleScatteringGPU(position: Node<'vec3'>, cameraRayDirection: Node<'vec3'>,
    anisotropy: Node<'float'>): Node<'vec3'> {
    const level = this.cascades[0];
    return Fn(() => {
      const uv = this.probeUV(level, position).toVar();
      const result = vec3(0).toVar();
      level.directions.forEach((bin, index) => {
        // Bins point toward incoming light sources. The ray points camera -> sample, so both
        // directions must be negated to compare photon travel against sample -> camera.
        const lightTravel = vec3(bin).negate(), outgoing = cameraRayDirection.negate();
        const cosine = lightTravel.dot(outgoing);
        const phase = float(1).sub(anisotropy.mul(anisotropy))
          .div(pow(float(1).add(anisotropy.mul(anisotropy)).sub(anisotropy.mul(cosine).mul(2)), 1.5));
        result.addAssign(this.readBin(this.finalRead, level, uv, index).xyz.mul(phase));
      });
      return result.div(level.directions.length);
    })();
  }

  /** Exact isotropic integration, pre-averaged per probe instead of fetching every bin per ray sample. */
  sampleIsotropicGPU(position: Node<'vec3'>): Node<'vec3'> {
    const level = this.cascades[0];
    return level.meanRead.sample(this.probeUV(level, position)).level(float(0)).xyz;
  }

  private updateIsotropic(renderer: WebGPURenderer): void {
    const level = this.cascades[0];
    this.isotropicNode ??= Fn(() => {
      const { coordinate } = this.address(level);
      const mean = vec3(0).toVar();
      for (let bin = 0; bin < level.directions.length; bin++) {
        mean.addAssign(level.mergedRead.load(ivec3(coordinate.xy,
          coordinate.z.add(int(level.dimensionsNode.z).mul(bin)))).xyz.div(level.directions.length));
      }
      textureStore(level.meanWrite, coordinate, vec4(mean, 1)).toWriteOnly();
    })().compute(1).setName('rzmps.lighting.isotropic');
    this.isotropicNode.count = level.dimensions.x * level.dimensions.y * level.dimensions.z;
    this.benchmarks.span('isotropic', () => renderer.compute(this.isotropicNode!));
  }

  dispose(): void {
    if (this.disposed) return;
    this.invalidatePrograms();
    this.cascades.forEach(level => {
      level.local.dispose(); level.merged.dispose(); level.mean.dispose(); level.projected.dispose();
    });
    this.lightTexture.dispose(); this.scatterTexture?.dispose(); this.collection.dispose(); this.sources.clear();
    this.admittedLights.clear();
    this.environmentProjection?.dispose();
    this.benchmarks.dispose(); this.disposed = true;
  }

  private configure(domain: THREE.Box3): void {
    const counts = typeof this.directions === 'number'
      ? Array.from({ length: this.levels }, (_, i) => this.directions as number * 2 ** i) : [...this.directions];
    if (!Number.isInteger(this.levels) || this.levels < 1 || this.levels > 6 || counts.length !== this.levels
      || counts.some(n => !Number.isInteger(n) || n < 2 || n > 256)
      || !(this.levelScale > 1) || !Number.isFinite(this.levelScale)
      || !Number.isInteger(this.samplesPerInterval) || this.samplesPerInterval < 1 || this.samplesPerInterval > 32
      || !Number.isInteger(this.scatteringIterations) || this.scatteringIterations < 0 || this.scatteringIterations > 8
      || !Number.isFinite(this.environmentIntensity) || this.environmentIntensity < 0) {
      throw new RangeError('Invalid LightingGrid cascade, directional, sampling or environment configuration.');
    }
    const margin = boundsVector(this.margin, 0);
    if (margin.toArray().some(n => !Number.isFinite(n) || n < 0)) throw new RangeError('Lighting margin must be >= 0.');
    this.bounds.copy(SpatialGrid.normalizeBounds(domain, false)).expandByVector(margin);
    const requestedSize = this.bounds.getSize(new THREE.Vector3()).max(new THREE.Vector3(1e-6, 1e-6, 1e-6));
    const reference = 2 ** Math.ceil(Math.log2(Math.max(requestedSize.x, requestedSize.y, requestedSize.z)));
    let spacing = this.cellSize ?? reference / 8;
    if (!(spacing > 0) || !Number.isFinite(spacing)) {
      throw new RangeError('Lighting cellSize must be finite and positive.');
    }
    const requested = this.bounds.clone();
    // Keep every cascade on the same world lattice when a logical face grows. Normalizing each
    // rectangle independently slides all probes and changes interpolation on otherwise static gas.
    let dimensions: THREE.Vector3[];
    let fits = false;
    do {
      const alignment = spacing * this.levelScale ** (this.levels - 1);
      this.bounds.copy(requested);
      this.bounds.min.divideScalar(alignment).floor().multiplyScalar(alignment);
      this.bounds.max.divideScalar(alignment).ceil().multiplyScalar(alignment);
      const extent = this.bounds.getSize(new THREE.Vector3());
      dimensions = counts.map((_, i) => extent.clone().divideScalar(spacing * this.levelScale ** i).ceil()
        .max(new THREE.Vector3(1, 1, 1)));
      fits = dimensions.every((d, i) => Math.max(d.x, d.y, d.z * counts[i]) <= 2048);
      if (fits) break;
      // A valid growing gas domain must not abort the display loop at the packed-Z limit.
      spacing *= 2;
    } while (!fits);
    this.statistics.probeSpacing = spacing;
    const size = this.bounds.getSize(new THREE.Vector3());
    const distance = this.maxDistance ?? 2 ** Math.ceil(Math.log2(size.length()));
    if (!(spacing > 0) || !Number.isFinite(spacing) || !(distance > 0) || !Number.isFinite(distance)) {
      throw new RangeError('Lighting cellSize/maxDistance must be finite and positive.');
    }
    const structural = `${counts.join(',')}:${this.samplesPerInterval}`;
    if (structural !== this.layoutKey) {
      this.invalidatePrograms();
      this.cascades.forEach(level => {
        level.local.dispose(); level.merged.dispose(); level.mean.dispose(); level.projected.dispose();
      });
      this.cascades = counts.map((count, i) => this.createCascade(dimensions[i], count));
      this.layoutKey = structural; this.version++; this.forceUpdate = true;
    }
    this.minimum.value.copy(this.bounds.min); this.size.value.copy(size);
    const total = (this.levelScale ** this.levels - 1) / (this.levelScale - 1);
    let start = 0;
    this.statistics.probes = this.statistics.directionalEntries = this.statistics.memoryBytes = 0;
    this.cascades.forEach((level, i) => {
      if (!level.dimensions.equals(dimensions[i])) {
        level.dimensions.copy(dimensions[i]);
        level.dimensionsNode.value.copy(dimensions[i]);
        const old = [level.local, level.merged, level.mean, level.projected];
        level.local = this.createTexture(dimensions[i], level.directions.length);
        level.merged = this.createTexture(dimensions[i], level.directions.length);
        level.mean = this.createTexture(dimensions[i], 1);
        level.projected = this.createTexture(dimensions[i].clone().divideScalar(this.levelScale).ceil(),
          level.directions.length);
        level.projectedRead.value = level.projectedWrite.value = level.projected;
        level.localRead.value = level.localWrite.value = level.local;
        level.mergedRead.value = level.mergedWrite.value = level.merged;
        level.meanRead.value = level.meanWrite.value = level.mean;
        old.forEach(texture => texture.dispose());
        this.forceUpdate = true;
      }
      const end = start + distance * this.levelScale ** i / total;
      if (level.interval.value.x !== start || level.interval.value.y !== end) this.forceUpdate = true;
      level.interval.value.set(start, end); start = end;
      const probes = dimensions[i].x * dimensions[i].y * dimensions[i].z;
      this.statistics.probes += probes;
      this.statistics.directionalEntries += probes * level.directions.length;
      this.statistics.memoryBytes += probes * (level.directions.length * 2 + 1) * 8;
      if (level.injection) level.injection.count = probes * level.directions.length;
      if (level.merge) level.merge.count = probes * level.directions.length;
      if (level.projection) level.projection.count = dimensions[i].clone().divideScalar(this.levelScale)
        .ceil().toArray().reduce((a, b) => a * b, level.directions.length);
    });
  }

  private createTexture(dimensions: THREE.Vector3, directions: number): Storage3DTexture {
    const result = new Storage3DTexture(dimensions.x, dimensions.y, dimensions.z * directions);
    result.type = THREE.HalfFloatType;
    result.minFilter = result.magFilter = THREE.LinearFilter;
    return result;
  }

  private createCascade(dimensions: THREE.Vector3, count: number): Cascade {
    const local = this.createTexture(dimensions, count), merged = this.createTexture(dimensions, count);
    const mean = this.createTexture(dimensions, 1);
    const projected = this.createTexture(dimensions.clone().divideScalar(this.levelScale).ceil(), count);
    return { directions: fibonacciDirections(count), dimensions: dimensions.clone(),
      dimensionsNode: uniform(dimensions),
      interval: uniform(new THREE.Vector2()), local, merged, mean, projected,
      projectedRead: texture3D(projected), projectedWrite: storageTexture(projected),
      meanRead: texture3D(mean), meanWrite: storageTexture(mean),
      localRead: texture3D(local), mergedRead: texture3D(merged),
      localWrite: storageTexture(local), mergedWrite: storageTexture(merged) };
  }

  private probeUV(level: Cascade, position: Node<'vec3'>): Node<'vec3'> {
    return position.sub(this.minimum).div(this.size)
      .clamp(vec3(0.5).div(level.dimensionsNode), vec3(1).sub(vec3(0.5).div(level.dimensionsNode)));
  }

  private readBin(node: ReturnType<typeof texture3D>, level: Cascade, uv: Node<'vec3'>, index: number | Node) {
    const bin = typeof index === 'number' ? float(index) : float(index as Node<'int'>);
    return node.sample(vec3(uv.xy, uv.z.add(bin).div(level.directions.length))).level(float(0));
  }

  private address(level: Cascade) {
    const dims = level.dimensionsNode;
    const probes = uint(dims.x.mul(dims.y).mul(dims.z));
    const bin = int(instanceIndex.div(probes));
    const slot = instanceIndex.mod(probes);
    const coordinate = ivec3(int(slot.mod(uint(dims.x))), int(slot.div(uint(dims.x)).mod(uint(dims.y))),
      int(slot.div(uint(dims.x.mul(dims.y)))));
    const position = vec3(coordinate).add(0.5).div(dims).mul(this.size).add(this.minimum);
    return { bin, coordinate, position, output: ivec3(coordinate.xy, coordinate.z.add(bin.mul(int(dims.z)))) };
  }

  private extinction(position: Node<'vec3'>): Node<'float'> {
    return Fn(() => {
      const result = float(0).toVar();
      for (const input of this.sources.values()) {
        const minimum = input.minimum, maximum = input.maximum;
        If(position.greaterThanEqual(minimum).all().and(position.lessThanEqual(maximum).all()), () => {
          result.addAssign(input.source.extinctionGPU(position).max(0));
        });
      }
      return result;
    })();
  }

  private buildPrograms(): void {
    this.cascades.forEach((level, index) => {
      const count = level.dimensions.x * level.dimensions.y * level.dimensions.z * level.directions.length;
      const bins = array(level.directions.map(direction => vec3(direction)));
      const last = index === this.cascades.length - 1;
      level.injection ??= Fn(() => {
        const { bin, position, output } = this.address(level);
        const direction = bins.element(bin);
        const interval = level.interval;
        const step = interval.y.sub(interval.x).div(this.samplesPerInterval);
        const opticalDepth = float(0).toVar();
        for (let sample = 0; sample < this.samplesPerInterval; sample++) {
          opticalDepth.addAssign(this.extinction(position.add(direction.mul(interval.x.add(step.mul(sample + 0.5)))))
            .mul(step));
        }
        const transmission = opticalDepth.negate().exp();
        const radiance = vec3(0).toVar();
        Loop({ start: 0, end: this.lightCount, type: 'int' }, ({ i }) => {
          const record = (column: number) => this.lightsNode.load(ivec3(column, i, 0).xy);
          const p = record(0), axis = record(1), color = record(2), cone = record(3);
          const delta = p.xyz.sub(position);
          const distance = delta.length().max(1e-4);
          const directional = cone.z.equal(0);
          const lightDirection = directional.select(axis.xyz, delta.div(distance));
          // Directional lights terminate at the far field; the last interval also admits farther point lights.
          // Overlap adjacent shells instead of moving a light between disjoint probe lattices
          // in one update. The shell weights form a partition of unity in world-space distance.
          const lowerWidth = interval.x.mul(0.4).max(1e-4);
          const upperWidth = interval.y.mul(0.4).max(1e-4);
          const lower = index === 0 ? float(1)
            : smoothstep(interval.x.sub(lowerWidth), interval.x.add(lowerWidth), distance);
          const upper = last ? float(0)
            : smoothstep(interval.y.sub(upperWidth), interval.y.add(upperWidth), distance);
          const shellWeight = directional.select(float(last ? 1 : 0), lower.sub(upper).max(0));
          const admitted = shellWeight.greaterThan(0);
          If(admitted, () => {
            let attenuation = directional.select(float(1), float(1).div(pow(distance, axis.w).max(0.01)));
            attenuation = attenuation.mul(p.w.greaterThan(0).and(directional.not()).select(
              float(1).div(pow(float(1).add(pow(distance.div(p.w), 4)), 2)), float(1)));
            const spot = smoothstep(cone.x, cone.y.max(cone.x.add(1e-6)), lightDirection.dot(axis.xyz));
            attenuation = attenuation.mul(cone.z.equal(2).select(spot, 1));
            const exponent = Math.max(1, level.directions.length / 2);
            const norm = float(0).toVar();
            level.directions.forEach(binDirection => {
              norm.addAssign(pow(lightDirection.dot(vec3(binDirection)).max(0), exponent));
            });
            const weight = pow(lightDirection.dot(direction).max(0), exponent)
              .div(norm.max(1e-6)).mul(level.directions.length);
            const fraction = directional.select(float(1), distance.sub(interval.x).div(interval.y.sub(interval.x))
              .clamp(0, 1));
            radiance.addAssign(color.xyz.mul(attenuation).mul(weight).mul(shellWeight)
              .mul(opticalDepth.mul(fraction).negate().exp()));
          });
        });
        if (last && this.farField) radiance.addAssign(this.farField(position, direction)
          .mul(this.environmentGain).mul(transmission));
        textureStore(level.localWrite, output, vec4(radiance, transmission)).toWriteOnly();
      })().compute(count).setName(`rzmps.lighting.injection.${index}`);

      const coarseLevel = this.cascades[index + 1];
      const transfer = coarseLevel && !level.merge
        ? array(directionTransfer(level.directions, coarseLevel.directions).flat().map(value => float(value)))
        : undefined;
      // Angular mixing is linear and commutes with trilinear interpolation. Evaluate it once
      // at coarse probes, then use one spatial sample per fine bin instead of N coarse-bin samples.
      if (coarseLevel && !level.projection) {
        level.projection = Fn(() => {
          const { coordinate, output, bin } = this.address({ ...level,
            dimensionsNode: coarseLevel.dimensionsNode });
          const far = vec4(0).toVar();
          Loop(coarseLevel.directions.length, ({ i }) => {
            const weight = transfer!.element(bin.mul(coarseLevel.directions.length).add(i));
            const address = ivec3(coordinate.xy, coordinate.z.add(i.mul(int(coarseLevel.dimensionsNode.z))));
            far.addAssign(coarseLevel.mergedRead.load(address).mul(weight));
          });
          textureStore(level.projectedWrite, output, far).toWriteOnly();
        })().compute(coarseLevel.dimensions.x * coarseLevel.dimensions.y * coarseLevel.dimensions.z
          * level.directions.length).setName(`rzmps.lighting.angularTransfer.${index}`);
      }

      level.merge ??= Fn(() => {
        const { position, output, bin } = this.address(level);
        const local = level.localRead.load(output);
        const radiance = local.xyz.toVar(), transmission = local.w.toVar();
        if (!last) {
          const coarse = this.cascades[index + 1];
          const uv = this.probeUV(coarse, position);
          const far = level.projectedRead.sample(vec3(uv.xy,
            uv.z.add(float(bin)).div(level.directions.length))).level(float(0));
          radiance.addAssign(local.w.mul(far.xyz));
          transmission.mulAssign(far.w);
        }
        // AmbientLight is unoccluded irradiance in Three.js, not a distant point emitter.
        if (index === 0) radiance.addAssign(this.ambientNode);
        textureStore(level.mergedWrite, output, vec4(radiance, transmission)).toWriteOnly();
      })().compute(count).setName(`rzmps.lighting.merge.${index}`);
    });
  }

  private updateInputs(scene: THREE.Scene, lights: THREE.Light[]): string {
    const available = new Set(this.collection.lights);
    for (const light of this.admittedLights) if (!available.has(light)) this.admittedLights.delete(light);
    const selected = this.includeSceneLights ? lights.filter(light => {
      if (light instanceof THREE.DirectionalLight) return true;
      if (!(light instanceof THREE.PointLight || light instanceof THREE.SpotLight)) return false;
      const admitted = this.admittedLights.has(light) || light.distance <= 0
        || this.bounds.distanceToPoint(light.getWorldPosition(new THREE.Vector3())) <= light.distance;
      if (admitted) this.admittedLights.add(light);
      return admitted;
    }) : [];
    if (selected.length > this.lightTexture.image.height) {
      this.lightTexture.dispose();
      const capacity = 2 ** Math.ceil(Math.log2(selected.length));
      this.lightData = new Float32Array(capacity * 5 * 4);
      this.lightTexture = new THREE.DataTexture(this.lightData, 5, capacity, THREE.RGBAFormat, THREE.FloatType);
      this.lightTexture.generateMipmaps = false;
      this.lightsNode.value = this.lightTexture;
    }
    const records: number[] = [];
    for (const light of selected) {
      const position = light.getWorldPosition(new THREE.Vector3());
      const axis = new THREE.Vector3(), target = new THREE.Vector3();
      if (light instanceof THREE.DirectionalLight || light instanceof THREE.SpotLight) {
        light.target.updateWorldMatrix(true, false); light.target.getWorldPosition(target);
        axis.copy(position).sub(target).normalize();
      }
      const local = light as THREE.PointLight;
      const spot = light as THREE.SpotLight;
      records.push(position.x, position.y, position.z, local.distance ?? 0,
        axis.x, axis.y, axis.z, local.decay ?? 0,
        light.color.r * light.intensity, light.color.g * light.intensity, light.color.b * light.intensity, 0,
        light instanceof THREE.SpotLight ? Math.cos(spot.angle) : -1,
        light instanceof THREE.SpotLight ? Math.cos(spot.angle * (1 - spot.penumbra)) : 0,
        light instanceof THREE.DirectionalLight ? 0 : light instanceof THREE.SpotLight ? 2 : 1, 0,
        0, 0, 0, 0);
    }
    this.statistics.lights = selected.length;
    this.lightCount.value = selected.length;
    this.environmentGain.value = this.environmentIntensity;
    this.lightData.set(records);
    const farKey = this.configureFarField(scene, lights);
    const ambient = this.includeSceneLights ? lights.filter(light => light instanceof THREE.AmbientLight) : [];
    this.ambientNode.value.set(0, 0, 0);
    ambient.forEach(light => {
      this.ambientNode.value.addScaledVector(new THREE.Vector3(light.color.r, light.color.g, light.color.b),
        light.intensity);
    });
    if (!ambient.length && !this.farField) this.ambientNode.value.set(this.ambient.r, this.ambient.g, this.ambient.b);
    const key = [records.join(','), farKey, this.environmentIntensity, ...this.ambientNode.value.toArray()].join(':');
    if (key !== this.lightKey || this.forceUpdate) { this.lightTexture.needsUpdate = true; this.lightKey = key; }
    return key;
  }

  private configureFarField(scene: THREE.Scene, lights: THREE.Light[]): string {
    const grid = lights.find(light => (light as ProbeGrid).isLightProbeGrid && (light as ProbeGrid).texture) as
      ProbeGrid | undefined;
    const probes = lights.filter(light => light instanceof THREE.LightProbe) as THREE.LightProbe[];
    const environment = this.environment === undefined ? scene.environment : this.environment;
    this.environmentSceneGain.value = this.environment === undefined ? scene.environmentIntensity : 1;
    this.environmentRotation.value.setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(scene.environmentRotation)
      .invert());
    const kind = grid ? `grid:${grid.texture!.uuid}` : probes.length ? 'sh'
      : environment instanceof THREE.CubeTexture ? `cube:${environment.uuid}`
      : environment?.mapping === THREE.EquirectangularReflectionMapping ? `equirect:${environment.uuid}` : 'ambient';
    if (kind !== this.farFieldKey) {
      this.farFieldKey = kind; this.invalidatePrograms();
      this.environmentProjection?.dispose(); this.environmentProjection = undefined;
      if (grid) {
        const atlas = texture3D(grid.texture!);
        const min = uniform(grid.boundingBox.min.clone()), max = uniform(grid.boundingBox.max.clone());
        const res = uniform(grid.resolution.clone()), intensity = uniform(grid.intensity);
        this.farGridUniforms = { min, max, res, intensity };
        this.farField = (position, direction) => {
          const uv = position.sub(min).div(max.sub(min)).clamp(0, 1)
            .mul(res.sub(1)).add(0.5).div(res);
          const padded = res.z.add(2), depth = padded.mul(7);
          const read = (i: number) => atlas.sample(vec3(uv.xy,
            uv.z.mul(res.z).add(1).add(padded.mul(i)).div(depth))).level(float(0));
          const s = Array.from({ length: 7 }, (_, i) => read(i));
          return shRadianceGPU([s[0].xyz, vec3(s[0].w, s[1].xy), vec3(s[1].zw, s[2].x), s[2].yzw,
            s[3].xyz, vec3(s[3].w, s[4].xy), vec3(s[4].zw, s[5].x), s[5].yzw, s[6].xyz], direction)
            .mul(intensity);
        };
      } else if (probes.length) this.farField = (_position, direction) => shRadianceGPU(this.probeSH, direction);
      else if (kind.startsWith('cube:') || kind.startsWith('equirect:')) {
        const projection = new EnvironmentSH(environment!);
        this.environmentProjection = projection;
        this.farField = (_position, direction) => projection.sample(this.environmentRotation.mul(direction))
          .mul(this.environmentSceneGain);
      } else this.farField = undefined;
    }
    if (grid && this.farGridUniforms) {
      this.farGridUniforms.min.value.copy(grid.boundingBox.min);
      this.farGridUniforms.max.value.copy(grid.boundingBox.max);
      this.farGridUniforms.res.value.copy(grid.resolution);
      this.farGridUniforms.intensity.value = grid.intensity;
    }
    this.probeSH.forEach((node, i) => {
      node.value.set(0, 0, 0);
      probes.forEach(probe => node.value.addScaledVector(probe.sh.coefficients[i], probe.intensity));
    });
    return [kind, grid?.texture?.version, grid?.intensity, grid?.boundingBox.min.toArray(),
      grid?.boundingBox.max.toArray(), environment?.version, this.environmentSceneGain.value,
      ...scene.environmentRotation.toArray(),
      ...this.probeSH.flatMap(node => node.value.toArray())].join(':');
  }

  private applyScattering(renderer: WebGPURenderer): void {
    if (!this.scatteringIterations) return;
    const level = this.cascades[0], d = level.dimensions, count = level.directions.length;
    const image = this.scatterTexture?.image as { width: number; height: number; depth: number } | undefined;
    if (!image || image.width !== d.x || image.height !== d.y || image.depth !== d.z * count) {
      this.scatterTexture?.dispose(); this.scatterNode?.dispose(); this.scatterNode = undefined;
      this.scatterCopyNode?.dispose(); this.scatterCopyNode = undefined;
      this.scatterTexture = this.createTexture(d, count);
    }
    const input = texture3D(level.merged), output = storageTexture(this.scatterTexture!);
    this.scatterNode ??= Fn(() => {
      const { output: coordinate, position } = this.address(level);
      const uv = this.probeUV(level, position);
      const mean = vec3(0).toVar();
      for (let bin = 0; bin < count; bin++) mean.addAssign(this.readBin(input, level, uv, bin).xyz.div(count));
      const base = input.load(coordinate);
      const local = level.localRead.load(coordinate);
      textureStore(output, coordinate, vec4(base.xyz.add(mean.mul(float(1).sub(local.w)).mul(0.2)), base.w))
        .toWriteOnly();
    })().compute(d.x * d.y * d.z * count).setName('rzmps.lighting.scattering');
    const scratch = texture3D(this.scatterTexture!);
    this.scatterCopyNode ??= Fn(() => {
      const { output: coordinate } = this.address(level);
      textureStore(level.mergedWrite, coordinate, scratch.load(coordinate)).toWriteOnly();
    })().compute(d.x * d.y * d.z * count).setName('rzmps.lighting.scatteringMerge');
    // A compute copy works for native 3-D storage; Three's generic copy path treats depth as array layers.
    for (let iteration = 0; iteration < this.scatteringIterations; iteration++) {
      this.benchmarks.span('scattering', () => renderer.compute(this.scatterNode!));
      this.benchmarks.span('scatteringMerge', () => renderer.compute(this.scatterCopyNode!));
    }
    this.finalRead.value = level.merged;
  }

  private invalidatePrograms(): void {
    this.isotropicNode?.dispose(); this.isotropicNode = undefined;
    this.cascades.forEach(level => {
      level.injection?.dispose(); level.merge?.dispose(); level.projection?.dispose();
      level.injection = level.merge = level.projection = undefined;
    });
    this.scatterNode?.dispose(); this.scatterNode = undefined;
    this.scatterCopyNode?.dispose(); this.scatterCopyNode = undefined; this.forceUpdate = true;
  }
}
