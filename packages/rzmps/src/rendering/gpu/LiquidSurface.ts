import * as THREE from 'three';
import { initializeStorageAttribute } from '../../utils/gpu/storage.utils';
import type Benchmarks from '../../core/Benchmarks';
import { IndirectStorageBufferAttribute, StorageBufferAttribute, type ComputeNode, type Node } from 'three/webgpu';
import {
  Fn,
  If,
  atomicAdd,
  atomicLoad,
  atomicStore,
  float,
  instanceIndex,
  ivec3,
  max,
  mix,
  storage,
  uint,
  uniform,
  vec3,
  vec4,
  pow,
  smoothstep,
} from 'three/tsl';
import ParticleSpatialGrid, {
  type ParticleSpatialGridOptions,
  type ParticleSpatialGridRenderer,
} from '../../spatial/structures/ParticleSpatialGrid';
import {
  createEmptyGPUParticleBufferState,
  destroyGPUStorageAttribute,
  type GPUParticleBufferState,
  type GPUParticleRenderBufferState,
} from '../../simulation/gpu/Particle';
import SurfaceParticleKernels, { type SurfaceKernelOptions } from './SurfaceParticleKernels';
import { buildMarchingCubes } from './buildMarchingCubes';
import { buildSurfaceNets } from './buildSurfaceNets';
import { SurfaceExtraction } from '../../enums/SurfaceExtraction';
import SparseVolumeGrid from '../../spatial/structures/gpu/SparseVolumeGrid';

export type SurfaceVectorStorage = { element(index: Node | number): Node<'vec4'> };
type Vec4Storage = SurfaceVectorStorage;
type SurfaceIntegerStorage = { element(index: Node | number): Node<'uint'> };

/** GPU buffers and scalar field supplied to a surface extraction factory. */
export interface SurfaceExtractionContext {
  /** Sparse addressing and active-cell dispatch, without exposing pool implementation details. */
  grid: {
    readonly cellCount: number;
    readonly cellsPerAxis: number;
    coordinate(index: Node<'uint'>): Node<'ivec3'>;
    index(coordinate: Node<'ivec3'>): Node<'uint'>;
    compute(callback: (index: Node<'uint'>) => void): ComputeNode;
  };
  field: SurfaceVectorStorage;
  positions: SurfaceVectorStorage;
  indices: SurfaceIntegerStorage;
  topology: SurfaceIntegerStorage;
  counters: SurfaceIntegerStorage;
  smoothing: SurfaceVectorStorage;
  smoothingWeight: Node<'float'>;
  iso: Node<'float'>;
  minimum: Node<'vec3'>;
  cellSize: Node<'float'>;
  maximumTriangles: number;
}

/**
 * Build ordered GPU passes against the supplied sparse field and output buffers.
 * Increment counters[0] for requested triangles and counters[1] for generated vertices;
 * write only within maximumTriangles. Positions use xyz plus w=1 for valid vertices.
 * Triangle layout uses three consecutive vertices per triangle. Cell layout uses one
 * vertex per sparse cell. LiquidSurface owns shading, draw arguments and pass disposal.
 */
export interface SurfaceExtractor {
  (context: SurfaceExtractionContext): {
    nodes: ComputeNode[];
    smoothingNodes?: ComputeNode[];
    triangleMultiple?: number;
  };
  /** Defaults to triangle soup; set to cells for one vertex per sparse field cell. */
  vertexLayout?: 'cells' | 'triangles';
}

interface LiquidSurfaceOptions extends SurfaceKernelOptions {
  fieldSmoothingIterations: number;
  fieldSmoothing: number;
  fieldClosing: number;
  flowSmoothing: number;
  velocityDetailRange: [number, number];
  vorticityDetailRange: [number, number];
  benchmarks?: Benchmarks;
  bounds: THREE.Box3;
  voxelSize: number;
  maxActiveBricks: number;
  maxTriangles: number;
  spatialGridOptions: Partial<ParticleSpatialGridOptions>;
}

// Binary corner numbering: x + 2*y + 4*z. Each primal edge belongs to its lower corner.
const corners = Array.from({ length: 8 }, (_, i) => [i & 1, (i >> 1) & 1, (i >> 2) & 1]);

