import { StorageBufferAttribute, IndirectStorageBufferAttribute, type ComputeNode, type Node } from 'three/webgpu';
import { Fn, If, Loop, Break, uint, int, float, ivec3, vec3, floor, clamp, storage, uniform,
  atomicLoad, atomicStore, atomicAdd, instanceIndex, localId, workgroupId, workgroupArray,
  workgroupBarrier, wgslFn } from 'three/tsl';
import type ParticleSpatialGrid from '../ParticleSpatialGrid';
import type { ParticleSpatialGridRenderer } from '../ParticleSpatialGrid';
import { destroyGPUStorageAttribute, type GPUParticleBufferState } from '../../../simulation/gpu/Particle';
import { nextPowerOfTwo, type AtomicUintStorage, type GPUStorageBufferRenderer } from '../../../utils/gpu/storage.utils';
import { computeRange, writeComputeDispatch, type GPUComputeRange } from '../../../utils/gpu/computeDispatch.utils';
import GPUExclusiveScan from '../../../utils/gpu/ExclusiveScan';
import SpatialAggregateStorage from './SpatialAggregateStorage';
import type { GPUSpatialRegion, SpatialAggregator, SpatialAggregateLayout,
  SpatialAggregateNodes } from '../../../types/spatialAggregator.types';

const EMPTY = 0xffffffff;
const WORDS = 8;

// Must be string function as atomicCompareExchangeWeak is not exposed as a node
const claim = wgslFn(`
fn rzmpsSpatialClaim(address: ptr<storage, atomic<u32>, read_write>, value: u32) -> u32 {
  loop {
    let result = atomicCompareExchangeWeak(address, 0u, value);
    if (result.exchanged || result.old_value != 0u) { return result.old_value; }
  }
}`);

export interface GPUSpatialRegionRange {
  count: Node<'uint'>;
  /** Allocated hash-directory slots, not occupied count. Useful for caller-owned per-region scratch. */
  capacity: number;
  region(index: Node<'uint'>): GPUSpatialRegion;
}

export interface GPURegionParticleIndices {
  count: Node<'uint'>;
  index(ordinal: Node<'uint'>): Node<'uint'>;
}

interface Level {
  depth: number;
  capacity: number;
  hashCapacity: number;
  header: number;
  records: number;
  active: number;
  members: number;
  owners: number;
  aggregate: number;
  range: GPUComputeRange;
  groups: IndirectStorageBufferAttribute;
}

/** Optional sparse resolution directories with CSR child ranges, not a pointer-based GPU octree. */
export default class GPUSpatialRegions<L extends SpatialAggregateLayout> {
  private readonly attribute: StorageBufferAttribute;
  private readonly data: AtomicUintStorage;
  private readonly levels: Level[] = [];
  private readonly aggregates?: SpatialAggregateStorage<L>;
  private readonly scans: GPUExclusiveScan[] = [];
  private nodes: ComputeNode[] = [];
  private buffers?: GPUParticleBufferState;
  private version = -1;
  private inputRange?: GPUComputeRange;
  private readonly inputCount = uniform(0, 'uint');
  private readonly inputDispatch = new IndirectStorageBufferAttribute(new Uint32Array([0, 1, 1]), 1);

