import type * as THREE from 'three';
import { StorageBufferAttribute, type Node } from 'three/webgpu';
import { instanceIndex } from 'three/tsl';
import type { GPUParticleAttributes } from './Particle';
import { enumValueCount, type PackedFloatStorage } from './Storage';

// Shared particle and render-output layouts. Slot ordering is the storage-buffer ABI.
export enum ParticleFloatSlot {
  PositionSpeed,
  OrbitCenterAlpha,
  RotationMass,
  ScaleDistortion,
  VelocityLifetime,
  AngularVelocityTime,
  ScalarVelocityRealtime,
  Acceleration,
  AngularAcceleration,
  ScalarAcceleration,
  Color,
  SourceIdentity,
  MaterialCopy,
  MaterialCopyU,
  MaterialCopyV,
}

export enum ParticleRenderFloatSlot {
  PositionAlpha,
  RotationDistortion,
  ScaleRealtime,
  ColorTime,
  Contribution,
  MaterialCopy,
  MaterialCopyU,
  MaterialCopyV,
}

export const FLOAT_SLOT_COUNT = enumValueCount(ParticleFloatSlot);

export const RENDER_FLOAT_SLOT_COUNT = enumValueCount(ParticleRenderFloatSlot);

export const UINT_SLOT_COUNT = 1;

// Both buffer-state classes and both shader storage views use these packing operations.
export function createAttributes(floatData: Float32Array, uintData: Uint32Array): GPUParticleAttributes {
  return {
    floatData: new StorageBufferAttribute(floatData, 4),
    uintData: new StorageBufferAttribute(uintData, 4),
  };
}

export function renderFloatElement(
  floatStorage: PackedFloatStorage,
  slot: number,
  index: Node<'uint'> = instanceIndex,
): Node<'vec4'> {
  return floatStorage.element(index.mul(RENDER_FLOAT_SLOT_COUNT).add(slot));
}

export function packedOffset(index: number, slot: number): number {
  return (index * FLOAT_SLOT_COUNT + slot) * 4;
}

export function stateOffset(index: number): number {
  return index * UINT_SLOT_COUNT * 4;
}

export function writeVectorAndScalar(
  array: Float32Array,
  index: number,
  slot: number,
  vector: THREE.Vector3,
  scalar: number,
): void {
  const offset = packedOffset(index, slot);
  array[offset] = vector.x;
  array[offset + 1] = vector.y;
  array[offset + 2] = vector.z;
  array[offset + 3] = scalar;
}

export function writeState(
  array: Uint32Array,
  index: number,
  alive: number,
  tagMask: number,
  generation: number,
  lodPriority = 0,
): void {
  const offset = stateOffset(index);
  array[offset] = alive;
  array[offset + 1] = tagMask >>> 0;
  array[offset + 2] = generation >>> 0;
  array[offset + 3] = Math.floor(lodPriority * 4294967296) >>> 0;
}

export function readVector(array: Float32Array, index: number, slot: number, vector: THREE.Vector3): void {
  const offset = packedOffset(index, slot);
  vector.set(array[offset], array[offset + 1], array[offset + 2]);
}

export function readScalar(array: Float32Array, index: number, slot: number): number {
  return array[packedOffset(index, slot) + 3];
}