/** GPU-only particle field reconstruction with replaceable surface extraction. @internal */
export default class LiquidSurface {
  readonly geometry = new THREE.BufferGeometry();
  readonly grid: SparseVolumeGrid;
  readonly bounds: THREE.Box3;
  readonly fieldAttribute: StorageBufferAttribute;
  readonly flowAttribute: StorageBufferAttribute;
  readonly vorticityAttribute: StorageBufferAttribute;
  private readonly fieldScratchAttribute: StorageBufferAttribute;
  private readonly fieldScratch: Vec4Storage;
  private readonly flow: Vec4Storage;
  private readonly curl: Vec4Storage;
  private readonly vertexFlow: Vec4Storage;
  private readonly vertexCurl: Vec4Storage;
  private readonly kernels: SurfaceParticleKernels;
  private kernelAttribute?: StorageBufferAttribute;
  private kernelNode?: ComputeNode;
  private kernelKey = '';
  private readonly filterStrength = uniform(0.15);
  private readonly closingStrength = uniform(0);
  private readonly flowSmoothing = uniform(0.75);
  private readonly velocityRange = uniform(new THREE.Vector2(0.5, 3));
  private readonly vorticityRange = uniform(new THREE.Vector2(1, 8));
  private readonly filterNodes: ComputeNode[] = [];
  private readonly curlNode: ComputeNode;
  readonly positionAttribute: StorageBufferAttribute;
  readonly normalAttribute: StorageBufferAttribute;
  readonly colorAttribute: StorageBufferAttribute;
  readonly indexAttribute: StorageBufferAttribute;
  readonly smoothingAttribute: StorageBufferAttribute;
  readonly topologyAttribute: StorageBufferAttribute;
  readonly countersAttribute = new StorageBufferAttribute(new Uint32Array(3), 1);
  readonly drawAttribute = new IndirectStorageBufferAttribute(new Uint32Array([0, 1, 0, 0, 0]), 1);
  private readonly field: Vec4Storage;
  private readonly positions: Vec4Storage;
  private readonly normals: Vec4Storage;
  private readonly colors: Vec4Storage;
  private readonly smoothing: Vec4Storage;
  private readonly topology;
  private readonly smoothingWeight = uniform(0.5);
  private readonly counters = storage(this.countersAttribute, 'uint', 3).toAtomic();
  private readonly queryGrid: ParticleSpatialGrid;
  private readonly projection = createEmptyGPUParticleBufferState(1);
  private readonly radiusScale = uniform(1);
  private readonly isoLevel = uniform(0.2);
  private readonly quality = uniform(1);
  private readonly tagMask = uniform(0, 'uint');
  private readonly filterTags = uniform(0, 'uint');
  private readonly scaleMultiplier = uniform(1);
  private copyNode?: ComputeNode;
  private copyKey = '';
  private copyBuffers?: GPUParticleBufferState | GPUParticleRenderBufferState;
  private fieldNode?: ComputeNode;
  private queryVersion = -1;
  private readonly resetNode: ComputeNode;
  private readonly extractionNodes: ComputeNode[];
  private readonly cellVertices: boolean;
  private readonly triangleMultiple: number;
  private readonly drawNode: ComputeNode;
  private readonly smoothNodes: ComputeNode[];
  private readonly shadingNode: ComputeNode;
  private readonly minimum: Node<'vec3'>;
  private readonly cellSize: Node<'float'>;

