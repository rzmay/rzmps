import * as THREE from 'three';
import { IndirectStorageBufferAttribute, StorageBufferAttribute, type ComputeNode, type Node } from 'three/webgpu';
import {
  Fn, If, Loop, atomicAdd, atomicMax, atomicLoad, atomicOr, atomicStore, clamp, float, floor,
  globalId, instanceIndex, int, ivec3, max, min, storage, uint, uniform, vec3, workgroupId,
} from 'three/tsl';
import SpatialGrid from '../SpatialGrid';
import type { ParticleSpatialGridOptions, ParticleSpatialGridRenderer } from '../ParticleSpatialGrid';
import type { GPUParticleRenderBufferState, GPUParticleUpdateContext } from '../../../simulation/gpu/Particle';
import { destroyGPUStorageAttribute } from '../../../simulation/gpu/Particle';

type UintStorage = { element(index: Node | number): Node<'uint'> };
type Vec4Storage = { element(index: Node | number): Node<'vec4'> };
// Three supports named loop counters; its current declarations omit the name option.
const namedLoop = Loop as unknown as (...parameters: Array<
  { start: number | Node; end: number | Node; name: string }
  | ((indices: Record<string, Node<'int'>>) => void)
>) => void;
const offsetIndex = (index: Node | number, offset: number) => typeof index === 'number'
  ? uint(index + offset) : uint(index as Node<'uint'>).add(offset);

/**
 * GPU-resident sparse brick pool. Zero is an absent page, not a solid boundary.
 * @internal
 */
export default class SparseVolumeGrid extends SpatialGrid {
  readonly bounds: THREE.Box3;
  readonly capacity: number;
  readonly brickSide: number;
  readonly brickCount: number;
  readonly cellsPerBrick: number;
  readonly cellCount: number;
  readonly pagesAttribute: StorageBufferAttribute;
  readonly previousPagesAttribute: StorageBufferAttribute;
  readonly slotsAttribute: StorageBufferAttribute;
  readonly newSlotsAttribute: StorageBufferAttribute;
  readonly diagnosticsAttribute: StorageBufferAttribute;
  private readonly requestsAttribute: StorageBufferAttribute;
  readonly pages: UintStorage;
  readonly previousPages: UintStorage;
  readonly slots: UintStorage;
  private readonly fresh: UintStorage;
  private readonly requests;
  private readonly counters: UintStorage;
  private resetNode?: ComputeNode;
  private allocateNode?: ComputeNode;
  private releaseNode?: ComputeNode;
  private readonly freeOffset: number;
  private markNodes = new WeakMap<object, ComputeNode>();
  private remapMarkNodes = new WeakMap<object, ComputeNode>();
  private readonly previousMinimum = uniform(new THREE.Vector3());
  private readonly previousCellSize = uniform(1);
  private particleNode?: ComputeNode;
  private particleKey = '';
  private particleBuffers?: GPUParticleUpdateContext['buffers'];
  private snapshotNode?: ComputeNode;
  private readonly sourceTileSide: number;
  private readonly sourceMaskWords: number;
  private readonly sourceMaskOffset: number;
  private copySourceMaskNode?: ComputeNode;
  private resetSourceMaskNode?: ComputeNode;
  private renderSourceNode?: ComputeNode;
  private renderSourceKey = '';
  private readonly activeSlots: UintStorage;
  private readonly freshSlots: UintStorage;
  readonly dispatchAttributes = Array.from({ length: 4 }, () => (
    new IndirectStorageBufferAttribute(new Uint32Array(3), 1)
  ));
  private scheduleNode?: ComputeNode;
  private readonly coarseNodes = new WeakMap<SparseVolumeGrid, ComputeNode>();