  constructor(
    private readonly grid: ParticleSpatialGrid<L>,
    capacity: number,
    depths: readonly number[],
    private readonly aggregator?: SpatialAggregator<L, 'gpu'>,
    renderer?: GPUStorageBufferRenderer,
  ) {
    // Pack level directories and membership lists into one atomic storage binding.
    let words = 0;
    let aggregateCount = 0;

    depths.forEach((depth, i) => {
      const cells = Math.min(capacity, 2 ** (3 * depth));
      const hashCapacity = nextPowerOfTwo(cells * 2);
      const sourceCapacity = i + 1 === depths.length ? capacity
        : nextPowerOfTwo(Math.min(capacity, 2 ** (3 * depths[i + 1])) * 2);
      const header = words++;
      const records = words;
      words += hashCapacity * WORDS;
      const active = words;
      words += cells;
      const members = words;
      words += sourceCapacity;
      const owners = words;
      words += sourceCapacity;

      this.levels.push({ depth, capacity: cells, hashCapacity, header, records, active, members, owners,
        aggregate: aggregateCount,
        range: { count: uint(0), dispatch: new IndirectStorageBufferAttribute(new Uint32Array([0, 1, 1]), 1) },
        groups: new IndirectStorageBufferAttribute(new Uint32Array([0, 1, 1]), 1) });
      aggregateCount += hashCapacity;
    });

    // Validate the full allocation before constructing either GPU buffer.
    const limit = (renderer?.backend as { device?: { limits: { maxStorageBufferBindingSize: number } } })
      ?.device?.limits.maxStorageBufferBindingSize ?? 128 * 1024 * 1024;
    if (words * 4 > limit) throw new RangeError('Spatial region directory exceeds the device storage limit.');
    if (aggregator && aggregateCount * Object.keys(aggregator.layout).length * 16 > limit) {
      throw new RangeError('Spatial aggregate storage exceeds the device storage limit.');
    }

    this.attribute = new StorageBufferAttribute(new Uint32Array(words), 1);
    this.data = storage(this.attribute, 'uint', words).toAtomic() as AtomicUintStorage;
    this.levels.forEach(level => {
      level.range.count = atomicLoad(this.data.element(level.header));
    });

    if (aggregator) this.aggregates = new SpatialAggregateStorage(aggregator.layout, aggregateCount);
  }

  private level(depth: number): Level {
    const level = this.levels.find(value => value.depth === depth);
    if (!level) throw new RangeError(`Spatial depth ${depth} is not maintained.`);

    return level;
  }

  private word(level: Level, index: Node<'uint'>, field: number): Node<'uint'> {
    return this.data.element(index.mul(WORDS).add(level.records + field));
  }

  private read(level: Level, index: Node<'uint'>, field: number): Node<'uint'> {
    return atomicLoad(this.word(level, index, field)).toVar();
  }

  getCoordinate(region: GPUSpatialRegion): Node<'ivec3'> {
    const level = this.level(region.depth);
    return ivec3(int(this.read(level, region.index, 4)), int(this.read(level, region.index, 5)),
      int(this.read(level, region.index, 6)));
  }

  getRegions(depth: number): GPUSpatialRegionRange {
    const level = this.level(depth);

    return {
      count: level.range.count,
      capacity: level.hashCapacity,
      region: ordinal => ({
        depth,
        index: atomicLoad(this.data.element(ordinal.add(level.active))).toVar(),
        valid: ordinal.lessThan(level.range.count),
      }),
    };
  }

  getChildren(region: GPUSpatialRegion): GPUSpatialRegionRange {
    const level = this.level(region.depth);
    const finer = this.levels[this.levels.indexOf(level) + 1];

    if (!finer) {
      return {
        count: uint(0),
        capacity: 0,
        region: () => ({ depth: region.depth, index: uint(EMPTY), valid: uint(0).notEqual(0) }),
      };
    }

    return {
      count: region.valid.select(this.read(level, region.index, 1), uint(0)).toVar(),
      capacity: finer.hashCapacity,
      region: ordinal => ({
        depth: finer.depth,
        valid: region.valid.and(ordinal.lessThan(this.read(level, region.index, 1))),
        index: atomicLoad(this.data.element(this.read(level, region.index, 2).add(ordinal).add(level.members))),
      }),
    };
  }

  getParticleIndices(region: GPUSpatialRegion): GPURegionParticleIndices {
    const level = this.level(region.depth);
    if (level !== this.levels[this.levels.length - 1]) {
      throw new Error('Particle indices are stored only at the finest level; traverse occupied children first.');
    }

    return {
      count: region.valid.select(this.read(level, region.index, 1), uint(0)).toVar(),
      index: ordinal => atomicLoad(this.data.element(this.read(level, region.index, 2)
        .add(ordinal).add(level.members))),
    };
  }

