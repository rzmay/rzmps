import * as THREE from 'three';
import { IndirectStorageBufferAttribute, StorageBufferAttribute, type ComputeNode, type Node } from 'three/webgpu';
import {
  Fn, If, atomicAdd, atomicLoad, atomicOr, atomicStore, clamp, float, instanceIndex, ivec3, max, mix,
  storage, uint, uniform, vec3, vec4,
} from 'three/tsl';
import ParticleSpatialGrid, {
  type ParticleSpatialGridOptions, type ParticleSpatialGridRenderer,
} from '../../spatial/structures/ParticleSpatialGrid';
import {
  createEmptyGPUParticleBufferState, destroyGPUStorageAttribute,
  type GPUParticleBufferState, type GPUParticleRenderBufferState,
} from '../../simulation/gpu/Particle';
import SparseVolumeGrid from '../../spatial/structures/gpu/SparseVolumeGrid';

type Vec4Storage = { element(index: Node | number): Node<'vec4'> };

export interface LiquidSurfaceOptions {
  bounds: THREE.Box3;
  voxelSize: number;
  maxActiveBricks: number;
  maxTriangles: number;
  spatialGridOptions: Partial<ParticleSpatialGridOptions>;
}

// Binary corner numbering: x + 2*y + 4*z. Each primal edge belongs to its lower corner.
const corners = Array.from({ length: 8 }, (_, i) => [i & 1, (i >> 1) & 1, (i >> 2) & 1]);
const edges = corners.flatMap((_, i) => [1, 2, 4].filter(bit => !(i & bit)).map(bit => [i, i | bit]));

/** GPU-only isotropic field reconstruction and Surface Nets extraction. @internal */
export default class LiquidSurface {
  readonly geometry = new THREE.BufferGeometry();
  readonly grid: SparseVolumeGrid;
  readonly bounds: THREE.Box3;
  readonly fieldAttribute: StorageBufferAttribute;
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
  private readonly verticesNode: ComputeNode;
  private readonly indicesNode: ComputeNode;
  private readonly drawNode: ComputeNode;
  private readonly smoothNodes: ComputeNode[];
  private readonly shadingNode: ComputeNode;
  private readonly minimum: Node<'vec3'>;
  private readonly cellSize: Node<'float'>;