  constructor(options: Partial<ParticleSpatialGridOptions>, capacity: number) {
    super();
    if (!Number.isFinite(capacity) || capacity < 1) {
      throw new RangeError('maxActiveBricks must be finite and positive.');
    }
    this._brickSubdivisions = options.brickSubdivisions ?? 2;
    this._cellSubdivisions = options.cellSubdivisions ?? 3;
    this.bounds = options.bounds?.clone() ?? new THREE.Box3();
    this.brickSide = 2 ** this.cellSubdivisions;
    this.brickCount = (2 ** this.brickSubdivisions) ** 3;
    this.capacity = Math.min(this.brickCount, Math.max(1, Math.floor(capacity)));
    this.cellsPerBrick = this.brickSide ** 3;
    this.sourceTileSide = Math.max(1, Math.ceil(this.cellsPerAxis / 4));
    this.sourceMaskWords = Math.ceil(this.sourceTileSide ** 3 / 32);
    this.sourceMaskOffset = this.brickCount + this.capacity * 4;
    // The final zero cell is immutable and serves all unallocated-page reads.
    this.cellCount = this.capacity * this.cellsPerBrick + 1;
    const attribute = (count: number) => new StorageBufferAttribute(new Uint32Array(count), 1);
    this.previousPagesAttribute = attribute(this.brickCount);
    this.pagesAttribute = attribute(this.sourceMaskOffset + this.sourceMaskWords + 1);
    this.slotsAttribute = this.pagesAttribute;
    this.newSlotsAttribute = this.pagesAttribute;
    this.freeOffset = this.brickCount + this.sourceMaskWords;
    // Shared scratch: free slot list, its length, allocation cursor, and overflow count.
    this.requestsAttribute = attribute(this.freeOffset + this.capacity + 3);
    this.diagnosticsAttribute = attribute(2);
    const node = (value: StorageBufferAttribute) => storage(value, 'uint', value.count) as UintStorage;
    this.pages = node(this.pagesAttribute);
    this.previousPages = node(this.previousPagesAttribute);
    this.slots = { element: index => this.pages.element(offsetIndex(index, this.brickCount)) };
    this.fresh = { element: index => this.pages.element(offsetIndex(index, this.brickCount + this.capacity)) };
    this.activeSlots = {
      element: index => this.pages.element(offsetIndex(index, this.brickCount + this.capacity * 2)),
    };
    this.freshSlots = {
      element: index => this.pages.element(offsetIndex(index, this.brickCount + this.capacity * 3)),
    };
    this.counters = node(this.diagnosticsAttribute);
    this.requests = storage(this.requestsAttribute, 'uint', this.requestsAttribute.count).toAtomic();
  }

  protected invalidateStructure(): void {
    throw new Error('Change sparse field structure through the owning module spatialGridOptions.');
  }

  /** GPU-produced compact range; its count shares the page binding used for address mapping. */
  get activeCellCount(): Node<'uint'> { return this.pages.element(this.pagesAttribute.count - 1); }

  compactCell(index: Node<'uint'>): Node<'uint'> {
    return this.activeSlots.element(index.div(this.cellsPerBrick)).mul(this.cellsPerBrick)
      .add(index.mod(this.cellsPerBrick));
  }

  active(index: Node<'uint'>): Node<'bool'> {
    const slot = uint(min(float(index.div(this.cellsPerBrick)), this.capacity - 1));
    return index.lessThan(this.cellCount - 1).and(this.slots.element(slot).greaterThan(uint(0)));
  }

  isNew(index: Node<'uint'>): Node<'bool'> {
    return this.fresh.element(uint(min(float(index.div(this.cellsPerBrick)), this.capacity - 1))).greaterThan(uint(0));
  }

  /** Dispatches stable pool addresses through compact active/new slot lists. */
  compute(callback: (index: Node<'uint'>) => void, faces = false, fresh = false): ComputeNode {
    const size = faces ? (this.brickSide + 1) ** 3 : this.cellsPerBrick;
    const slots = fresh ? this.freshSlots : this.activeSlots;
    const node = Fn(() => {
      If(globalId.x.lessThan(size), () => {
        const index = slots.element(workgroupId.y).mul(size).add(globalId.x).toVar();
        callback(index);
      });
    })().computeKernel([64]);
    // Three's runtime supports indirect attributes; its current declarations do not.
    node.dispatchSize = this.dispatchAttributes[(fresh ? 2 : 0) + (faces ? 1 : 0)] as unknown as number[];
    return node;
  }

