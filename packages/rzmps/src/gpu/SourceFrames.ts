import { Matrix4 } from 'three';
import { StorageBufferAttribute, type Node } from 'three/webgpu';
import { mat4, storage } from 'three/tsl';
import type { SubSystemSource } from '../EmissionSource';
import {
  destroyStorageAttribute as destroyGPUStorageAttribute, initializeStorageAttribute, nextPowerOfTwo,
  type GPUStorageBufferRenderer, type PackedFloatStorage, type PackedUintStorage,
} from './Storage';

/** @internal */
export interface ManagedSourceFrame {
  source: SubSystemSource;
  generation: number;
  slot: number;
  active?: boolean;
}

/** @internal Optional Source-mode resources. Birth ownership is packed into the existing particle float buffer. */
export default class GPUSourceFrames {
  capacity: number;
  version = 0;
  previousAttribute: StorageBufferAttribute;
  previous: PackedFloatStorage;
  frameAttribute: StorageBufferAttribute;
  frames: PackedFloatStorage;
  stateAttribute: StorageBufferAttribute;
  states: PackedUintStorage;
  readonly records: ManagedSourceFrame[] = [];
  private readonly byID = new Map<string, ManagedSourceFrame>();
  private frameData: Float32Array;
  private stateData: Uint32Array;

  constructor(capacity: number) {
    this.capacity = nextPowerOfTwo(Math.max(1, capacity));
    this.previousAttribute = new StorageBufferAttribute(new Float32Array(this.capacity * 16), 4);
    this.previous = storage(this.previousAttribute, 'vec4', this.capacity * 4) as PackedFloatStorage;
    this.frameData = new Float32Array(this.capacity * 16);
    this.stateData = new Uint32Array(this.capacity * 4);
    this.frameAttribute = new StorageBufferAttribute(this.frameData, 4);
    this.frames = storage(this.frameAttribute, 'vec4', this.capacity * 4) as PackedFloatStorage;
    this.stateAttribute = new StorageBufferAttribute(this.stateData, 4);
    this.states = storage(this.stateAttribute, 'uvec4', this.capacity) as PackedUintStorage;
  }

  register(source: SubSystemSource): ManagedSourceFrame {
    const existing = this.byID.get(source.id);
    if (existing) return existing;
    const reusable = this.records.find(record => !record.source.alive || record.active === false);
    if (reusable) this.byID.delete(reusable.source.id);
    const record = reusable ?? { source, generation: 0, slot: this.records.length };
    record.source = source;
    record.active = true;
    record.generation++;
    if (!reusable) this.records.push(record);
    this.byID.set(source.id, record);
    return record;
  }

  refresh(resolve: (source: SubSystemSource) => Matrix4, alive = (source: SubSystemSource) => source.alive): void {
    this.stateData.fill(0);
    for (const record of this.records) {
      const frame = resolve(record.source);
      record.active = alive(record.source);
      frame.toArray(this.frameData, record.slot * 16);
      this.stateData.set([record.active ? 1 : 0, record.generation, 0, 0], record.slot * 4);
    }
    this.frameAttribute.needsUpdate = true;
    this.stateAttribute.needsUpdate = true;
  }

  matrix(index: Node<'uint'>, previous = false): Node<'mat4'> {
    const data = previous ? this.previous : this.frames;
    const offset = index.mul(4);
    return mat4(data.element(offset), data.element(offset.add(1)),
      data.element(offset.add(2)), data.element(offset.add(3)));
  }

  initialize(renderer: GPUStorageBufferRenderer): void {
    for (const attribute of [this.previousAttribute, this.frameAttribute, this.stateAttribute]) {
      initializeStorageAttribute(renderer, attribute);
    }
  }

  /** Grows without discarding last frames already stored by GPU updates. */
  grow(renderer: GPUStorageBufferRenderer | undefined, capacity: number): GPUSourceFrames {
    if (capacity <= this.capacity) return this;
    const next = new GPUSourceFrames(capacity);
    next.records.push(...this.records);
    for (const record of this.records) next.byID.set(record.source.id, record);
    next.version = this.version + 1;
    if (!renderer) return next;
    // Initialize only GPU-owned history here. Managed tables must receive refresh() before their first upload.
    initializeStorageAttribute(renderer, this.previousAttribute);
    initializeStorageAttribute(renderer, next.previousAttribute);
    const backend = renderer.backend as unknown as {
      device?: {
        createCommandEncoder(): {
          copyBufferToBuffer(source: unknown, sourceOffset: number, target: unknown,
            offset: number, size: number): void;
          finish(): unknown;
        };
        queue: { submit(commands: unknown[]): void };
      };
      get?(attribute: StorageBufferAttribute): { buffer?: unknown };
    };
    const source = backend.get?.(this.previousAttribute)?.buffer;
    const target = backend.get?.(next.previousAttribute)?.buffer;
    if (source && target && backend.device) {
      const encoder = backend.device.createCommandEncoder();
      encoder.copyBufferToBuffer(source, 0, target, 0, this.capacity * 16 * 4);
      backend.device.queue.submit([encoder.finish()]);
    }
    this.dispose(renderer);
    return next;
  }

  dispose(renderer?: GPUStorageBufferRenderer): void {
    for (const attribute of [this.previousAttribute, this.frameAttribute, this.stateAttribute]) {
      destroyGPUStorageAttribute(renderer, attribute);
    }
  }
}