  constructor(private readonly options: LiquidSurfaceOptions, private readonly renderer: ParticleSpatialGridRenderer) {
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
    this.queryGrid = new ParticleSpatialGrid({ brickSubdivisions: 3, cellSubdivisions: 1,
      ...options.spatialGridOptions, timeQuality: 1 });
    const attribute = () => new StorageBufferAttribute(new Float32Array(this.grid.cellCount * 4), 4);
    this.fieldAttribute = attribute();
    this.positionAttribute = attribute();
    this.normalAttribute = attribute();
    this.colorAttribute = attribute();
    this.smoothingAttribute = attribute();
    this.topologyAttribute = new StorageBufferAttribute(new Uint32Array(this.grid.cellCount * 2), 1);
    this.indexAttribute = new StorageBufferAttribute(new Uint32Array(Math.floor(options.maxTriangles / 2) * 6), 1);
    const vector = (value: StorageBufferAttribute) => storage(value, 'vec4', value.count) as Vec4Storage;
    this.field = vector(this.fieldAttribute);
    this.positions = vector(this.positionAttribute);
    this.normals = vector(this.normalAttribute);
    this.colors = vector(this.colorAttribute);
    this.smoothing = vector(this.smoothingAttribute);
    this.topology = storage(this.topologyAttribute, 'uint', this.grid.cellCount * 2).toAtomic();
    this.geometry.setAttribute('position', this.positionAttribute);
    this.geometry.setAttribute('normal', this.normalAttribute);
    this.geometry.setAttribute('color', this.colorAttribute);
    this.geometry.setIndex(this.indexAttribute);
    this.geometry.indirect = this.drawAttribute;
    // Storage-created index buffers otherwise lack INDEX usage when first drawn.
    const backend = renderer.backend as { createIndexAttribute(attribute: StorageBufferAttribute): void };
    backend.createIndexAttribute(this.indexAttribute);
    this.resetNode = Fn(() => {
      atomicStore(this.counters.element(instanceIndex), uint(0));
    })().compute(3);
    this.verticesNode = this.grid.compute(index => this.buildVertex(index));
    this.indicesNode = this.grid.compute(index => this.buildFaces(index));
    this.smoothNodes = [
      this.grid.compute(index => this.smoothVertex(index, this.positions, this.smoothing, false)),
      this.grid.compute(index => this.smoothVertex(index, this.smoothing, this.positions, true)),
    ];
    this.shadingNode = this.grid.compute(index => this.rebuildShading(index));
    const args = storage(this.drawAttribute, 'uint', 5);
    this.drawNode = Fn(() => {
      const count = atomicLoad(this.counters.element(0)).toVar();
      const limit = uint(Math.floor(options.maxTriangles / 2));
      args.element(0).assign(count.lessThan(limit).select(count, limit).mul(6));
    })().compute(1);
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
    const key = [buffers.version, this.projection.version].join('|');
    if (key !== this.copyKey || buffers !== this.copyBuffers) {
      this.copyNode?.dispose();
      this.copyKey = key;
      this.copyBuffers = buffers;
      this.copyNode = Fn(() => {
        const source = buffers.storage.createParticle(instanceIndex);
        const target = this.projection.storage.createParticle(instanceIndex, true);
        const radius = max(source.scale.x.abs(), max(source.scale.y.abs(), source.scale.z.abs()))
          .mul(this.radiusScale).mul(this.scaleMultiplier).mul(0.5);
        const selected = source.alive.notEqual(0).and(source.alpha.greaterThan(0)).and(radius.greaterThan(0))
          .and(this.quality.greaterThan(0))
          .and(this.filterTags.equal(0).or(source.tagMask.bitAnd(this.tagMask).notEqual(0)));
        const inside = source.position.sub(radius).greaterThanEqual(vec3(this.bounds.min)).all()
          .and(source.position.add(radius).lessThan(vec3(this.bounds.max).sub(this.cellSize)).all());
        If(selected.and(inside.not()), () => { atomicAdd(this.counters.element(2), uint(1)); });
        target.alive.assign(selected.and(inside).select(uint(1), uint(0)));
        target.tagMask.assign(source.tagMask);
        target.generation.assign(source.generation);
        target.position.assign(source.position);
        target.scale.assign(source.scale.mul(this.radiusScale).mul(this.scaleMultiplier));
        target.color.assign(source.color);
        target.alpha.assign(source.alpha.max(0));
        target.velocity.assign(vec3(0));
        this.projection.storage.storeParticle(target);
      })().compute(buffers.count);
    }
    this.copyNode!.count = buffers.count;
    this.renderer.compute(this.copyNode!);
    this.queryGrid.rebuild(this.renderer, this.projection, {});
    this.grid.rebuild({ buffers: this.projection, deltaTimeNode: float(0) }, this.renderer,
      undefined, undefined, this.minimum, this.cellSize, float(1));
    if (this.queryVersion !== this.queryGrid.resourceVersion) {
      this.fieldNode?.dispose();
      this.queryVersion = this.queryGrid.resourceVersion;
      this.fieldNode = this.grid.compute(index => {
        const point = this.point(this.grid.coordinate(index));
        const total = float(0).toVar();
        const color = vec3(0).toVar();
        this.queryGrid.forEachParticleInRadius(point, this.queryGrid.getMaxParticleRadiusNode(), particle => {
          const radius = max(particle.scale.x.abs(), max(particle.scale.y.abs(), particle.scale.z.abs())).mul(0.5);
          const q = max(float(1).sub(particle.position.sub(point).lengthSq().div(max(radius.mul(radius), 1e-12))), 0);
          const weight = q.mul(q).mul(q).mul(particle.alpha);
          total.addAssign(weight);
          color.addAssign(particle.color.mul(weight));
        });
        this.field.element(index).assign(vec4(color, total));
      });
    }
    this.renderer.compute(this.fieldNode!);
    this.renderer.compute(this.verticesNode);
    this.renderer.compute(this.indicesNode);
    if (smoothingIterations > 0 && smoothingStrength > 0) {
      this.smoothingWeight.value = smoothingStrength * 0.5;
      for (let iteration = 0; iteration < smoothingIterations; iteration++) {
        this.smoothNodes.forEach(node => this.renderer.compute(node));
      }
      this.renderer.compute(this.shadingNode);
    }
    this.renderer.compute(this.drawNode);
  }

  private point(coordinate: Node<'ivec3'>): Node<'vec3'> {
    return vec3(coordinate).mul(this.cellSize).add(this.minimum) as Node<'vec3'>;
  }