  /** Compact brick execution with dense field addresses, including uniquely owned shared faces. */
  computeDense(callback: (index: Node<'uint'>) => void, faces = false, fresh = false): ComputeNode {
    return this.compute(index => {
      const b = this.brickSide;
      const size = faces ? (b + 1) ** 3 : this.cellsPerBrick;
      const slot = uint(index.div(size));
      const brick = this.unpack(this.slots.element(slot).sub(1), 2 ** this.brickSubdivisions);
      const local = this.unpack(index.mod(size), faces ? b + 1 : b);
      const coordinate = brick.mul(b).add(local);
      if (!faces) {
        callback(this.flatten(coordinate, this.cellsPerAxis));
        return;
      }
      // The upper brick owns a shared face. At sparse edges, the lower brick
      // supplies the otherwise missing face, including domain boundaries.
      const owner = ivec3(min(vec3(coordinate.div(b)), vec3(2 ** this.brickSubdivisions - 1)));
      const page = this.pages.element(this.flatten(owner, 2 ** this.brickSubdivisions));
      const owns = page.equal(slot.add(1)).or(page.equal(0));
      // At edges/corners more than one lower brick can touch a missing owner;
      // only axis faces are used, but each dense vec4 still needs one writer.
      const lower = ivec3(max(vec3(coordinate.sub(1).div(b)), vec3(0)));
      const selected = uint(0).toVar();
      for (const z of [0, 1]) for (const y of [0, 1]) for (const x of [0, 1]) {
        const candidate = ivec3(x ? owner.x : lower.x, y ? owner.y : lower.y, z ? owner.z : lower.z);
        const encoded = this.pages.element(this.flatten(candidate, 2 ** this.brickSubdivisions));
        If(encoded.greaterThan(uint(0)), () => { selected.assign(encoded); });
      }
      If(owns.and(selected.equal(slot.add(1))), () => {
        callback(this.flatten(coordinate, this.cellsPerAxis + 1));
      });
    }, faces, fresh);
  }

  /** Derive sparse coarse occupancy without allocating absent fine regions. @internal */
  restrictOccupancyTo(renderer: ParticleSpatialGridRenderer, target: SparseVolumeGrid): void {
    const sameBricks = target.brickSubdivisions === this.brickSubdivisions;
    const fineSide = 2 ** this.brickSubdivisions;
    const coarseSide = 2 ** target.brickSubdivisions;
    const node = this.coarseNodes.get(target) ?? Fn(() => {
      const next = uint(0).toVar();
      Loop(target.capacity, ({ i }) => { target.slots.element(uint(i)).assign(0); });
      Loop(target.brickCount, ({ i }) => {
        const brick = uint(i);
        const occupied = uint(0).toVar();
        if (sameBricks) occupied.assign(this.pages.element(brick));
        else {
          const base = target.unpack(brick, coarseSide).mul(2);
          for (const z of [0, 1]) for (const y of [0, 1]) for (const x of [0, 1]) {
            occupied.assign(uint(max(float(occupied),
              float(this.pages.element(this.flatten(base.add(ivec3(x, y, z)), fineSide))))));
          }
        }
        target.pages.element(brick).assign(0);
        If(occupied.greaterThan(uint(0)).and(next.lessThan(target.capacity)), () => {
          target.pages.element(brick).assign(next.add(1));
          target.slots.element(next).assign(brick.add(1));
          next.addAssign(1);
        });
      });
      target.counters.element(0).assign(next);
      target.counters.element(1).assign(0);
    })().compute(1);
    this.coarseNodes.set(target, node);
    renderer.compute(node);
    target.updateDispatch(renderer);
  }

  /** Preserve page identities when replacing a pool with a larger capacity. @internal */
  migrateTo(renderer: ParticleSpatialGridRenderer, target: SparseVolumeGrid): void {
    if (target.capacity < this.capacity || target.brickCount !== this.brickCount
      || target.brickSide !== this.brickSide) throw new Error('Sparse migration requires compatible growing storage.');
    renderer.compute(Fn(() => {
      target.pages.element(instanceIndex).assign(this.pages.element(instanceIndex));
    })().compute(this.brickCount));
    renderer.compute(Fn(() => {
      target.slots.element(instanceIndex).assign(this.slots.element(instanceIndex));
    })().compute(this.capacity));
    target.updateDispatch(renderer);
  }