  constructor(
    private readonly options: LiquidSurfaceOptions,
    private readonly renderer: ParticleSpatialGridRenderer,
    private readonly legacy = false,
    extraction: SurfaceExtraction | `${SurfaceExtraction}` | SurfaceExtractor = SurfaceExtraction.SurfaceNets,
  ) {
    // Align independent reconstruction coverage to a fixed voxel lattice.
    const minimum = options.bounds.min.clone().divideScalar(options.voxelSize).floor();
    const maximum = options.bounds.max.clone().divideScalar(options.voxelSize).ceil();
    const extent = maximum.sub(minimum);
    const depth = Math.max(3, Math.ceil(Math.log2(Math.max(extent.x, extent.y, extent.z))));
    if (depth > 9) throw new RangeError('Surface bounds / voxelSize must fit within 512 cells per axis.');
    const side = 2 ** depth * options.voxelSize;
    this.bounds = new THREE.Box3(minimum.multiplyScalar(options.voxelSize), new THREE.Vector3());
    this.bounds.max.copy(this.bounds.min).addScalar(side);
    this.minimum = vec3(this.bounds.min);
    this.cellSize = float(options.voxelSize);
    this.grid = new SparseVolumeGrid({ brickSubdivisions: depth - 3, cellSubdivisions: 3 }, options.maxActiveBricks);
    this.queryGrid = new ParticleSpatialGrid({
      brickSubdivisions: 3,
      cellSubdivisions: 1,
      ...options.spatialGridOptions,
      timeQuality: 1,
    });
    const extractor =
      typeof extraction === 'function'
        ? extraction
        : extraction === SurfaceExtraction.MarchingCubes
          ? buildMarchingCubes
          : buildSurfaceNets;
    this.cellVertices = extractor.vertexLayout === 'cells';
    const vertexCount = this.cellVertices ? this.grid.cellCount : options.maxTriangles * 3;

    const attribute = (count = vertexCount) => new StorageBufferAttribute(new Float32Array(count * 4), 4);
    // One binding contains scalar/color, weighted velocity/support, and reconstructed curl.
    this.fieldAttribute = attribute(this.grid.cellCount * 3);
    this.fieldScratchAttribute = attribute(this.grid.cellCount * 3);
    this.flowAttribute = attribute();
    this.vorticityAttribute = attribute();
    this.kernels = new SurfaceParticleKernels(options.voxelSize);
    this.positionAttribute = attribute();
    this.normalAttribute = attribute();
    this.colorAttribute = attribute();
    this.smoothingAttribute = attribute();
    this.topologyAttribute = new StorageBufferAttribute(new Uint32Array(this.grid.cellCount * 2), 1);
    this.indexAttribute = new StorageBufferAttribute(new Uint32Array(options.maxTriangles * 3), 1);
    const vector = (value: StorageBufferAttribute) => storage(value, 'vec4', value.count) as Vec4Storage;
    this.field = vector(this.fieldAttribute);
    this.fieldScratch = vector(this.fieldScratchAttribute);
    this.flow = this.plane(this.field, 1);
    this.curl = this.plane(this.field, 2);
    this.vertexFlow = vector(this.flowAttribute);
    this.vertexCurl = vector(this.vorticityAttribute);
    this.positions = vector(this.positionAttribute);
    this.normals = vector(this.normalAttribute);
    this.colors = vector(this.colorAttribute);
    this.smoothing = vector(this.smoothingAttribute);
    this.topology = storage(this.topologyAttribute, 'uint', this.grid.cellCount * 2).toAtomic();
    this.geometry.setAttribute('position', this.positionAttribute);
    this.geometry.setAttribute('normal', this.normalAttribute);
    this.geometry.setAttribute('color', this.colorAttribute);
    this.geometry.setAttribute('surfaceVelocity', this.flowAttribute);
    this.geometry.setAttribute('surfaceVorticity', this.vorticityAttribute);
    this.geometry.setIndex(this.indexAttribute);
    this.geometry.indirect = this.drawAttribute;
    // Storage-created index buffers otherwise lack INDEX usage when first drawn.
    const backend = renderer.backend as { createIndexAttribute(attribute: StorageBufferAttribute): void };
    backend.createIndexAttribute(this.indexAttribute);
    this.resetNode = Fn(() => {
      atomicStore(this.counters.element(instanceIndex), uint(0));
    })().compute(3);
    // Extractors own algorithm passes; this owner supplies storage and final shading.
    const result = extractor({
      grid: this.grid,
      field: this.field,
      positions: this.positions,
      indices: storage(this.indexAttribute, 'uint', this.indexAttribute.count),
      topology: this.topology,
      smoothing: this.smoothing,
      smoothingWeight: this.smoothingWeight,
      counters: this.counters,
      iso: this.isoLevel,
      maximumTriangles: options.maxTriangles,
      minimum: this.minimum,
      cellSize: this.cellSize,
    });
    this.extractionNodes = result.nodes;
    this.smoothNodes = result.smoothingNodes ?? [];
    this.triangleMultiple = result.triangleMultiple ?? 1;

    this.filterNodes = [
      this.buildFilter(this.field, this.fieldScratch, 'dilate'),
      this.buildFilter(this.fieldScratch, this.field, 'erode'),
      this.buildFilter(this.field, this.fieldScratch, 'smooth'),
      this.buildFilter(this.fieldScratch, this.field, 'compensate'),
    ];
    this.curlNode = this.grid.compute(index => this.reconstructCurl(index));
    this.shadingNode = !this.cellVertices
      ? Fn(() => {
          If(
            instanceIndex
              .lessThan(atomicLoad(this.counters.element(0)).mul(3))
              .and(instanceIndex.lessThan(vertexCount)),
            () => this.rebuildShading(instanceIndex),
          );
        })().compute(vertexCount)
      : this.grid.compute(index => {
          If(this.positions.element(index).w.greaterThan(0), () => this.rebuildShading(index));
        });
    const args = storage(this.drawAttribute, 'uint', 5);
    this.drawNode = Fn(() => {
      const count = atomicLoad(this.counters.element(0)).toVar();
      const limit = uint(Math.floor(options.maxTriangles / this.triangleMultiple) * this.triangleMultiple);
      args.element(0).assign(count.lessThan(limit).select(count, limit).mul(3));
    })().compute(1);
  }