  private buildVertex(index: Node<'uint'>): void {
    const coordinate = this.grid.coordinate(index);
    const samples = corners.map(corner => this.field.element(this.grid.index(coordinate.add(ivec3(...corner)))));
    const position = vec3(0).toVar();
    const color = vec3(0).toVar();
    const crossings = float(0).toVar();
    this.positions.element(index).assign(vec4(0));
    atomicStore(this.topology.element(index), uint(0));
    atomicStore(this.topology.element(index.add(this.grid.cellCount)), uint(0));
    // Never read beyond the logical page table at the final grid plane.
    If(vec3(coordinate).lessThan(vec3(this.grid.cellsPerAxis - 1)).all(), () => {
      for (const [a, b] of edges) {
        const first = samples[a], second = samples[b];
        If(first.w.greaterThanEqual(this.isoLevel).xor(second.w.greaterThanEqual(this.isoLevel)), () => {
          const t = this.isoLevel.sub(first.w).div(second.w.sub(first.w)).clamp(0, 1);
          position.addAssign(mix(vec3(...corners[a]), vec3(...corners[b]), t));
          color.addAssign(mix(first.xyz, second.xyz, t).div(this.isoLevel));
          crossings.addAssign(1);
        });
      }
      If(crossings.greaterThan(0), () => {
        const point = this.point(coordinate).add(position.div(crossings).mul(this.cellSize));
        this.positions.element(index).assign(vec4(point, 1));
        const gradient = [1, 2, 4].map(bit => samples.reduce<Node<'float'>>((sum, sample, corner) => (
          corner & bit ? sum.sub(sample.w) : sum.add(sample.w)
        ), float(0)));
        const normal = vec3(gradient[0], gradient[1], gradient[2]);
        this.normals.element(index).assign(vec4(normal.length().greaterThan(1e-12)
          .select(normal.div(max(normal.length(), 1e-12)), vec3(0, 1, 0)), 0));
        this.colors.element(index).assign(vec4(color.div(crossings), 1));
        atomicAdd(this.counters.element(1), uint(1));
      });
    });
  }

  private buildFaces(index: Node<'uint'>): void {
    const c = this.grid.coordinate(index);
    const indices = storage(this.indexAttribute, 'uint', this.indexAttribute.count);
    for (let axis = 0; axis < 3; axis++) {
      const direction = [0, 0, 0];
      const u = [0, 0, 0], v = [0, 0, 0];
      direction[axis] = 1;
      u[(axis + 1) % 3] = 1;
      v[(axis + 2) % 3] = 1;
      const inside = this.field.element(index).w.greaterThanEqual(this.isoLevel);
      const other = this.field.element(this.grid.index(c.add(ivec3(...direction)))).w.greaterThanEqual(this.isoLevel);
      const valid = c[(axis === 0 ? 'y' : axis === 1 ? 'z' : 'x')].greaterThan(0)
        .and(c[(axis === 0 ? 'z' : axis === 1 ? 'x' : 'y')].greaterThan(0))
        .and(vec3(c).lessThan(vec3(this.grid.cellsPerAxis - 1)).all());
      If(valid.and(inside.xor(other)), () => {
        const quad = [index, this.grid.index(c.sub(ivec3(...u))),
          this.grid.index(c.sub(ivec3(...u)).sub(ivec3(...v))), this.grid.index(c.sub(ivec3(...v)))];
        const present = quad.map(at => this.positions.element(at).w.greaterThan(0)).reduce((a, b) => a.and(b));
        If(present, () => {
          const face = atomicAdd(this.counters.element(0), uint(1)).toVar();
          If(face.lessThan(Math.floor(this.options.maxTriangles / 2)), () => {
            const order = [quad[0], inside.select(quad[1], quad[3]), quad[2],
              quad[0], quad[2], inside.select(quad[3], quad[1])];
            order.forEach((at, i) => { indices.element(face.mul(6).add(i)).assign(at); });
            atomicOr(this.topology.element(index.add(this.grid.cellCount)), uint(1 << axis));
            const uAxis = (axis + 1) % 3, vAxis = (axis + 2) % 3;
            for (const [at, direction, sign] of [[0, uAxis, -1], [0, vAxis, -1],
              [1, uAxis, 1], [1, vAxis, -1], [2, vAxis, 1], [2, uAxis, 1],
              [3, uAxis, -1], [3, vAxis, 1]]) {
              atomicOr(this.topology.element(quad[at]), uint(1 << (direction * 2 + (sign < 0 ? 1 : 0))));
            }
          });
        });
      });
    }
  }

  private smoothVertex(index: Node<'uint'>, source: Vec4Storage, target: Vec4Storage, reverse: boolean): void {
    const current = source.element(index).toVar();
    target.element(index).assign(current);
    If(current.w.greaterThan(0), () => {
      // Materialize before conditional neighbor reads so TSL cannot cache it inside only one branch.
      const coordinate = this.grid.coordinate(index).toVar();
      const mask = atomicLoad(this.topology.element(index)).toVar();
      const total = vec3(0).toVar();
      const count = float(0).toVar();
      for (let axis = 0; axis < 3; axis++) for (const sign of [1, -1]) {
        const offset = [0, 0, 0];
        offset[axis] = sign;
        const bit = 1 << (axis * 2 + (sign < 0 ? 1 : 0));
        If(mask.bitAnd(bit).notEqual(0), () => {
          total.addAssign(source.element(this.grid.index(coordinate.add(ivec3(...offset)))).xyz);
          count.addAssign(1);
        });
      }
      If(count.greaterThan(0), () => {
        // Taubin's paired Laplacian steps attenuate ripples with much less shrinkage than repeated averaging.
        const weight = reverse ? this.smoothingWeight.negate().div(float(1).sub(this.smoothingWeight.mul(0.1)))
          : this.smoothingWeight;
        const position = current.xyz.add(total.div(count).sub(current.xyz).mul(weight));
        const lower = this.point(coordinate);
        target.element(index).assign(vec4(clamp(position, lower, lower.add(this.cellSize)), 1));
      });
    });
  }