  /** Rebuilds GPU-only work lists after page assignments change. */
  updateDispatch(renderer: ParticleSpatialGridRenderer): void {
    this.scheduleNode ??= Fn(() => {
      const active = uint(0).toVar();
      const fresh = uint(0).toVar();
      Loop(this.capacity, ({ i }) => {
        const slot = uint(i);
        If(this.slots.element(slot).greaterThan(uint(0)), () => {
          this.activeSlots.element(active).assign(slot);
          active.addAssign(1);
          If(this.fresh.element(slot).greaterThan(uint(0)), () => {
            this.freshSlots.element(fresh).assign(slot);
            fresh.addAssign(1);
          });
        });
      });
      this.pages.element(this.pagesAttribute.count - 1).assign(active.mul(this.cellsPerBrick));
      this.counters.element(0).assign(active);
      this.counters.element(1).assign(atomicLoad(this.requests.element(this.freeOffset + this.capacity + 2)));
      for (let command = 0; command < 4; command++) {
        const args = storage(this.dispatchAttributes[command], 'uint', 3);
        const size = command % 2 ? (this.brickSide + 1) ** 3 : this.cellsPerBrick;
        args.element(0).assign(Math.ceil(size / 64));
        args.element(1).assign(command < 2 ? active : fresh);
        args.element(2).assign(1);
      }
    })().compute(1);
    renderer.compute(this.scheduleNode);
  }

  /** Conservative four-cell source tiles, independent of advected gas occupancy. */
  sourceActive(index: Node<'uint'>): Node<'bool'> {
    const tile = ivec3(floor(vec3(this.coordinate(index)).div(4)));
    const bit = this.flatten(tile, this.sourceTileSide);
    const word = this.pages.element(bit.div(32).add(this.sourceMaskOffset));
    return word.bitAnd(uint(1).shiftLeft(bit.bitAnd(31))).notEqual(0);
  }

  private markSource(position: Node<'vec3'>, radius: Node<'float'>): void {
    const lower = ivec3(clamp(floor(position.sub(radius).div(4)), vec3(0), vec3(this.sourceTileSide - 1)));
    const upper = ivec3(clamp(floor(position.add(radius).div(4)), vec3(0), vec3(this.sourceTileSide - 1)));
    namedLoop({ start: lower.x, end: upper.x.add(1), name: 'sourceX' },
      { start: lower.y, end: upper.y.add(1), name: 'sourceY' }, ({ sourceX, sourceY }) => {
      namedLoop({ start: lower.z, end: upper.z.add(1), name: 'sourceZ' }, ({ sourceZ }) => {
        const bit = this.flatten(ivec3(sourceX, sourceY, sourceZ), this.sourceTileSide);
        atomicOr(this.requests.element(bit.div(32).add(this.brickCount)), uint(1).shiftLeft(bit.bitAnd(31)));
      });
    });
  }

  private copySourceMask(renderer: ParticleSpatialGridRenderer): void {
    this.copySourceMaskNode ??= Fn(() => {
      this.pages.element(instanceIndex.add(this.sourceMaskOffset)).assign(
        atomicLoad(this.requests.element(instanceIndex.add(this.brickCount))),
      );
    })().compute(this.sourceMaskWords);
    renderer.compute(this.copySourceMaskNode);
  }

  updateRenderSourceMask(
    context: GPUParticleUpdateContext,
    renderBuffers: GPUParticleRenderBufferState,
    renderer: ParticleSpatialGridRenderer,
    minimum: Node<'vec3'>,
    cellSize: Node<'float'>,
    tagMask?: number,
  ): void {
    this.resetSourceMaskNode ??= Fn(() => {
      atomicStore(this.requests.element(instanceIndex.add(this.brickCount)), uint(0));
    })().compute(this.sourceMaskWords);
    renderer.compute(this.resetSourceMaskNode);
    const key = [context.buffers.version, renderBuffers.version, context.buffers.count, tagMask].join('|');
    if (key !== this.renderSourceKey) {
      this.renderSourceKey = key;
      this.renderSourceNode = Fn(() => {
        const particle = context.buffers.storage.createParticle(undefined, true);
        const selected = tagMask === undefined ? particle.alive.notEqual(0)
          : particle.alive.notEqual(0).and(particle.tagMask.bitAnd(uint(tagMask)).notEqual(0));
        If(selected, () => {
          const visual = renderBuffers.storage.createVectorNodes(instanceIndex);
          const radius = max(visual.scale.x.abs(), max(visual.scale.y.abs(), visual.scale.z.abs()))
            .mul(0.5).div(cellSize).max(1);
          this.markSource(visual.position.sub(minimum).div(cellSize), radius);
        });
      })().compute(context.buffers.count);
    }
    renderer.compute(this.renderSourceNode!);
    this.copySourceMask(renderer);
  }