  /** Upload and compile a separate visual reconstruction without advancing the particle system. */
  async prepare(update: () => void): Promise<void> {
    for (const attribute of [this.fieldAttribute, this.fieldScratchAttribute, this.positionAttribute,
      this.normalAttribute, this.colorAttribute, this.flowAttribute, this.vorticityAttribute,
      this.smoothingAttribute, this.topologyAttribute, this.indexAttribute]) {
      initializeStorageAttribute(this.renderer, attribute);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const nodes: ComputeNode[] = [], compute = this.renderer.compute;
    this.renderer.compute = node => { nodes.push(...(Array.isArray(node) ? node : [node])); };
    try { update(); } finally { this.renderer.compute = compute; }
    const compiler = this.renderer as ParticleSpatialGridRenderer & {
      compileComputeAsync(nodes: ComputeNode[]): Promise<void>;
    };
    await compiler.compileComputeAsync([...new Set(nodes)]);
  }

  update(
    buffers: GPUParticleBufferState | GPUParticleRenderBufferState,
    radiusScale: number,
    isoLevel: number,
    tagMask: number | undefined,
    quality: number,
    scaleMultiplier: number,
    smoothingIterations: number,
    smoothingStrength: number,
  ): void {
    this.radiusScale.value = radiusScale;
    this.kernels.sync(this.options, isoLevel);
    this.filterStrength.value = this.options.fieldSmoothing;
    this.closingStrength.value = this.options.fieldClosing;
    this.flowSmoothing.value = this.options.flowSmoothing;
    this.velocityRange.value.fromArray(this.options.velocityDetailRange);
    this.vorticityRange.value.fromArray(this.options.vorticityDetailRange);
    this.isoLevel.value = isoLevel;
    this.quality.value = quality;
    this.tagMask.value = tagMask ?? 0;
    this.filterTags.value = tagMask === undefined ? 0 : 1;
    this.scaleMultiplier.value = scaleMultiplier;
    this.renderer.compute(this.resetNode);
    // A canonical query view lets the existing spatial hash index transient/child particles too.
    this.projection.initialize(this.renderer);
    this.projection.grow(this.renderer, buffers.capacity);
    this.projection.count = buffers.count;
    this.projection.initialize(this.renderer);
    const key = [buffers.version, this.projection.version, this.legacy].join('|');
    if (key !== this.copyKey || buffers !== this.copyBuffers) {
      this.copyNode?.dispose();
      this.copyKey = key;
      this.copyBuffers = buffers;
      this.copyNode = Fn(() => {
        const source = buffers.storage.createParticle(instanceIndex);
        const target = this.projection.storage.createParticle(instanceIndex, true);
        const visualRadius = max(source.scale.x.abs(), max(source.scale.y.abs(), source.scale.z.abs()))
          .mul(this.radiusScale)
          .mul(this.scaleMultiplier)
          .mul(0.5);
        const radius = this.legacy
          ? visualRadius
          : max(visualRadius, this.options.voxelSize)
              .mul(this.kernels.influence)
              .mul(mix(float(1), this.kernels.maximumStretch, this.kernels.strength));
        const selected = source.alive
          .notEqual(0)
          .and(source.alpha.greaterThan(0))
          .and(visualRadius.greaterThan(0))
          .and(this.quality.greaterThan(0))
          .and(this.filterTags.equal(0).or(source.tagMask.bitAnd(this.tagMask).notEqual(0)));
        const inside = source.position
          .sub(radius)
          .greaterThanEqual(vec3(this.bounds.min))
          .all()
          .and(source.position.add(radius).lessThan(vec3(this.bounds.max).sub(this.cellSize)).all());
        If(selected.and(inside.not()), () => {
          atomicAdd(this.counters.element(2), uint(1));
        });
        const intersects = source.position
          .add(radius)
          .greaterThanEqual(vec3(this.bounds.min))
          .all()
          .and(source.position.sub(radius).lessThan(vec3(this.bounds.max)).all());
        // Keep overlapping kernels. Discarding an entire support sphere at a boundary creates visible popping.
        target.alive.assign(selected.and(intersects).select(uint(1), uint(0)));
        target.tagMask.assign(source.tagMask);
        target.generation.assign(source.generation);
        target.position.assign(source.position);
        target.scale.assign(vec3(radius.mul(2)));
        target.speed.assign(visualRadius);
        target.mass.assign(
          this.legacy ? radius : max(visualRadius, this.options.voxelSize).mul(this.kernels.influence),
        );
        target.color.assign(source.color);
        target.alpha.assign(source.alpha.max(0));
        target.velocity.assign(source.velocity);
        this.projection.storage.storeParticle(target);
      })().compute(buffers.count);
    }
    this.copyNode!.count = buffers.count;
    this.renderer.compute(this.copyNode!);
    this.queryGrid.rebuild(this.renderer, this.projection, {});
    const kernelKey = `${this.queryGrid.resourceVersion}:${this.options.anisotropy > 0}`;
    if (kernelKey !== this.kernelKey) {
      this.kernelNode?.dispose();
      if (this.kernelAttribute) destroyGPUStorageAttribute(this.renderer, this.kernelAttribute);
      this.kernelAttribute?.dispose();
      this.kernelAttribute = new StorageBufferAttribute(new Float32Array(this.projection.capacity * 12), 4);
      this.kernelNode = this.kernels.build(
        this.queryGrid,
        storage(this.kernelAttribute, 'vec4', this.projection.capacity * 3),
        this.options.anisotropy > 0,
      );
      this.kernelKey = kernelKey;
      this.queryVersion = -1;
    }
    if (!this.legacy) {
      this.kernelNode!.count = buffers.count;
      this.computeStage('anisotropy', () => this.renderer.compute(this.kernelNode!));
    }

    // Allocate every field page needed by compact support and filter dependencies.
    this.computeStage('surfaceBrickActivation', () => {
      this.grid.rebuild(
        { buffers: this.projection, deltaTimeNode: float(0) },
        this.renderer,
        undefined,
        undefined,
        this.minimum,
        this.cellSize,
        float(1),
        undefined,
        undefined,
        // One sample for extraction, then the actual scalar-filter dependency radius.
        // Curl and mesh smoothing read the field but do not expand its nonzero support.
        1 +
          (this.options.fieldSmoothing > 0 ? this.options.fieldSmoothingIterations * 2 : 0) +
          (this.options.fieldClosing > 0 ? 2 : 0),
      );
    });
    if (this.queryVersion !== this.queryGrid.resourceVersion) {
      this.fieldNode?.dispose();
      this.queryVersion = this.queryGrid.resourceVersion;
      const metrics = storage(this.kernelAttribute!, 'vec4', this.projection.capacity * 3);
      this.fieldNode = this.grid.compute(index => {
        const point = this.point(this.grid.coordinate(index));
        const total = float(0).toVar();
        const color = vec3(0).toVar();
        const velocity = vec3(0).toVar();
        const support = float(0).toVar();
        this.queryGrid.forEachParticleInRadius(point, this.queryGrid.getMaxParticleRadiusNode(), particle => {
          const row = particle.index.mul(3);
          const a = metrics.element(row),
            b = metrics.element(row.add(1)),
            c = metrics.element(row.add(2));
          const offset = point.sub(particle.position);
          const radius = this.legacy ? particle.mass : c.w;
          const local = this.legacy ? offset : vec3(offset.dot(a.xyz), offset.dot(b.xyz), offset.dot(c.xyz));
          const q = max(float(1).sub(local.lengthSq().div(max(radius.mul(radius), 1e-12))), 0);
          const weight = pow(q, 3)
            .mul(particle.alpha)
            .mul(this.legacy ? float(1) : a.w);
          total.addAssign(weight);
          color.addAssign(particle.color.mul(weight));
          velocity.addAssign(particle.velocity.mul(weight));
          support.addAssign(this.kernels.bulk(b.w).mul(weight));
        });
        this.field.element(index).assign(vec4(color, total));
        this.flow.element(index).assign(vec4(velocity, support));
      });
    }

    // Gather scalar, color and momentum once, then filter before extracting topology.
    this.computeStage('fieldReconstruction', () => this.renderer.compute(this.fieldNode!));
    if (
      !this.legacy &&
      this.options.fieldSmoothingIterations > 0 &&
      this.options.fieldSmoothing > 0 &&
      this.options.flowSmoothing > 0
    ) {
      this.computeStage('surfaceVorticity', () => this.renderer.compute(this.curlNode));
    }
    if (!this.legacy)
      this.computeStage('fieldFiltering', () => {
        if (this.options.fieldClosing > 0) this.filterNodes.slice(0, 2).forEach(node => this.renderer.compute(node));
        for (let i = 0; this.options.fieldSmoothing > 0 && i < this.options.fieldSmoothingIterations; i++) {
          this.filterNodes.slice(2).forEach(node => this.renderer.compute(node));
        }
      });
    this.computeStage('surfaceVorticity', () => this.renderer.compute(this.curlNode));

    // Run the selected topology builder against the same reconstructed field.
    this.computeStage('surfaceExtraction', () => {
      this.extractionNodes.forEach(node => this.renderer.compute(node));
    });
    if (this.smoothNodes.length > 0 && smoothingIterations > 0 && smoothingStrength > 0) {
      this.smoothingWeight.value = smoothingStrength * 0.5;
      this.computeStage('surfaceSmoothing', () => {
        for (let iteration = 0; iteration < smoothingIterations; iteration++) {
          this.smoothNodes.forEach(node => this.renderer.compute(node));
        }
      });
    }

    // Derive shared vertex attributes after extraction and optional mesh cleanup.
    this.computeStage('meshUpdate', () => {
      this.renderer.compute(this.shadingNode);
      this.renderer.compute(this.drawNode);
    });
  }

  private computeStage(name: string, callback: () => void): void {
    if (this.options.benchmarks) this.options.benchmarks.span(name, callback);
    else callback();
  }

  private point(coordinate: Node<'ivec3'>): Node<'vec3'> {
    return vec3(coordinate).mul(this.cellSize).add(this.minimum) as Node<'vec3'>;
  }

  private plane(field: Vec4Storage, plane: number): Vec4Storage {
    const offset = this.grid.cellCount * plane;
    return {
      element: index =>
        field.element(typeof index === 'number' ? index + offset : uint(index as Node<'uint'>).add(offset)),
    };
  }

  private interpolate(field: Vec4Storage, coordinate: Node<'vec3'>): Node<'vec4'> {
    const lower = ivec3(coordinate.floor());
    const fraction = coordinate.sub(vec3(lower));
    const total = vec4(0).toVar();
    corners.forEach(corner => {
      const weight = corner
        .map((bit, axis) =>
          bit
            ? fraction[['x', 'y', 'z'][axis] as 'x' | 'y' | 'z']
            : float(1).sub(fraction[['x', 'y', 'z'][axis] as 'x' | 'y' | 'z']),
        )
        .reduce((a, b) => a.mul(b));
      total.addAssign(field.element(this.grid.index(lower.add(ivec3(...corner)))).mul(weight));
    });
    return total;
  }

  private reconstructCurl(index: Node<'uint'>): void {
    const coordinate = this.grid.coordinate(index);
    const sample = (x: number, y: number, z: number) => {
      const address = this.grid.index(coordinate.add(ivec3(x, y, z)));
      const center = this.flow.element(index).xyz.div(this.field.element(index).w.max(1e-8));
      return this.field
        .element(address)
        .w.greaterThan(1e-8)
        .select(this.flow.element(address).xyz.div(this.field.element(address).w.max(1e-8)), center);
    };
    const dx = sample(1, 0, 0).sub(sample(-1, 0, 0));
    const dy = sample(0, 1, 0).sub(sample(0, -1, 0));
    const dz = sample(0, 0, 1).sub(sample(0, 0, -1));
    this.curl.element(index).assign(
      this.field
        .element(index)
        .w.greaterThan(1e-8)
        .select(vec4(vec3(dy.z.sub(dz.y), dz.x.sub(dx.z), dx.y.sub(dy.x)).div(this.cellSize.mul(2)), 0), vec4(0)),
    );
  }

  private buildFilter(source: Vec4Storage, target: Vec4Storage, mode: string): ComputeNode {
    const sourceFlow = this.plane(source, 1),
      targetFlow = this.plane(target, 1);
    return this.grid.compute(index => {
      const coordinate = this.grid.coordinate(index);
      const original = source.element(index).toVar();
      const originalFlow = sourceFlow.element(index).toVar();
      const total = vec4(0).toVar(),
        flow = vec4(0).toVar();
      const extreme = original.w.toVar();
      for (let axis = 0; axis < 3; axis++)
        for (const sign of [-1, 1]) {
          const offset = [0, 0, 0];
          offset[axis] = sign;
          const at = this.grid.index(coordinate.add(ivec3(...offset)));
          const value = source.element(at);
          total.addAssign(value);
          flow.addAssign(sourceFlow.element(at));
          if (mode === 'dilate') extreme.assign(max(extreme, value.w));
          if (mode === 'erode') extreme.assign(extreme.min(value.w));
        }
      if (mode === 'dilate' || mode === 'erode') {
        const amount = this.closingStrength;
        const scalar = mix(original.w, extreme, amount);
        // Morphology changes scalar support while borrowing neighboring color/momentum when needed.
        const basis = original.w.greaterThan(1e-8).select(original, total.div(6));
        const basisFlow = original.w.greaterThan(1e-8).select(originalFlow, flow.div(6));
        target.element(index).assign(vec4(basis.xyz, basis.w).mul(scalar.div(basis.w.max(1e-8))));
        targetFlow.element(index).assign(basisFlow.mul(scalar.div(basis.w.max(1e-8))));
      } else {
        const speed = originalFlow.xyz.div(original.w.max(1e-8)).length();
        const activity = max(
          smoothstep(this.velocityRange.x, this.velocityRange.y, speed),
          smoothstep(this.vorticityRange.x, this.vorticityRange.y, this.curl.element(index).xyz.length()),
        );
        const bulk = originalFlow.w.div(original.w.max(1e-8)).clamp(0, 1);
        const weight = this.filterStrength.mul(float(1).sub(activity.mul(this.flowSmoothing))).mul(bulk);
        const signed = mode === 'compensate' ? weight.negate().div(float(1).sub(weight.mul(0.1))) : weight;
        const filtered = original.add(total.div(6).sub(original).mul(signed));
        const filteredFlow = originalFlow.add(flow.div(6).sub(originalFlow).mul(signed));
        target
          .element(index)
          .assign(filtered.w.greaterThan(1e-8).select(vec4(filtered.xyz.max(0), filtered.w), vec4(0)));
        targetFlow.element(index).assign(filtered.w.greaterThan(1e-8).select(filteredFlow, vec4(0)));
      }
    });
  }

  private rebuildShading(index: Node<'uint'>): void {
    const position = this.positions.element(index).xyz;
    const coordinate = position
      .sub(this.minimum)
      .div(this.cellSize)
      .clamp(0, this.grid.cellsPerAxis - 2);
    const lower = ivec3(coordinate.floor());
    const fraction = coordinate.sub(vec3(lower));
    const color = vec4(0).toVar();
    const gradient = vec3(0).toVar();
    corners.forEach(corner => {
      const f = corner.map((bit, axis) =>
        bit
          ? fraction[['x', 'y', 'z'][axis] as 'x' | 'y' | 'z']
          : float(1).sub(fraction[['x', 'y', 'z'][axis] as 'x' | 'y' | 'z']),
      );
      const sample = this.field.element(this.grid.index(lower.add(ivec3(...corner))));
      color.addAssign(sample.mul(f[0].mul(f[1]).mul(f[2])));
      gradient.addAssign(
        vec3(
          f[1].mul(f[2]).mul(corner[0] ? -1 : 1),
          f[0].mul(f[2]).mul(corner[1] ? -1 : 1),
          f[0].mul(f[1]).mul(corner[2] ? -1 : 1),
        ).mul(sample.w),
      );
    });
    const flow = this.interpolate(this.flow, coordinate);
    const curl = this.interpolate(this.curl, coordinate);
    this.normals.element(index).assign(
      vec4(
        gradient
          .length()
          .greaterThan(1e-8)
          .select(gradient.div(gradient.length().max(1e-8)), vec3(0, 1, 0)),
        0,
      ),
    );
    this.colors.element(index).assign(vec4(color.xyz.div(color.w.max(1e-8)), 1));
    this.vertexFlow
      .element(index)
      .assign(vec4(flow.xyz.div(color.w.max(1e-8)), flow.w.div(color.w.max(1e-8)).clamp(0, 1)));
    this.vertexCurl.element(index).assign(vec4(curl.xyz, curl.xyz.length()));
  }

  clear(): void {
    this.renderer.compute(
      Fn(() => {
        storage(this.drawAttribute, 'uint', 5).element(0).assign(0);
      })().compute(1),
    );
  }

  async readDiagnostics(): Promise<{
    triangles: number;
    vertices: number;
    overflowedTriangles: number;
    clippedParticles: number;
    activeBricks: number;
    overflowedBricks: number;
    bounds: THREE.Box3;
    allocatedBytes: number;
  }> {
    const data = new Uint32Array(await this.renderer.getArrayBufferAsync(this.countersAttribute));
    const bricks = new Uint32Array(await this.renderer.getArrayBufferAsync(this.grid.diagnosticsAttribute));
    const maximum = Math.floor(this.options.maxTriangles / this.triangleMultiple) * this.triangleMultiple;
    return {
      triangles: Math.min(data[0], maximum),
      vertices: data[1],
      overflowedTriangles: Math.max(0, data[0] - maximum),
      clippedParticles: data[2],
      activeBricks: bricks[0],
      overflowedBricks: bricks[1],
      bounds: this.bounds.clone(),
      allocatedBytes: [
        this.fieldAttribute,
        this.fieldScratchAttribute,
        this.positionAttribute,
        this.normalAttribute,
        this.colorAttribute,
        this.flowAttribute,
        this.vorticityAttribute,
        this.smoothingAttribute,
        this.topologyAttribute,
        this.indexAttribute,
        this.kernelAttribute,
        this.countersAttribute,
        this.drawAttribute,
        this.projection.attributes.floatData,
        this.projection.attributes.uintData,
        ...Object.values(this.queryGrid).filter(value => value instanceof StorageBufferAttribute),
      ].reduce((sum, attribute) => sum + (attribute?.array.byteLength ?? 0), this.grid.allocatedBytes),
    };
  }

  dispose(): void {
    [
      this.copyNode,
      this.fieldNode,
      this.resetNode,
      ...this.extractionNodes,
      this.drawNode,
      ...this.smoothNodes,
      ...this.filterNodes,
      this.curlNode,
      this.kernelNode,
      this.shadingNode,
    ].forEach(node => node?.dispose());
    this.geometry.dispose();
    for (const attribute of [
      this.fieldAttribute,
      this.positionAttribute,
      this.normalAttribute,
      this.colorAttribute,
      this.indexAttribute,
      this.countersAttribute,
      this.drawAttribute,
      this.smoothingAttribute,
      this.topologyAttribute,
      this.kernelAttribute,
      this.fieldScratchAttribute,
      this.flowAttribute,
      this.vorticityAttribute,
    ]) {
      if (!attribute) continue;
      destroyGPUStorageAttribute(this.renderer, attribute);
      attribute.dispose();
    }
    this.projection.dispose(this.renderer);
    this.queryGrid.dispose(this.renderer);
    this.grid.dispose(this.renderer);
  }
}
