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
    get?(target: StorageBufferAttribute): { buffer?: unknown };
    createStorageAttribute?(target: StorageBufferAttribute): void;
  } | undefined;
  const data = backend?.get?.(attribute);

  if (!data?.buffer) {
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