  getAggregate(region: GPUSpatialRegion, finalize = true): SpatialAggregateNodes<L> {
    if (!this.aggregates || !this.aggregator) throw new Error('This spatial grid has no aggregator.');

    const value = this.variables(this.aggregator.new(undefined, undefined, region));
    If(region.valid, () => this.assign(value,
      this.aggregates!.read(region.index.add(this.level(region.depth).aggregate))));

    return finalize ? this.aggregator.finalize?.(value) ?? value : value;
  }

  locate(position: Node<'vec3'>, depth: number): GPUSpatialRegion {
    const level = this.level(depth);
    const bounds = this.grid.getBoundsNode();
    const coordinate = ivec3(clamp(floor(position.sub(bounds.min).div(bounds.max.sub(bounds.min))
      .mul(2 ** depth)), vec3(0), vec3(2 ** depth - 1)));
    const index = this.lookup(level, coordinate);
    return { depth, index, valid: index.notEqual(EMPTY).and(position.greaterThanEqual(bounds.min).all())
      .and(position.lessThanEqual(bounds.max).all()) };
  }

  computeRegions(depth: number, callback: (region: GPUSpatialRegion) => void): ComputeNode {
    const level = this.level(depth);
    return computeRange(level.range, index => callback(this.getRegions(depth).region(index)));
  }

  private hash(coordinate: Node<'ivec3'>, capacity: number): Node<'uint'> {
    return uint(coordinate.x).mul(73856093).bitXor(uint(coordinate.y).mul(19349663))
      .bitXor(uint(coordinate.z).mul(83492791)).bitAnd(capacity - 1);
  }

  private lookup(level: Level, coordinate: Node<'ivec3'>): Node<'uint'> {
    const bucket = this.hash(coordinate, level.hashCapacity).toVar();
    const result = uint(EMPTY).toVar();

    Loop(() => {
      If(this.read(level, bucket, 0).equal(0), () => {
        Break();
      });
      const region = { depth: level.depth, index: bucket, valid: uint(1).equal(1) };
      const candidate = this.getCoordinate(region);
      If(candidate.x.equal(coordinate.x).and(candidate.y.equal(coordinate.y)).and(candidate.z.equal(coordinate.z)),
        () => {
          result.assign(bucket);
          Break();
        });
      bucket.assign(bucket.add(1).bitAnd(level.hashCapacity - 1));
    });

    return result;
  }

  private variables(value: SpatialAggregateNodes<L>): SpatialAggregateNodes<L> {
    const entries = Object.entries(value).map(([key, node]) => [key, node.toVar()]);
    return Object.fromEntries(entries) as SpatialAggregateNodes<L>;
  }

  private assign(target: SpatialAggregateNodes<L>, value: SpatialAggregateNodes<L>): void {
    // Capture every channel before assigning: reducers may depend on other channels' old values.
    const captured = this.variables(value);
    Object.keys(target).forEach(key => target[key].assign(captured[key]));
  }

  rebuild(renderer: ParticleSpatialGridRenderer, buffers: GPUParticleBufferState, range?: GPUComputeRange): void {
    this.inputCount.value = buffers.count;

    if (this.buffers !== buffers || this.version !== buffers.version || this.inputRange?.count !== range?.count
      || this.inputRange?.dispatch !== range?.dispatch) {
      this.nodes.forEach(node => node.dispose());
      this.scans.forEach(scan => scan.dispose(renderer));
      this.scans.length = 0;
      this.buffers = buffers;
      this.version = buffers.version;
      this.inputRange = range;
      this.nodes = this.build(buffers, range);
    }

    renderer.compute(this.nodes);
  }