  coordinate(index: Node<'uint'>): Node<'ivec3'> {
    const slot = uint(min(float(index.div(this.cellsPerBrick)), this.capacity - 1));
    const brick = this.slots.element(slot).greaterThan(uint(0)).select(this.slots.element(slot), uint(1)).sub(1);
    return this.unpack(brick, 2 ** this.brickSubdivisions).mul(this.brickSide)
      .add(this.unpack(index.mod(this.cellsPerBrick), this.brickSide)) as Node<'ivec3'>;
  }

  index(coordinate: Node<'ivec3'>, pages = this.pages): Node<'uint'> {
    const brick = ivec3(floor(vec3(coordinate).div(this.brickSide)));
    const page = pages.element(this.flatten(brick, 2 ** this.brickSubdivisions));
    const local = coordinate.mod(this.brickSide);
    const address = page.greaterThan(uint(0)).select(page, uint(1)).sub(1).mul(this.cellsPerBrick)
      .add(this.flatten(local, this.brickSide));
    return page.greaterThan(uint(0)).select(address, uint(this.cellCount - 1)) as Node<'uint'>;
  }

  unpack(index: Node<'uint'>, side: number): Node<'ivec3'> {
    return ivec3(int(index.mod(side)), int(index.div(side).mod(side)), int(index.div(side * side)));
  }

  flatten(coordinate: Node<'ivec3'>, side: number): Node<'uint'> {
    return uint(coordinate.x.add(coordinate.y.mul(side)).add(coordinate.z.mul(side * side)));
  }

  private request(position: Node<'vec3'>, radius: Node<'float'>): void {
    const side = 2 ** this.brickSubdivisions;
    const lower = ivec3(clamp(floor(position.sub(radius).div(this.brickSide)), vec3(0), vec3(side - 1)));
    const upper = ivec3(clamp(floor(position.add(radius).div(this.brickSide)), vec3(0), vec3(side - 1)));
    namedLoop({ start: lower.x, end: upper.x.add(1), name: 'brickX' },
      { start: lower.y, end: upper.y.add(1), name: 'brickY' }, ({ brickX, brickY }) => {
      namedLoop({ start: lower.z, end: upper.z.add(1), name: 'brickZ' }, ({ brickZ }) => {
        atomicMax(this.requests.element(this.flatten(ivec3(brickX, brickY, brickZ), side)), uint(1));
      });
    });
  }