  private rebuildShading(index: Node<'uint'>): void {
    If(this.positions.element(index).w.greaterThan(0), () => {
      const c = this.grid.coordinate(index).toVar();
      const normal = vec3(0).toVar();
      // Gather area-weighted normals only from quads actually admitted by the triangle budget.
      for (let axis = 0; axis < 3; axis++) for (const a of [0, 1]) for (const b of [0, 1]) {
        const u = [0, 0, 0], v = [0, 0, 0];
        u[(axis + 1) % 3] = 1;
        v[(axis + 2) % 3] = 1;
        const root = c.add(ivec3(...u).mul(a)).add(ivec3(...v).mul(b));
        const address = this.grid.index(root);
        If(atomicLoad(this.topology.element(address.add(this.grid.cellCount))).bitAnd(1 << axis).notEqual(0), () => {
          const points = [root, root.sub(ivec3(...u)), root.sub(ivec3(...u)).sub(ivec3(...v)), root.sub(ivec3(...v))]
            .map(at => this.positions.element(this.grid.index(at)).xyz);
          const first = points[1].sub(points[0]).cross(points[2].sub(points[0]));
          const second = points[2].sub(points[0]).cross(points[3].sub(points[0]));
          const contribution = a === b ? first.add(second) : a ? first : second;
          const sign = this.field.element(address).w.greaterThanEqual(this.isoLevel).select(1, -1);
          normal.addAssign(contribution.mul(sign));
        });
      }
      If(normal.length().greaterThan(1e-12), () => {
        this.normals.element(index).assign(vec4(normal.normalize(), 0));
      });
      const fraction = this.positions.element(index).xyz.sub(this.point(c)).div(this.cellSize).clamp(0, 1);
      const color = vec4(0).toVar();
      corners.forEach(corner => {
        const weight = corner.map((bit, axis) => bit ? fraction[['x', 'y', 'z'][axis] as 'x' | 'y' | 'z']
          : float(1).sub(fraction[['x', 'y', 'z'][axis] as 'x' | 'y' | 'z'])).reduce((a, b) => a.mul(b));
        color.addAssign(this.field.element(this.grid.index(c.add(ivec3(...corner)))).mul(weight));
      });
      If(color.w.greaterThan(1e-8), () => { this.colors.element(index).assign(vec4(color.xyz.div(color.w), 1)); });
    });
  }

  clear(): void {
    this.renderer.compute(Fn(() => {
      storage(this.drawAttribute, 'uint', 5).element(0).assign(0);
    })().compute(1));
  }

  async readDiagnostics(): Promise<{
    triangles: number; vertices: number; overflowedTriangles: number; clippedParticles: number;
    activeBricks: number; overflowedBricks: number; bounds: THREE.Box3;
  }> {
    const data = new Uint32Array(await this.renderer.getArrayBufferAsync(this.countersAttribute));
    const bricks = new Uint32Array(await this.renderer.getArrayBufferAsync(this.grid.diagnosticsAttribute));
    const quads = Math.floor(this.options.maxTriangles / 2);
    return { triangles: Math.min(data[0], quads) * 2, vertices: data[1],
      overflowedTriangles: Math.max(0, data[0] - quads) * 2, clippedParticles: data[2],
      activeBricks: bricks[0], overflowedBricks: bricks[1], bounds: this.bounds.clone() };
  }

  dispose(): void {
    [this.copyNode, this.fieldNode, this.resetNode, this.verticesNode, this.indicesNode, this.drawNode,
      ...this.smoothNodes, this.shadingNode]
      .forEach(node => node?.dispose());
    this.geometry.dispose();
    for (const attribute of [this.fieldAttribute, this.positionAttribute, this.normalAttribute,
      this.colorAttribute, this.indexAttribute, this.countersAttribute, this.drawAttribute,
      this.smoothingAttribute, this.topologyAttribute]) {
      destroyGPUStorageAttribute(this.renderer, attribute);
      attribute.dispose();
    }
    this.projection.dispose(this.renderer);
    this.queryGrid.dispose(this.renderer);
    this.grid.dispose(this.renderer);
  }
}