  private build(buffers: GPUParticleBufferState, supplied?: GPUComputeRange): ComputeNode[] {
    const inputRange = supplied ?? { count: this.inputCount, dispatch: this.inputDispatch };
    const nodes: ComputeNode[] = [];
    if (!supplied) nodes.push(Fn(() => writeComputeDispatch(inputRange))().compute(1));

    // Build finest memberships first; coarser levels consume the occupied regions below them.
    for (let l = this.levels.length - 1; l >= 0; l--) {
      const level = this.levels[l];
      const source = this.levels[l + 1];
      const range = source?.range ?? inputRange;
      const bounds = this.grid.getBoundsNode();
      const sourceIndex = (i: Node<'uint'>) => source ? this.getRegions(source.depth).region(i).index : i;
      const coordinate = (index: Node<'uint'>) => source
        ? this.getCoordinate({ depth: source.depth, index, valid: uint(1).equal(1) })
          .div(2 ** (source.depth - level.depth))
        : ivec3(clamp(floor(buffers.storage.createParticle(index).position.sub(bounds.min)
          .div(bounds.max.sub(bounds.min)).mul(2 ** level.depth)), vec3(0), vec3(2 ** level.depth - 1)));
      const accepted = (index: Node<'uint'>) => {
        if (source) return uint(1).equal(1);

        const p = buffers.storage.createParticle(index);
        return p.alive.notEqual(0).and(p.position.greaterThanEqual(bounds.min).all())
          .and(p.position.lessThanEqual(bounds.max).all());
      };

      // Clear hash records, then claim exact cell coordinates and append occupied buckets.
      nodes.push(Fn(() => {
        const slot = instanceIndex;
        atomicStore(this.word(level, slot, 0), 0);
        atomicStore(this.word(level, slot, 1), 0);
        atomicStore(this.word(level, slot, 3), 0);
        If(slot.equal(0), () => {
          atomicStore(this.data.element(level.header), 0);
        });
      })().compute(level.hashCapacity).setName('rzmps.spatial.clear'));
      nodes.push(computeRange(range, i => {
        const input = sourceIndex(i).toVar();
        If(accepted(input), () => {
          const cell = coordinate(input).toVar();
          const bucket = this.hash(cell, level.hashCapacity).toVar();
          Loop(() => {
            const previous = (claim(this.word(level, bucket, 0), input.add(1)) as Node<'uint'>).toVar();
            const candidate = coordinate(previous.sub(1));
            If(previous.equal(0).or(candidate.x.equal(cell.x).and(candidate.y.equal(cell.y))
              .and(candidate.z.equal(cell.z))), () => {
              If(previous.equal(0), () => {
                atomicStore(this.word(level, bucket, 4), uint(cell.x));
                atomicStore(this.word(level, bucket, 5), uint(cell.y));
                atomicStore(this.word(level, bucket, 6), uint(cell.z));
              });
              atomicStore(this.data.element(input.add(level.owners)), bucket);
              const oldCount = atomicAdd(this.word(level, bucket, 1), 1).toVar();
              If(oldCount.equal(0), () => {
                const ordinal = atomicAdd(this.data.element(level.header), 1).toVar();
                atomicStore(this.data.element(ordinal.add(level.active)), bucket);
              });
              Break();
            });
            bucket.assign(bucket.add(1).bitAnd(level.hashCapacity - 1));
          });
        });
      }).setName('rzmps.spatial.index'));

      // Prefix counts become contiguous child/particle ranges; scatter fills those ranges.
      const active = (i: Node<'uint'>) => atomicLoad(this.data.element(i.add(level.active))).toVar();
      const scan = new GPUExclusiveScan(level.capacity, i => this.read(level, active(i), 1),
        (i, value) => {
          atomicStore(this.word(level, active(i), 2), value);
        }, level.range.count);
      this.scans.push(scan);
      nodes.push(...scan.nodes);

      nodes.push(computeRange(range, i => {
        const input = sourceIndex(i).toVar();
        If(accepted(input), () => {
          const bucket = atomicLoad(this.data.element(input.add(level.owners))).toVar();
          const local = atomicAdd(this.word(level, bucket, 3), 1).toVar();
          atomicStore(this.data.element(this.read(level, bucket, 2).add(local).add(level.members)), input);
        });
      }).setName('rzmps.spatial.members'));

      // Subsequent passes dispatch occupied regions, with one cooperative group per aggregate.
      nodes.push(Fn(() => {
        writeComputeDispatch(level.range);
        const args = storage(level.groups, 'uint', 3);
        args.element(0).assign(uint(float(level.range.count).min(256)));
        args.element(1).assign(level.range.count.add(255).div(256));
        args.element(2).assign(1);
      })().compute(1).setName('rzmps.spatial.schedule'));
      if (this.aggregates && this.aggregator) nodes.push(this.reduce(level, source, buffers));
    }

    return nodes;
  }

