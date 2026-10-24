import { StorageBufferAttribute, type Node } from 'three/webgpu';
import { bitAnd, bitXor, floatBitsToUint, uint, uintBitsToFloat } from 'three/tsl';

export type PackedFloatStorage = { element(index: Node | number): Node<'vec4'> };
export type PackedUintStorage = { element(index: Node | number): Node<'uvec4'> };
export type PackedIntStorage = { element(index: Node | number): Node<'ivec4'> };
export type ScalarUintStorage = { element(index: Node | number): Node<'uint'> };
export type AtomicUintStorage = ScalarUintStorage;

/** Maps IEEE-754 floats to monotonically ordered uints for atomic min/max. */
export function orderedFloatNode(value: Node<'float'>): Node<'uint'> {
  const bits = floatBitsToUint(value) as unknown as Node<'uint'>;
  return bitAnd(bits, uint(0x80000000)).notEqual(uint(0))
    .select(bitXor(bits, uint(0xffffffff)), bitXor(bits, uint(0x80000000))) as Node<'uint'>;
}

export function unorderedFloatNode(value: Node<'uint'>): Node<'float'> {
  const bits = bitAnd(value, uint(0x80000000)).notEqual(uint(0))
    .select(bitXor(value, uint(0x80000000)), bitXor(value, uint(0xffffffff)));
  return uintBitsToFloat(bits) as unknown as Node<'float'>;
}

export function unorderedFloatBits(value: number): number {
  const bits = (value & 0x80000000) !== 0
    ? (value ^ 0x80000000) >>> 0
    : (value ^ 0xffffffff) >>> 0;
  const data = new Uint32Array([bits]);
  return new Float32Array(data.buffer)[0];
}

export interface GPUStorageBufferRenderer {
  backend?: unknown;
}

export interface GPUReadbackRenderer extends GPUStorageBufferRenderer {
  getArrayBufferAsync(
    attribute: StorageBufferAttribute,
    target?: ArrayBuffer | null,
    offset?: number,
    count?: number,
  ): Promise<ArrayBuffer>;
}

export function enumValueCount(value: object): number {
  return Object.keys(value).filter((key) => Number.isNaN(Number(key))).length;
}

export function nextPowerOfTwo(value: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(1, value)));
}

export function packedVec4Offset(index: number, slot: number, slotCount: number): number {
  return (index * slotCount + slot) * 4;
}

export function writePackedVec4(
  array: Float32Array | Uint32Array | Int32Array,
  index: number,
  slot: number,
  slotCount: number,
  values: readonly [number, number, number, number],
): void {
  const offset = packedVec4Offset(index, slot, slotCount);
  array.set(values, offset);
}

export function readPackedVec4(
  array: Float32Array | Uint32Array | Int32Array,
  index: number,
  slot: number,
  slotCount: number,
): [number, number, number, number] {
  const offset = packedVec4Offset(index, slot, slotCount);
  return [array[offset], array[offset + 1], array[offset + 2], array[offset + 3]];
}

/** Ensures Three.js has created the backend resource before direct compute use. */
export function initializeStorageAttribute(
  renderer: GPUStorageBufferRenderer,
  attribute: StorageBufferAttribute,
): boolean {
  const backend = renderer.backend as {
    isWebGPUBackend?: boolean;
    device?: {
      createBuffer(descriptor: {
        label?: string;
        size: number;
        usage: number;
        mappedAtCreation: boolean;
      }): unknown;
      queue: {
        writeBuffer(
          buffer: unknown,
          bufferOffset: number,
          data: ArrayBufferLike,
          dataOffset: number,
          size: number,
        ): void;
      };
    };
    get?(target: StorageBufferAttribute): { buffer?: unknown };
    createStorageAttribute?(target: StorageBufferAttribute): void;
  } | undefined;
  const data = backend?.get?.(attribute);

  if (!data?.buffer) {
    const array = attribute.array;
    const byteStride = attribute.itemSize * array.BYTES_PER_ELEMENT;
    if (data && backend?.isWebGPUBackend === true && backend.device && byteStride % 4 === 0) {
      // Three uses mappedAtCreation for initial attributes. Unmapped creation
      // avoids exhausting Dawn's mapped staging allocations on large buffers.
      const size = Math.max(4, Math.ceil(array.byteLength / 4) * 4);
      const buffer = backend.device.createBuffer({
        label: attribute.name,
        size,
        // GPUBufferUsage: COPY_SRC | COPY_DST | VERTEX | STORAGE.
        usage: 0x04 | 0x08 | 0x20 | 0x80,
        mappedAtCreation: false,
      });
      const chunkSize = 256 * 1024;
      for (let offset = 0; offset < array.byteLength; offset += chunkSize) {
        const length = Math.min(chunkSize, array.byteLength - offset);
        backend.device.queue.writeBuffer(
          buffer,
          offset,
          array.buffer,
          array.byteOffset + offset,
          length,
        );
      }
      data.buffer = buffer;
      return true;
    }

    backend?.createStorageAttribute?.(attribute);
    return true;
  }
  return false;
}

export function destroyStorageAttribute(
  renderer: GPUStorageBufferRenderer | undefined,
  attribute: StorageBufferAttribute,
): void {
  const backend = renderer?.backend as {
    has?(target: StorageBufferAttribute): boolean;
    get?(target: StorageBufferAttribute): { buffer?: unknown };
    destroyAttribute?(target: StorageBufferAttribute): void;
  } | undefined;
  if (backend?.has && !backend.has(attribute)) return;
  if (backend?.get && !backend.get(attribute).buffer) return;
  backend?.destroyAttribute?.(attribute);
}
