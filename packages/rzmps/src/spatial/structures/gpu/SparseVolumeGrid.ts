import StagedGPUAllocation from '../../../utils/gpu/StagedGPUAllocation';
import { initializeStorageAttribute, nextPowerOfTwo } from '../../../utils/gpu/storage.utils';
import { copyStorageAttributes } from '../../../utils/gpu/storage.utils';
import * as THREE from 'three';
import { IndirectStorageBufferAttribute, StorageBufferAttribute, type ComputeNode, type Node } from 'three/webgpu';
import {
  Fn, If, Loop, atomicAdd, atomicMax, atomicLoad, atomicOr, atomicStore, clamp, float, floor,
  globalId, instanceIndex, int, ivec3, max, min, storage, uint, uniform, vec3, vec4, workgroupId,
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
const offsetIndex = (index: Node | number, offset: number | Node<'uint'>) => (
  typeof index === 'number' ? uint(index) : uint(index as Node<'uint'>)
).add(offset);
type Directory = { capacity: number; pages: StorageBufferAttribute; previous: StorageBufferAttribute;
  requests: StorageBufferAttribute; requestFrames: StorageBufferAttribute };
type LayoutSize = number | THREE.Vector3 | Node<'vec3'>;

/**
 * GPU-resident sparse brick pool. Zero is an absent page, not a solid boundary.
 * @internal
 */
export default class SparseVolumeGrid extends SpatialGrid {
  readonly bounds: THREE.Box3;
  capacity: number;
  readonly brickSide: number;
  get brickCount(): number { return this.brickDimensions.x * this.brickDimensions.y * this.brickDimensions.z; }
  readonly cellsPerBrick: number;
  cellCount: number;
  pagesAttribute: StorageBufferAttribute;
  previousPagesAttribute: StorageBufferAttribute;
  slotsAttribute: StorageBufferAttribute;
  newSlotsAttribute: StorageBufferAttribute;
  diagnosticsAttribute: StorageBufferAttribute;
  private timelineAttribute: StorageBufferAttribute;
  private readonly timeline: UintStorage;
  private readonly frame = uniform(0);
  private readonly phaseNodes = new Map<number, ComputeNode>();
  get frameNumber(): number { return this.frame.value; }
  private requestsAttribute: StorageBufferAttribute;
  private requestFramesAttribute: StorageBufferAttribute;
  private readonly requestFrames: UintStorage;
  readonly pages: UintStorage;
  readonly previousPages: UintStorage;
  readonly slots: UintStorage;
  private readonly fresh: UintStorage;
  private readonly requests;
  private readonly helperPages;
  private occupancyAttribute: StorageBufferAttribute;
  private readonly occupied;
  private readonly helperOccupied;
  private occupancyResetNode?: ComputeNode;
  private readonly occupancyNodes = new WeakMap<object, Map<string, ComputeNode>>();
  private receiverHaloNode?: ComputeNode;
  private readonly counters: UintStorage;
  private resetNode?: ComputeNode;
  private allocateNodes?: ComputeNode[];
  private requestCountNode?: ComputeNode;
  private admissionBudgetNode?: ComputeNode;
  private releaseNode?: ComputeNode;
  get directoryCapacity(): number { return this.directoryLayout.value.x; }
  private get freeOffsetNode(): Node<'uint'> { return uint(this.directoryLayout.x.add(this.directoryLayout.y)); }
  private get sourceMaskOffsetNode(): Node<'uint'> {
    return uint(this.directoryLayout.x.add(this.capacityNode.mul(4)));
  }
  /** Reduction scratch reserves the device-supported range, independently of resident allocation. */
  reductionCellCount = 0;
  private readonly capacityNode = uniform(1, 'uint');
  getCapacityNode(): Node<'uint'> { return this.capacityNode; }
  getCellCountNode(): Node<'uint'> { return this.capacityNode.mul(this.cellsPerBrick).add(1); }
  private readonly dimensionsNode = uniform(new THREE.Vector3());
  private readonly directoryLayout = uniform(new THREE.Vector2());
  private readonly previousBrickDimensions = uniform(new THREE.Vector3());
  private readonly translation = uniform(new THREE.Vector3());
  private layoutSlotsAttribute: StorageBufferAttribute;
  private readonly layoutSlots: UintStorage;
  private layoutNodes?: ComputeNode[];
  private directoryAllocation?: StagedGPUAllocation<Directory>;
  private markNodes = new WeakMap<object, ComputeNode>();
  private remapMarkNodes = new WeakMap<object, ComputeNode>();
  private readonly previousMinimum = uniform(new THREE.Vector3());
  private readonly previousCellSize = uniform(1);
  private particleNode?: ComputeNode;
  private particleKey = '';
  private particleBuffers?: GPUParticleUpdateContext['buffers'];
  private snapshotNode?: ComputeNode;
  private readonly sourceTileSide: THREE.Vector3;
  get sourceMaskWords(): number { return this.directoryLayout.value.y; }
  get sourceMaskOffset(): number { return this.directoryCapacity + this.capacity * 4; }
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

  constructor(options: Partial<ParticleSpatialGridOptions>, capacity: number, dimensions?: THREE.Vector3,
    directoryCapacity?: number) {
    super();
    if (!Number.isFinite(capacity) || capacity < 1) {
      throw new RangeError('maxActiveBricks must be finite and positive.');
    }
    this._brickSubdivisions = options.brickSubdivisions ?? 2;
    this._cellSubdivisions = options.cellSubdivisions ?? 3;
    this.bounds = options.bounds?.clone() ?? new THREE.Box3();
    this.brickSide = 2 ** this.cellSubdivisions;
    this.gridDimensions.copy(dimensions ?? new THREE.Vector3().setScalar(this.cellsPerAxis));
    this.brickDimensions.copy(this.gridDimensions).divideScalar(this.brickSide).ceil();
    this.gridDimensions.copy(this.brickDimensions).multiplyScalar(this.brickSide);
    this.cellSize = options.bounds ? options.bounds.getSize(new THREE.Vector3()).x / this.gridDimensions.x : 1;
    this.brickSize = this.cellSize * this.brickSide;
    this.capacity = Math.max(1, Math.floor(capacity));
    this.capacityNode.value = this.capacity;
    this.cellsPerBrick = this.brickSide ** 3;
    this.sourceTileSide = this.gridDimensions.clone().divideScalar(4).ceil();
    const directory = this.createDirectory(directoryCapacity ?? nextPowerOfTwo(Math.max(
      this.brickCount * 2, Math.min(65536, 2 ** (3 * (this.brickSubdivisions + 1))),
    )));
    this.directoryLayout.value.set(directory.capacity, this.maskWords(directory.capacity));
    this.dimensionsNode.value.copy(this.gridDimensions);
    // Resident storage is independent of logical rectangle and directory backing capacity.
    this.cellCount = this.capacity * this.cellsPerBrick + 1;
    const attribute = (count: number) => new StorageBufferAttribute(new Uint32Array(count), 1);
    this.pagesAttribute = directory.pages;
    this.previousPagesAttribute = directory.previous;
    this.slotsAttribute = this.newSlotsAttribute = this.pagesAttribute;
    this.requestsAttribute = directory.requests;
    this.requestFramesAttribute = directory.requestFrames;
    this.layoutSlotsAttribute = attribute(this.capacity);
    this.diagnosticsAttribute = attribute(12);
    this.timelineAttribute = attribute(this.capacity * 8);
    const node = (value: StorageBufferAttribute) => storage(value, 'uint', value.count) as UintStorage;
    this.pages = node(this.pagesAttribute);
    this.previousPages = node(this.previousPagesAttribute);
    this.slots = { element: index => this.pages.element(offsetIndex(index, uint(this.directoryLayout.x))) };
    this.fresh = {
      element: index => this.pages.element(offsetIndex(index, uint(this.directoryLayout.x).add(this.capacityNode))),
    };
    this.activeSlots = {
      element: index => this.pages.element(offsetIndex(index,
        uint(this.directoryLayout.x).add(this.capacityNode.mul(2)))),
    };
    this.freshSlots = {
      element: index => this.pages.element(offsetIndex(index,
        uint(this.directoryLayout.x).add(this.capacityNode.mul(3)))),
    };
    this.layoutSlots = node(this.layoutSlotsAttribute);
    this.timeline = node(this.timelineAttribute);
    this.counters = node(this.diagnosticsAttribute);
    this.requestFrames = node(this.requestFramesAttribute);
    this.requests = storage(this.requestsAttribute, 'uint', this.requestsAttribute.count).toAtomic();
    this.helperPages = storage(this.pagesAttribute, 'uint', this.pagesAttribute.count).toReadOnly();
    this.occupancyAttribute = attribute(this.capacity);
    this.occupied = storage(this.occupancyAttribute, 'uint', this.capacity).toAtomic();
    this.helperOccupied = storage(this.occupancyAttribute, 'uint', this.capacity).toReadOnly();
  }

  private maskWords(capacity: number): number {
    return Math.ceil(capacity * Math.max(1, this.brickSide / 4) ** 3 / 32);
  }

  private createDirectory(capacity: number): Directory {
    const words = this.maskWords(capacity);
    const attribute = (count: number) => new StorageBufferAttribute(new Uint32Array(count), 1);
    return { capacity, pages: attribute(capacity + this.capacity * 4 + words + 1),
      previous: attribute(capacity), requests: attribute(capacity + words + this.capacity + 32),
      requestFrames: attribute(capacity) };
  }

  /** CPU metadata only; coarse corrections are rebuilt from the fine topology after this update. */
  setLayoutMetadata(bounds: THREE.Box3, dimensions: THREE.Vector3): void {
    this.bounds.copy(bounds);
    this.gridDimensions.copy(dimensions);
    this.brickDimensions.copy(dimensions).divideScalar(this.brickSide);
    this.dimensionsNode.value.copy(dimensions);
    this.sourceTileSide.copy(dimensions).divideScalar(4).ceil();
    if (this.allocateNodes) this.allocateNodes.forEach(node => { node.count = this.brickCount; });
  }

  private maximumDirectoryCapacity(renderer: ParticleSpatialGridRenderer): number {
    const device = (renderer.backend as { device: { limits: { maxStorageBufferBindingSize: number } } }).device;
    const words = Math.floor(device.limits.maxStorageBufferBindingSize / 4);
    const maskRatio = Math.max(1, this.brickSide / 4) ** 3 / 32;
    const available = words - this.capacity * 4 - 2;
    return Math.max(this.directoryCapacity, Math.floor(available / (1 + maskRatio)));
  }

  /** Backing capacity grows independently; compiled kernels keep their storage-node identities. */
  ensureDirectory(renderer: ParticleSpatialGridRenderer, dimensions: THREE.Vector3, minimumCapacity = 0): boolean {
    const required = Math.max(minimumCapacity, dimensions.x * dimensions.y * dimensions.z / this.cellsPerBrick);
    this.directoryAllocation?.commit();
    if (required <= this.directoryCapacity) return true;
    const attributes = (d: Directory) => [d.pages, d.previous, d.requests, d.requestFrames];
    this.directoryAllocation ??= new StagedGPUAllocation<Directory>({ capacity: this.directoryCapacity,
      pages: this.pagesAttribute, previous: this.previousPagesAttribute, requests: this.requestsAttribute,
      requestFrames: this.requestFramesAttribute },
    this.directoryCapacity, {
      maximumCapacity: this.maximumDirectoryCapacity(renderer),
      create: capacity => this.createDirectory(capacity),
      prepare: async directory => {
        for (const attribute of attributes(directory)) {
          initializeStorageAttribute(renderer, attribute);
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      },
      migrate: (old, next) => {
        const oldMask = old.capacity + this.capacity * 4, nextMask = next.capacity + this.capacity * 4;
        copyStorageAttributes(renderer, [
          { source: old.requestFrames, target: next.requestFrames, byteLength: old.capacity * 4 },
          { source: old.pages, target: next.pages, byteLength: old.capacity * 4 },
          { source: old.pages, target: next.pages, sourceOffset: old.capacity * 4,
            targetOffset: next.capacity * 4, byteLength: this.capacity * 16 },
          { source: old.pages, target: next.pages, sourceOffset: oldMask * 4, targetOffset: nextMask * 4,
            byteLength: this.maskWords(old.capacity) * 4 },
          { source: old.pages, target: next.pages, sourceOffset: (old.pages.count - 1) * 4,
            targetOffset: (next.pages.count - 1) * 4, byteLength: 4 },
        ]);
      },
      swap: directory => {
        this.pagesAttribute = this.slotsAttribute = this.newSlotsAttribute = directory.pages;
        this.previousPagesAttribute = directory.previous;
        this.requestsAttribute = directory.requests;
        this.requestFramesAttribute = directory.requestFrames;
        this.directoryLayout.value.set(directory.capacity, this.maskWords(directory.capacity));
        for (const [node, attribute] of [[this.pages, directory.pages], [this.previousPages, directory.previous],
          [this.requests, directory.requests], [this.requestFrames, directory.requestFrames],
          [this.helperPages, directory.pages]] as const) {
          (node as unknown as { value: StorageBufferAttribute }).value = attribute;
        }
        if (this.snapshotNode) this.snapshotNode.count = this.directoryCapacity;
        if (this.resetNode) this.resetNode.count = this.requestsAttribute.count;
        if (this.copySourceMaskNode) this.copySourceMaskNode.count = this.sourceMaskWords;
        if (this.resetSourceMaskNode) this.resetSourceMaskNode.count = this.sourceMaskWords;
        if (this.layoutNodes) this.layoutNodes[1].count = this.directoryCapacity;
      },
      dispose: directory => attributes(directory).forEach(attribute => {
        destroyGPUStorageAttribute(renderer, attribute); attribute.dispose();
      }),
      fence: () => (renderer.backend as { device: { queue: { onSubmittedWorkDone(): Promise<void> } } })
        .device.queue.onSubmittedWorkDone(),
    });
    this.directoryAllocation.request(required);
    return false;
  }

  /** Same-scale changes only rewrite directory metadata; retained resident cells are never resampled. */
  updateLayout(renderer: ParticleSpatialGridRenderer, bounds: THREE.Box3, dimensions: THREE.Vector3): boolean {
    if (!this.ensureDirectory(renderer, dimensions)) return false;
    if (this.bounds.equals(bounds) && this.gridDimensions.equals(dimensions)) return true;
    const offset = this.bounds.min.clone().sub(bounds.min).divideScalar(this.brickSize);
    if (offset.clone().sub(offset.clone().round()).length() > 1e-5) {
      throw new Error('Same-tier domain origins must differ by whole bricks.');
    }
    this.previousBrickDimensions.value.copy(this.brickDimensions);
    this.translation.value.copy(offset.round());
    this.setLayoutMetadata(bounds, dimensions);
    this.layoutNodes ??= [
      Fn(() => { this.layoutSlots.element(instanceIndex).assign(this.slots.element(instanceIndex)); })()
        .compute(this.capacity).setName('rzmps.domain.snapshot'),
      Fn(() => {
        this.pages.element(instanceIndex).assign(0); this.requestFrames.element(instanceIndex).assign(0);
      })()
        .compute(this.directoryCapacity).setName('rzmps.domain.clearDirectory'),
      Fn(() => {
        const encoded = this.layoutSlots.element(instanceIndex).toVar();
        this.slots.element(instanceIndex).assign(0);
        this.fresh.element(instanceIndex).assign(0);
        If(encoded.greaterThan(0), () => {
          const coordinate = this.unpack(encoded.sub(1), this.previousBrickDimensions).add(ivec3(this.translation));
          If(vec3(coordinate).greaterThanEqual(0).all()
            .and(vec3(coordinate).lessThan(this.getBrickDimensionsNode()).all()), () => {
            const logical = this.flatten(coordinate, this.brickDimensions);
            this.pages.element(logical).assign(instanceIndex.add(1));
            this.slots.element(instanceIndex).assign(logical.add(1));
            this.requestFrames.element(logical).assign(this.timeline.element(instanceIndex.mul(8)));
          });
        });
      })().compute(this.capacity).setName('rzmps.domain.reindex'),
    ];
    renderer.compute(this.layoutNodes);
    this.updateDispatch(renderer);
    return true;
  }

  /** @internal Capturing shaders must not advance the logical simulation frame counter. */
  capturePreparation<T>(operation: () => T): T {
    const frame = this.frame.value;
    try { return operation(); } finally { this.frame.value = frame; }
  }

  /** Compile the layout-only kernels before the first live resize. */
  async prepareLayout(renderer: ParticleSpatialGridRenderer): Promise<void> {
    const nodes: ComputeNode[] = [], compute = renderer.compute;
    const shifted = this.bounds.clone().translate(new THREE.Vector3(this.brickSize, 0, 0));
    const old = this.bounds.clone();
    renderer.compute = value => { nodes.push(...(Array.isArray(value) ? value : [value])); };
    try { this.updateLayout(renderer, shifted, this.gridDimensions.clone()); }
    finally {
      renderer.compute = compute;
      this.setLayoutMetadata(old, this.gridDimensions);
    }
    await (renderer as ParticleSpatialGridRenderer & {
      compileComputeAsync?(nodes: ComputeNode[]): Promise<void>;
    }).compileComputeAsync?.(nodes);
  }

  protected invalidateStructure(): void {
    throw new Error('Change sparse field structure through the owning module spatialGridOptions.');
  }

  /** GPU-produced compact range; its count shares the page binding used for address mapping. */
  get activeCellCount(): Node<'uint'> {
    return this.pages.element(this.sourceMaskOffsetNode.add(uint(this.directoryLayout.y)));
  }

  /** GPU-owned mapping generation; source/velocity changes alone leave it unchanged. @internal */
  get topologyGeneration(): Node<'uint'> { return this.counters.element(11); }

  /** Physical compact-list length for indirect stage dispatch, independent of policy estimates. @internal */
  get activePageCount(): Node<'uint'> { return this.counters.element(0); }

  compactCell(index: Node<'uint'>): Node<'uint'> {
    return this.activeSlots.element(index.div(this.cellsPerBrick)).mul(this.cellsPerBrick)
      .add(index.mod(this.cellsPerBrick));
  }

  active(index: Node<'uint'>): Node<'bool'> {
    const slot = uint(min(float(index.div(this.cellsPerBrick)), float(this.capacityNode.sub(1))));
    return index.lessThan(this.getCellCountNode().sub(1)).and(this.slots.element(slot).greaterThan(uint(0)));
  }

  isNew(index: Node<'uint'>): Node<'bool'> {
    const slot = uint(min(float(index.div(this.cellsPerBrick)), float(this.capacityNode.sub(1))));
    return this.fresh.element(slot).greaterThan(uint(0));
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
      const brick = this.unpack(this.slots.element(slot).sub(1), this.brickDimensions);
      const local = this.unpack(index.mod(size), faces ? b + 1 : b);
      const coordinate = brick.mul(b).add(local);
      if (!faces) {
        callback(this.flatten(coordinate, this.gridDimensions));
        return;
      }
      // The upper brick owns a shared face. At sparse edges, the lower brick
      // supplies the otherwise missing face, including domain boundaries.
      const owner = ivec3(min(vec3(coordinate.div(b)), this.getBrickDimensionsNode().sub(1)));
      const page = this.pages.element(this.flatten(owner, this.brickDimensions));
      const owns = page.equal(slot.add(1)).or(page.equal(0));
      // At edges/corners more than one lower brick can touch a missing owner;
      // only axis faces are used, but each dense vec4 still needs one writer.
      const lower = ivec3(max(vec3(coordinate.sub(1).div(b)), vec3(0)));
      const selected = uint(0).toVar();
      for (const z of [0, 1]) for (const y of [0, 1]) for (const x of [0, 1]) {
        const candidate = ivec3(x ? owner.x : lower.x, y ? owner.y : lower.y, z ? owner.z : lower.z);
        const encoded = this.pages.element(this.flatten(candidate, this.brickDimensions));
        If(encoded.greaterThan(uint(0)), () => { selected.assign(encoded); });
      }
      If(owns.and(selected.equal(slot.add(1))), () => {
        callback(this.flatten(coordinate, this.dimensionsNode.add(1)));
      });
    }, faces, fresh);
  }

  /** Derive sparse coarse occupancy without allocating absent fine regions. @internal */
  restrictOccupancyTo(renderer: ParticleSpatialGridRenderer, target: SparseVolumeGrid, enabled?: Node<'bool'>): void {
    const sameBricks = target.brickSide * 2 === this.brickSide;
    const fineSide = this.brickDimensions;
    const coarseSide = target.brickDimensions;
    const node = this.coarseNodes.get(target) ?? Fn(() => {
      const build = () => {
        const next = uint(0).toVar();
        Loop(target.capacityNode, ({ i }) => { target.slots.element(uint(i)).assign(0); });
        Loop(uint(target.getBrickDimensionsNode().x.mul(target.getBrickDimensionsNode().y)
          .mul(target.getBrickDimensionsNode().z)), ({ i }) => {
          const brick = uint(i);
          const occupied = uint(0).toVar();
          if (sameBricks) occupied.assign(this.pages.element(brick));
          else {
            const base = target.unpack(brick, coarseSide).mul(2);
            for (const z of [0, 1]) for (const y of [0, 1]) for (const x of [0, 1]) {
              const child = base.add(ivec3(x, y, z));
              If(vec3(child).lessThan(this.getBrickDimensionsNode()).all(), () => {
                occupied.assign(uint(max(float(occupied), float(this.pages.element(this.flatten(child, fineSide))))));
              });
            }
          }
          target.pages.element(brick).assign(0);
          If(occupied.greaterThan(uint(0)).and(next.lessThan(target.capacityNode)), () => {
            target.pages.element(brick).assign(next.add(1));
            target.slots.element(next).assign(brick.add(1));
            next.addAssign(1);
          });
        });
        target.counters.element(0).assign(next);
        target.counters.element(1).assign(0);
      };
      if (enabled) If(enabled, build);
      else build();
    })().compute(1);
    this.coarseNodes.set(target, node);
    renderer.compute(node);
    target.updateDispatch(renderer);
  }

  /** Capacity-owned metadata only. Indirect commands and every compiled node stay with the live grid. */
  get capacityAttributes(): StorageBufferAttribute[] {
    return [this.pagesAttribute, this.previousPagesAttribute, this.requestsAttribute, this.requestFramesAttribute,
      this.diagnosticsAttribute, this.timelineAttribute, this.layoutSlotsAttribute, this.occupancyAttribute];
  }

  /** Prefix page identities are unchanged. Packed directory segments are copied to their new offsets. */
  migrateCapacity(renderer: ParticleSpatialGridRenderer, target: SparseVolumeGrid): void {
    if (target.capacity < this.capacity || target.directoryCapacity !== this.directoryCapacity) {
      throw new Error('Resident growth requires a compatible directory and increasing capacity.');
    }
    const copies = [
      { source: this.pagesAttribute, target: target.pagesAttribute, byteLength: this.directoryCapacity * 4 },
      { source: this.previousPagesAttribute, target: target.previousPagesAttribute },
      { source: this.requestFramesAttribute, target: target.requestFramesAttribute },
      { source: this.timelineAttribute, target: target.timelineAttribute },
      { source: this.occupancyAttribute, target: target.occupancyAttribute },
      { source: this.diagnosticsAttribute, target: target.diagnosticsAttribute },
      { source: this.pagesAttribute, target: target.pagesAttribute,
        sourceOffset: this.sourceMaskOffset * 4, targetOffset: target.sourceMaskOffset * 4,
        byteLength: (this.sourceMaskWords + 1) * 4 },
    ];
    for (let segment = 0; segment < 4; segment++) copies.push({
      source: this.pagesAttribute, target: target.pagesAttribute,
      sourceOffset: (this.directoryCapacity + segment * this.capacity) * 4,
      targetOffset: (target.directoryCapacity + segment * target.capacity) * 4,
      byteLength: this.capacity * 4,
    });
    copyStorageAttributes(renderer, copies);
  }

  /** Swap backing attributes only: cached graphs keep their node, uniform and indirect-buffer identities. */
  adoptCapacity(target: SparseVolumeGrid): StorageBufferAttribute[] {
    // A concurrently prepared directory packs its slot lists using the old resident stride.
    // Its logical target will retry against the new backing; it must never swap old-stride storage later.
    this.directoryAllocation?.cancelPending();
    this.directoryAllocation = undefined;
    const previous = this.capacityAttributes;
    this.capacity = target.capacity;
    this.cellCount = target.cellCount;
    this.capacityNode.value = this.capacity;
    for (const key of ['pagesAttribute', 'previousPagesAttribute', 'requestsAttribute', 'requestFramesAttribute',
      'diagnosticsAttribute', 'timelineAttribute', 'layoutSlotsAttribute', 'occupancyAttribute'] as const) {
      this[key] = target[key];
    }
    for (const [node, attribute] of [
      [this.pages, this.pagesAttribute], [this.previousPages, this.previousPagesAttribute],
      [this.requests, this.requestsAttribute], [this.requestFrames, this.requestFramesAttribute],
      [this.counters, this.diagnosticsAttribute], [this.timeline, this.timelineAttribute],
      [this.layoutSlots, this.layoutSlotsAttribute], [this.occupied, this.occupancyAttribute],
      [this.helperPages, this.pagesAttribute], [this.helperOccupied, this.occupancyAttribute]] as const) {
      (node as unknown as { value: StorageBufferAttribute }).value = attribute;
    }
    if (this.resetNode) this.resetNode.count = this.requestsAttribute.count;
    if (this.releaseNode) this.releaseNode.count = this.capacity;
    if (this.occupancyResetNode) this.occupancyResetNode.count = this.capacity;
    this.phaseNodes.forEach(node => { node.count = this.capacity; });
    if (this.layoutNodes) {
      this.layoutNodes[0].count = this.capacity;
      this.layoutNodes[2].count = this.capacity;
    }
    return previous;
  }

  /** Preserve page identities when replacing a pool with a larger capacity. @internal */
  migrateTo(renderer: ParticleSpatialGridRenderer, target: SparseVolumeGrid): void {
    if (target.capacity < this.capacity || target.directoryCapacity < this.directoryCapacity
      || !target.gridDimensions.equals(this.gridDimensions)
      || target.brickSide !== this.brickSide) throw new Error('Sparse migration requires compatible growing storage.');
    copyStorageAttributes(renderer, [
      { source: this.pagesAttribute, target: target.pagesAttribute, byteLength: this.directoryCapacity * 4 },
      { source: this.pagesAttribute, target: target.pagesAttribute,
        sourceOffset: this.directoryCapacity * 4, targetOffset: target.directoryCapacity * 4,
        byteLength: this.capacity * 4 },
    ]);
    copyStorageAttributes(renderer, [{ source: this.timelineAttribute, target: target.timelineAttribute,
      byteLength: this.capacity * 8 * 4 },
      { source: this.requestFramesAttribute, target: target.requestFramesAttribute,
        byteLength: this.directoryCapacity * 4 }]);
    target.frame.value = this.frame.value;
    target.updateDispatch(renderer);
  }

  /** Rebuilds GPU-only work lists after page assignments change. */
  updateDispatch(renderer: ParticleSpatialGridRenderer): void {
    this.scheduleNode ??= Fn(() => {
      const previousActive = this.counters.element(0).toVar();
      const active = uint(0).toVar();
      const fresh = uint(0).toVar();
      Loop(this.capacityNode, ({ i }) => {
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
      this.pages.element(this.sourceMaskOffsetNode.add(uint(this.directoryLayout.y)))
        .assign(active.mul(this.cellsPerBrick));
      this.counters.element(0).assign(active);
      this.counters.element(1).assign(atomicLoad(
        this.requests.element(this.freeOffsetNode.add(this.capacityNode.add(2))),
      ));
      const base = this.freeOffsetNode.add(this.capacityNode);
      const requested = uint(0).toVar();
      for (let priority = 0; priority < 5; priority++) {
        const count = atomicLoad(this.requests.element(base.add(3 + priority)));
        requested.addAssign(count);
        this.counters.element(6 + priority).assign(count);
      }
      this.counters.element(2).assign(requested);
      this.counters.element(3).assign(fresh);
      this.counters.element(4).assign(atomicLoad(this.requests.element(base.add(18))));
      If(active.notEqual(previousActive).or(fresh.greaterThan(0))
        .or(this.counters.element(4).greaterThan(0)), () => this.counters.element(11).addAssign(1));
      this.counters.element(5).assign(active);
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
    const word = this.pages.element(bit.div(32).add(this.sourceMaskOffsetNode));
    return word.bitAnd(uint(1).shiftLeft(bit.bitAnd(31))).notEqual(0);
  }

  private markSource(position: Node<'vec3'>, radius: Node<'float'>): void {
    const lower = ivec3(clamp(floor(position.sub(radius).div(4)), vec3(0), this.dimensionsNode.div(4).ceil().sub(1)));
    const upper = ivec3(clamp(floor(position.add(radius).div(4)), vec3(0), this.dimensionsNode.div(4).ceil().sub(1)));
    namedLoop({ start: lower.x, end: upper.x.add(1), name: 'sourceX' },
      { start: lower.y, end: upper.y.add(1), name: 'sourceY' }, ({ sourceX, sourceY }) => {
      namedLoop({ start: lower.z, end: upper.z.add(1), name: 'sourceZ' }, ({ sourceZ }) => {
        const bit = this.flatten(ivec3(sourceX, sourceY, sourceZ), this.sourceTileSide);
        atomicOr(this.requests.element(bit.div(32).add(uint(this.directoryLayout.x))),
          uint(1).shiftLeft(bit.bitAnd(31)));
      });
    });
  }

  private copySourceMask(renderer: ParticleSpatialGridRenderer): void {
    this.copySourceMaskNode ??= Fn(() => {
      this.pages.element(instanceIndex.add(this.sourceMaskOffsetNode)).assign(
        atomicLoad(this.requests.element(instanceIndex.add(uint(this.directoryLayout.x)))),
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
      atomicStore(this.requests.element(instanceIndex.add(uint(this.directoryLayout.x))), uint(0));
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
    const slot = uint(min(float(index.div(this.cellsPerBrick)), float(this.capacityNode.sub(1))));
    const brick = this.slots.element(slot).greaterThan(uint(0)).select(this.slots.element(slot), uint(1)).sub(1);
    return this.unpack(brick, this.brickDimensions).mul(this.brickSide)
      .add(this.unpack(index.mod(this.cellsPerBrick), this.brickSide)) as Node<'ivec3'>;
  }

  index(coordinate: Node<'ivec3'>, pages = this.pages): Node<'uint'> {
    const inside = vec3(coordinate).greaterThanEqual(0).all()
      .and(vec3(coordinate).lessThan(this.getDimensionsNode()).all());
    const brick = ivec3(clamp(floor(vec3(coordinate).div(this.brickSide)),
      vec3(0), this.getBrickDimensionsNode().sub(1)));
    const page = pages.element(this.flatten(brick, this.brickDimensions));
    const local = coordinate.mod(this.brickSide);
    const address = page.greaterThan(uint(0)).select(page, uint(1)).sub(1).mul(this.cellsPerBrick)
      .add(this.flatten(local, this.brickSide));
    return inside.and(page.greaterThan(uint(0))).select(address, this.getCellCountNode().sub(1)) as Node<'uint'>;
  }

  /** Keep resident slots at the same world-space brick on same-scale translation/extent changes. */
  reindexFrom(renderer: ParticleSpatialGridRenderer, previous: SparseVolumeGrid): void {
    if (this.capacity !== previous.capacity || this.brickSide !== previous.brickSide
      || Math.abs(this.cellSize - previous.cellSize) > 1e-9) {
      throw new Error('Exact sparse reindexing requires matching resident layout and cell size.');
    }
    const offset = previous.bounds.min.clone().sub(this.bounds.min).divideScalar(this.brickSize);
    if (offset.clone().sub(offset.clone().round()).length() > 1e-5) {
      throw new Error('Sparse domain translation must be brick aligned.');
    }
    offset.round();
    const migrate = Fn(() => {
      const encoded = previous.slots.element(instanceIndex).toVar();
      this.slots.element(instanceIndex).assign(0);
      If(encoded.greaterThan(0), () => {
        const coordinate = previous.unpack(encoded.sub(1), previous.brickDimensions).add(ivec3(offset));
        If(vec3(coordinate).greaterThanEqual(0).all()
          .and(vec3(coordinate).lessThan(this.getBrickDimensionsNode()).all()), () => {
          const logical = this.flatten(coordinate, this.brickDimensions);
          this.pages.element(logical).assign(instanceIndex.add(1));
          this.slots.element(instanceIndex).assign(logical.add(1));
        });
      });
    })().compute(this.capacity);
    renderer.compute(migrate);
    this.updateDispatch(renderer);
  }

  getDimensionsNode(): Node<'vec3'> { return this.dimensionsNode; }
  getBrickDimensionsNode(): Node<'vec3'> { return this.dimensionsNode.div(this.brickSide); }

  private sizeNode(side: LayoutSize): Node<'vec3'> {
    if (side === this.gridDimensions) return this.dimensionsNode;
    if (side === this.brickDimensions) return this.getBrickDimensionsNode();
    if (side === this.sourceTileSide) return this.dimensionsNode.div(4).ceil();
    return typeof side === 'number' ? vec3(side)
      : (side as THREE.Vector3).isVector3 ? vec3(side as THREE.Vector3) : side as Node<'vec3'>;
  }

  unpack(index: Node<'uint'>, side: LayoutSize): Node<'ivec3'> {
    const size = this.sizeNode(side);
    return ivec3(int(index.mod(uint(size.x))), int(index.div(uint(size.x)).mod(uint(size.y))),
      int(index.div(uint(size.x.mul(size.y)))));
  }

  flatten(coordinate: Node<'ivec3'>, side: LayoutSize): Node<'uint'> {
    const size = this.sizeNode(side);
    return uint(coordinate.x.add(coordinate.y.mul(int(size.x))).add(coordinate.z.mul(int(size.x.mul(size.y)))));
  }

  private request(position: Node<'vec3'>, radius: Node<'float'>, priority = 2): void {
    const side = this.brickDimensions;
    const lower = ivec3(clamp(floor(position.sub(radius).div(this.brickSide)), vec3(0), this.sizeNode(side).sub(1)));
    const upper = ivec3(clamp(floor(position.add(radius).div(this.brickSide)), vec3(0), this.sizeNode(side).sub(1)));
    namedLoop({ start: lower.x, end: upper.x.add(1), name: 'brickX' },
      { start: lower.y, end: upper.y.add(1), name: 'brickY' }, ({ brickX, brickY }) => {
      namedLoop({ start: lower.z, end: upper.z.add(1), name: 'brickZ' }, ({ brickZ }) => {
        atomicMax(this.requests.element(this.flatten(ivec3(brickX, brickY, brickZ), side)), uint(priority));
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
    stencilRadius = 3,
    previousGrid?: SparseVolumeGrid,
    simulationStep?: number,
  ): void {
    this.frame.value = simulationStep ?? this.frame.value + 1;
    // Materialize indirect buffers before even an empty first marking dispatch.
    if (!this.scheduleNode) this.updateDispatch(renderer);
    this.resetNode ??= Fn(() => {
      atomicStore(this.requests.element(instanceIndex), uint(0));
    })().compute(this.requestsAttribute.count);
    renderer.compute(this.resetNode);
    this.snapshotNode ??= Fn(() => {
      this.previousPages.element(instanceIndex).assign(this.pages.element(instanceIndex));
    })().compute(this.directoryCapacity);
    renderer.compute(this.snapshotNode);
    if (density && velocity) {
      const mark = this.markNodes.get(density) ?? this.compute(index => {
        If(density.element(index).x.greaterThan(0).and(density.element(index).x.greaterThanEqual(cutoff)), () => {
          const coordinate = vec3(this.coordinate(index)).add(0.5);
          // Preserve emitted gas independently of the source particles, with transport/stencil halos.
          const travel = velocity.element(index).xyz.length().mul(context.deltaTimeNode).div(cellSize);
          this.request(coordinate, float(0), 5);
          this.request(coordinate, travel.add(1), 4);
          this.request(coordinate, travel.add(3), 2);
        });
      });
      this.markNodes.set(density, mark);
      if (previousBounds) {
        const source = previousGrid ?? this;
        this.previousMinimum.value.copy(previousBounds.min);
        this.previousCellSize.value = source.cellSize;
        const remapMark = this.remapMarkNodes.get(density) ?? source.compute(index => {
          If(density.element(index).x.greaterThan(0).and(density.element(index).x.greaterThanEqual(cutoff)), () => {
            const position = vec3(source.coordinate(index)).add(0.5)
              .mul(this.previousCellSize).add(this.previousMinimum);
            const travel = velocity.element(index).xyz.length().mul(context.deltaTimeNode).div(cellSize);
            const coordinate = position.sub(minimum).div(cellSize);
            this.request(coordinate, float(0), 5);
            this.request(coordinate, travel.add(1), 4);
            this.request(coordinate, travel.add(4), 2);
          });
        });
        this.remapMarkNodes.set(density, remapMark);
        renderer.compute(remapMark);
      } else renderer.compute(mark);
    }

    const key = [context.buffers.version, tagMask, stencilRadius].join('|');
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
          if (!density) this.request(position, float(0), 5);
          this.request(position, radius, density ? 3 : 4);
          const paddedRadius = radius.add(stencilRadius);
          If(position.add(paddedRadius).greaterThanEqual(vec3(0)).all()
            .and(position.sub(paddedRadius).lessThan(this.getDimensionsNode()).all()),
          () => this.request(position, paddedRadius));
        });
      })().compute(context.buffers.count);
    }
    this.particleNode!.count = context.buffers.count;
    renderer.compute(this.particleNode!);
    if (density) this.requestReceiverHalo(renderer);
    this.admitRequests(renderer);
    this.copySourceMask(renderer);
  }

  /** A physical brick gets its full one-brick receiver ring before the next transport dispatch. */
  private requestReceiverHalo(renderer: ParticleSpatialGridRenderer): void {
    this.receiverHaloNode ??= Fn(() => {
      // Only physical requests seed the ring. Halo writes cannot recursively grow the ring.
      If(atomicLoad(this.requests.element(instanceIndex)).equal(5), () => {
        const center = this.unpack(instanceIndex, this.brickDimensions);
        for (const z of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const x of [-1, 0, 1]) {
          if (x === 0 && y === 0 && z === 0) continue;
          const neighbor = center.add(ivec3(x, y, z));
          If(vec3(neighbor).greaterThanEqual(0).all()
            .and(vec3(neighbor).lessThan(this.getBrickDimensionsNode()).all()), () => {
            atomicMax(this.requests.element(this.flatten(neighbor, this.brickDimensions)), uint(4));
          });
        }
      });
    })().compute(this.brickCount).setName('rzmps.volume.receiverBrickRing');
    this.receiverHaloNode.count = this.brickCount;
    renderer.compute(this.receiverHaloNode);
  }

  /** Persistent state > immediate transport > sources > stencil > speculative halo. */
  admitRequests(renderer: ParticleSpatialGridRenderer): void {
    const freeCount = this.freeOffsetNode.add(this.capacityNode), cursor = freeCount.add(1);
    const overflow = freeCount.add(2);
    const counts = freeCount.add(3), budgets = freeCount.add(8), admitted = freeCount.add(13);
    this.requestCountNode ??= Fn(() => {
      const priority = atomicLoad(this.requests.element(instanceIndex));
      If(priority.greaterThan(0), () => {
        atomicAdd(this.requests.element(counts.add(priority.sub(1))), uint(1));
        If(this.requestFrames.element(instanceIndex).equal(0), () => {
          this.requestFrames.element(instanceIndex).assign(uint(this.frame));
        });
      }).Else(() => { this.requestFrames.element(instanceIndex).assign(0); });
    })().compute(this.brickCount).setName('rzmps.volume.countRequests');
    this.requestCountNode.count = this.brickCount;
    renderer.compute(this.requestCountNode);

    // Reserve a quota per necessity class before retaining or admitting any page.
    this.admissionBudgetNode ??= Fn(() => {
      const remaining = this.capacityNode.toVar();
      for (let priority = 4; priority >= 0; priority--) {
        const count = atomicLoad(this.requests.element(counts.add(priority)));
        const budget = uint(min(float(count), float(remaining)));
        atomicStore(this.requests.element(budgets.add(priority)), budget);
        remaining.subAssign(budget);
      }
    })().compute(1).setName('rzmps.volume.admissionBudgets');
    renderer.compute(this.admissionBudgetNode);

    this.releaseNode ??= Fn(() => {
      const slot = instanceIndex;
      this.fresh.element(slot).assign(0);
      const brick = this.slots.element(slot).toVar();
      If(brick.greaterThan(0), () => {
        const priority = atomicLoad(this.requests.element(brick.sub(1)));
        const retain = uint(0).toVar();
        If(priority.greaterThan(0), () => {
          const ticket = atomicAdd(this.requests.element(admitted.add(priority.sub(1))), uint(1));
          retain.assign(ticket.lessThan(atomicLoad(this.requests.element(budgets.add(priority.sub(1))))).select(1, 0));
        });
        If(retain.equal(0), () => {
          this.pages.element(brick.sub(1)).assign(0);
          this.slots.element(slot).assign(0);
          atomicAdd(this.requests.element(freeCount.add(18)), uint(1));
        });
      });
      If(this.slots.element(slot).equal(0), () => {
        const ticket = atomicAdd(this.requests.element(freeCount), uint(1));
        atomicStore(this.requests.element(ticket.add(this.freeOffsetNode)), slot);
      });
    })().compute(this.capacity).setName('rzmps.volume.release');
    renderer.compute(this.releaseNode);

    this.allocateNodes ??= [5, 4, 3, 2, 1].map(priority => Fn(() => {
      const brick = instanceIndex;
      If(atomicLoad(this.requests.element(brick)).equal(priority).and(this.pages.element(brick).equal(0)), () => {
        const ticket = atomicAdd(this.requests.element(admitted.add(priority - 1)), uint(1));
        If(ticket.lessThan(atomicLoad(this.requests.element(budgets.add(priority - 1)))), () => {
          const free = atomicAdd(this.requests.element(cursor), uint(1));
          const slot = atomicLoad(this.requests.element(free.add(this.freeOffsetNode))).toVar();
          this.pages.element(brick).assign(slot.add(1));
          this.slots.element(slot).assign(brick.add(1));
          this.fresh.element(slot).assign(1);
          for (let value = 0; value < 8; value++) this.timeline.element(slot.mul(8).add(value)).assign(0);
          this.timeline.element(slot.mul(8)).assign(this.requestFrames.element(brick));
          this.timeline.element(slot.mul(8).add(1)).assign(uint(this.frame));
        }).Else(() => { atomicAdd(this.requests.element(overflow), uint(1)); });
      });
    })().compute(this.brickCount).setName(`rzmps.volume.admit.${priority}`));
    this.allocateNodes.forEach(node => { node.count = this.brickCount; });
    renderer.compute(this.allocateNodes);
    this.updateDispatch(renderer);
  }

  /** Observed GPU writes; render submission is not a claim of camera-visible pixels. @internal */
  recordPhase(renderer: ParticleSpatialGridRenderer, phase: 'simulation' | 'export' | 'render'): void {
    const column = phase === 'simulation' ? 2 : phase === 'export' ? 3 : 4;
    let node = this.phaseNodes.get(column);
    if (!node) {
      node = Fn(() => {
        const offset = instanceIndex.mul(8).add(column);
        If(this.slots.element(instanceIndex).greaterThan(0).and(this.timeline.element(offset).equal(0)), () => {
          this.timeline.element(offset).assign(uint(this.frame));
        });
      })().compute(this.capacity).setName(`rzmps.volume.lifecycle.${phase}`);
      this.phaseNodes.set(column, node);
    }
    renderer.compute(node);
  }

  /** Debug occupancy only; empty domain bricks retain metadata without allocating their cells. */
  updateVisualization(renderer: ParticleSpatialGridRenderer, field: Vec4Storage, cutoff: Node<'float'>,
    channel: 'x' | 'w' = 'x'): void {
    this.occupancyResetNode ??= Fn(() => {
      atomicStore(this.occupied.element(instanceIndex), uint(0));
    })().compute(this.capacity);
    renderer.compute(this.occupancyResetNode);
    let variants = this.occupancyNodes.get(field);
    if (!variants) { variants = new Map(); this.occupancyNodes.set(field, variants); }
    let node = variants.get(channel);
    if (!node) {
      node = this.compute(index => {
        const value = field.element(index)[channel];
        If(value.greaterThan(0).and(value.greaterThanEqual(cutoff)), () => {
          atomicMax(this.occupied.element(index.div(this.cellsPerBrick)), uint(1));
        });
      }).setName('rzmps.volume.helperOccupancy');
      variants.set(channel, node);
    }
    renderer.compute(node);
  }

  /** Every logical brick is visible, whether or not it currently owns a resident cell page. */
  visualization(logical: Node<'uint'>): Node<'vec4'> {
    const encoded = this.helperPages.element(logical);
    const slot = encoded.greaterThan(0).select(encoded, uint(1)).sub(1);
    const occupied = encoded.greaterThan(0).and(this.helperOccupied.element(slot).greaterThan(0));
    return vec4(vec3(this.unpack(logical, this.brickDimensions)), occupied.select(1, 0));
  }

  requestFirstFrame(coordinate: Node<'ivec3'>): Node<'uint'> {
    return this.requestFrames.element(this.flatten(coordinate, this.brickDimensions));
  }

  requestPriority(coordinate: Node<'ivec3'>): Node<'uint'> {
    return atomicLoad(this.requests.element(this.flatten(coordinate, this.brickDimensions)));
  }

  slotTimeline(slot: Node<'uint'>, column: number): Node<'uint'> {
    return this.timeline.element(slot.mul(8).add(column));
  }

  slotIsActive(slot: Node<'uint'>): Node<'bool'> {
    const found = uint(0).toVar();
    Loop(this.capacityNode, ({ i }) => {
      If(uint(i).lessThan(this.activeCellCount.div(this.cellsPerBrick))
        .and(this.activeSlots.element(uint(i)).equal(slot)), () => { found.assign(1); });
    });
    return found.greaterThan(0);
  }

  get allocatedBytes(): number {
    return [this.pagesAttribute, this.previousPagesAttribute, this.requestsAttribute, this.requestFramesAttribute,
      this.diagnosticsAttribute, this.timelineAttribute, this.layoutSlotsAttribute, this.occupancyAttribute,
      ...this.dispatchAttributes]
      .reduce((sum, attribute) => sum + attribute.array.byteLength, 0);
  }

  dispose(renderer?: ParticleSpatialGridRenderer): void {
    this.directoryAllocation?.cancelPending();
    this.directoryAllocation = undefined;
    [this.pagesAttribute, this.previousPagesAttribute,
      this.requestsAttribute, this.requestFramesAttribute, this.diagnosticsAttribute,
      this.timelineAttribute, this.layoutSlotsAttribute, this.occupancyAttribute,
      ...this.dispatchAttributes].forEach(attribute => {
      destroyGPUStorageAttribute(renderer, attribute);
      attribute.dispose();
    });
  }
}