  private reduce(level: Level, source: Level | undefined, buffers: GPUParticleBufferState): ComputeNode {
    const aggregator = this.aggregator!;
    const shared = Object.fromEntries(Object.entries(aggregator.layout).map(([key, type]) =>
      [key, workgroupArray(type, 64) as unknown as { element(i: Node | number): Node }]));

    const node = Fn(() => {
      const region = this.getRegions(level.depth).region(workgroupId.x.add(workgroupId.y.mul(256)));
      const count = region.valid.select(this.read(level, region.index, 1), uint(0)).toVar();
      const start = this.read(level, region.index, 2).toVar();
      const value = this.variables(aggregator.new(undefined, undefined, region));
      const cursor = localId.x.toVar();

      // Each lane reduces a strided subset of the region's members.
      Loop(() => {
        If(cursor.greaterThanEqual(count), () => {
          Break();
        });
        const index = atomicLoad(this.data.element(start.add(cursor).add(level.members))).toVar();
        const contribution = source ? this.aggregates!.read(index.add(source.aggregate))
          : aggregator.new(buffers.storage.createParticle(index), index, region);
        this.assign(value, aggregator.combine(value, contribution));
        cursor.addAssign(64);
      });

      // Combine lane totals without finalization so ancestors can reuse raw aggregates.
      Object.keys(value).forEach(key => shared[key].element(localId.x).assign(value[key]));
      workgroupBarrier();

      for (let stride = 32; stride >= 1; stride /= 2) {
        If(localId.x.lessThan(stride), () => {
          const a = Object.fromEntries(Object.keys(value).map(key => [key, shared[key].element(localId.x)]));
          const b = Object.fromEntries(Object.keys(value)
            .map(key => [key, shared[key].element(localId.x.add(stride))]));
          const combined = this.variables(aggregator.combine(a as SpatialAggregateNodes<L>,
            b as SpatialAggregateNodes<L>));
          Object.keys(value).forEach(key => shared[key].element(localId.x).assign(combined[key]));
        });
        workgroupBarrier();
      }

      If(localId.x.equal(0).and(region.valid), () => {
        const result = Object.fromEntries(Object.keys(value).map(key => [key, shared[key].element(uint(0))]));
        this.aggregates!.write(region.index.add(level.aggregate), result as SpatialAggregateNodes<L>);
      });
    })().computeKernel([64]).setName('rzmps.spatial.aggregate');
    node.dispatchSize = level.groups as unknown as number[];

    return node;
  }

  dispose(renderer?: GPUStorageBufferRenderer): void {
    this.nodes.forEach(node => node.dispose());
    this.scans.forEach(scan => scan.dispose(renderer));
    this.aggregates?.dispose(renderer);
    [this.attribute, this.inputDispatch, ...this.levels.flatMap(level => [level.range.dispatch, level.groups])]
      .forEach(attribute => destroyGPUStorageAttribute(renderer, attribute));
  }
}