  rebuild(
    context: Pick<GPUParticleUpdateContext, 'buffers' | 'deltaTimeNode'>,
    renderer: ParticleSpatialGridRenderer,
    density: Vec4Storage | undefined,
    velocity: Vec4Storage | undefined,
    minimum: Node<'vec3'>,
    cellSize: Node<'float'>,
    cutoff: Node<'float'>,
    tagMask?: number,
    previousBounds?: THREE.Box3,
  ): void {
    // Materialize indirect buffers before even an empty first marking dispatch.
    if (!this.scheduleNode) this.updateDispatch(renderer);
    this.resetNode ??= Fn(() => {
      atomicStore(this.requests.element(instanceIndex), uint(0));
    })().compute(this.requestsAttribute.count);
    renderer.compute(this.resetNode);
    this.snapshotNode ??= Fn(() => {
      this.previousPages.element(instanceIndex).assign(this.pages.element(instanceIndex));
    })().compute(this.brickCount);
    renderer.compute(this.snapshotNode);
    if (density && velocity) {
      const mark = this.markNodes.get(density) ?? this.compute(index => {
        If(density.element(index).x.greaterThanEqual(cutoff), () => {
          const coordinate = vec3(this.coordinate(index)).add(0.5);
          // Preserve emitted gas independently of the source particles, with transport/stencil halos.
          const travel = velocity.element(index).xyz.length().mul(context.deltaTimeNode).div(cellSize);
          this.request(coordinate, travel.add(3));
        });
      });
      this.markNodes.set(density, mark);
      if (previousBounds) {
        this.previousMinimum.value.copy(previousBounds.min);
        this.previousCellSize.value = previousBounds.getSize(new THREE.Vector3()).x / this.cellsPerAxis;
        const remapMark = this.remapMarkNodes.get(density) ?? this.compute(index => {
          If(density.element(index).x.greaterThanEqual(cutoff), () => {
            const position = vec3(this.coordinate(index)).add(0.5)
              .mul(this.previousCellSize).add(this.previousMinimum);
            const travel = velocity.element(index).xyz.length().mul(context.deltaTimeNode).div(cellSize);
            this.request(position.sub(minimum).div(cellSize), travel.add(4));
          });
        });
        this.remapMarkNodes.set(density, remapMark);
        renderer.compute(remapMark);
      } else renderer.compute(mark);
    }

    const key = [context.buffers.version, tagMask].join('|');
    if (key !== this.particleKey || this.particleBuffers !== context.buffers) {
      this.particleKey = key;
      this.particleBuffers = context.buffers;
      this.particleNode = Fn(() => {
        const particle = context.buffers.storage.createParticle(undefined, true);
        const selected = tagMask === undefined ? particle.alive.notEqual(uint(0))
          : particle.alive.notEqual(uint(0)).and(particle.tagMask.bitAnd(uint(tagMask)).notEqual(0));
        If(selected, () => {
          const position = particle.position.sub(minimum).div(cellSize);
          const radius = max(particle.scale.x.abs(), max(particle.scale.y.abs(), particle.scale.z.abs()))
            .mul(0.5).div(cellSize).max(1);
          this.markSource(position, radius);
          const paddedRadius = radius.add(3);
          If(position.add(paddedRadius).greaterThanEqual(vec3(0)).all()
            .and(position.sub(paddedRadius).lessThan(vec3(this.cellsPerAxis)).all()),
          () => this.request(position, paddedRadius));
        });
      })().compute(context.buffers.count);
    }
    this.particleNode!.count = context.buffers.count;
    renderer.compute(this.particleNode!);
    const freeCount = this.freeOffset + this.capacity;
    const cursor = freeCount + 1;
    const overflow = freeCount + 2;
    // Release in parallel, then publish all free slots before any new page can claim one.
    this.releaseNode ??= Fn(() => {
      const slot = instanceIndex;
      this.fresh.element(slot).assign(0);
      const brick = this.slots.element(slot).toVar();
      If(brick.greaterThan(uint(0)), () => {
        If(atomicLoad(this.requests.element(brick.sub(1))).equal(0), () => {
          this.pages.element(brick.sub(1)).assign(0);
          this.slots.element(slot).assign(0);
        });
      });
      If(this.slots.element(slot).equal(0), () => {
        const ticket = atomicAdd(this.requests.element(freeCount), uint(1));
        atomicStore(this.requests.element(ticket.add(this.freeOffset)), slot);
      });
    })().compute(this.capacity).setName('rzmps.volume.release');
    renderer.compute(this.releaseNode);

    // One invocation per logical brick. Retained pages keep their stable addresses.
    this.allocateNode ??= Fn(() => {
      const brick = instanceIndex;
      If(atomicLoad(this.requests.element(brick)).greaterThan(uint(0))
        .and(this.pages.element(brick).equal(0)), () => {
        const ticket = atomicAdd(this.requests.element(cursor), uint(1));
        If(ticket.lessThan(atomicLoad(this.requests.element(freeCount))), () => {
          const slot = atomicLoad(this.requests.element(ticket.add(this.freeOffset))).toVar();
          this.pages.element(brick).assign(slot.add(1));
          this.slots.element(slot).assign(brick.add(1));
          this.fresh.element(slot).assign(1);
        }).Else(() => { atomicAdd(this.requests.element(overflow), uint(1)); });
      });
    })().compute(this.brickCount).setName('rzmps.volume.allocate');
    renderer.compute(this.allocateNode);
    this.updateDispatch(renderer);
    this.copySourceMask(renderer);
  }

  get allocatedBytes(): number {
    return [this.pagesAttribute, this.previousPagesAttribute, this.requestsAttribute,
      this.diagnosticsAttribute, ...this.dispatchAttributes]
      .reduce((sum, attribute) => sum + attribute.array.byteLength, 0);
  }

  dispose(renderer?: ParticleSpatialGridRenderer): void {
    [this.pagesAttribute, this.previousPagesAttribute,
      this.requestsAttribute, this.diagnosticsAttribute,
      ...this.dispatchAttributes].forEach(attribute => {
      destroyGPUStorageAttribute(renderer, attribute);
      attribute.dispose();
    });
  }
}
