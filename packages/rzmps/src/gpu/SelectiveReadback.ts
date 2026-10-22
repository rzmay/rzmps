import * as THREE from 'three';
import { StorageBufferAttribute, type ComputeNode, type Node } from 'three/webgpu';
import { Fn, If, instanceIndex, storage, uint, uvec4, vec4 } from 'three/tsl';
import Particle from '../Particle';
import {
  destroyGPUStorageAttribute,
  type GPUParticleBufferState,
  type GPUParticleLike,
  type GPUParticleScalarField,
  type GPUParticleVectorField,
} from './Particle';
import {
  initializeStorageAttribute,
  type GPUReadbackRenderer,
  type GPUStorageBufferRenderer,
  type PackedFloatStorage,
  type PackedUintStorage,
} from './Storage';

export type GPUParticleReadbackField = GPUParticleVectorField | GPUParticleScalarField;

export interface GPUSelectiveReadbackRequest {
  /** Internal particle identity to sample. */
  slot: number;
  generation: number;
  /** Particle values to copy. Omit to request every public particle field. */
  fields?: readonly GPUParticleReadbackField[];
  identity?: Particle;
}

export interface GPUSelectiveReadbackResult {
  slot: number;
  generation: number;
  valid: boolean;
  tagMask: number;
  particle: Particle;
}

const READBACK_FIELDS: readonly GPUParticleReadbackField[] = [
  'position', 'orbitCenter', 'rotation', 'scale', 'velocity',
  'angularVelocity', 'scalarVelocity', 'acceleration', 'angularAcceleration',
  'scalarAcceleration', 'color', 'speed', 'alpha', 'mass',
  'distortionStrength', 'lifetime', 'time', 'realtime',
];

const VECTOR_FIELDS = new Set<GPUParticleReadbackField>([
  'position', 'orbitCenter', 'rotation', 'scale', 'velocity',
  'angularVelocity', 'scalarVelocity', 'acceleration', 'angularAcceleration',
  'scalarAcceleration', 'color',
]);

/** Gathers arbitrary particle slots into a compact, contiguous readback buffer. */
export class GPUSelectiveReadbackState {
  readonly capacity: number;
  readonly requestAttribute: StorageBufferAttribute;
  readonly outputFloatAttribute: StorageBufferAttribute;
  readonly outputStateAttribute: StorageBufferAttribute;
  readonly version: number;

  private readonly requestData: Uint32Array;
  private readonly requests: GPUSelectiveReadbackRequest[] = [];
  private fields: GPUParticleReadbackField[] = [...READBACK_FIELDS];
  private fieldSignature = this.fields.join('|');
  private computeNode?: ComputeNode;
  private sourceVersion = -1;
  private static nextVersion = 1;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.ceil(capacity));
    this.version = GPUSelectiveReadbackState.nextVersion;
    GPUSelectiveReadbackState.nextVersion += 1;
    this.requestData = new Uint32Array(this.capacity * 4);
    this.requestAttribute = new StorageBufferAttribute(this.requestData, 4);
    this.outputFloatAttribute = new StorageBufferAttribute(
      new Float32Array(this.capacity * READBACK_FIELDS.length * 4),
      4,
    );
    this.outputStateAttribute = new StorageBufferAttribute(
      new Uint32Array(this.capacity * 4),
      4,
    );
  }

  get readbackByteLength(): number {
    return this.requests.length * (this.fields.length + 1) * 4 * Uint32Array.BYTES_PER_ELEMENT;
  }

  setRequests(requests: GPUSelectiveReadbackRequest[]): void {
    if (requests.length > this.capacity) {
      throw new Error(`GPU selective readback capacity ${this.capacity} exceeded by ${requests.length} requests.`);
    }

    this.requests.length = 0;
    this.requests.push(...requests);
    const requestAll = requests.some((request) => request.fields === undefined);
    const requestedFields = requestAll
      ? new Set(READBACK_FIELDS)
      : new Set(requests.flatMap((request) => request.fields ?? []));
    this.fields = READBACK_FIELDS.filter((field) => requestedFields.has(field));
    const nextSignature = this.fields.join('|');
    if (nextSignature !== this.fieldSignature) {
      this.fieldSignature = nextSignature;
      this.computeNode?.dispose?.();
      this.computeNode = undefined;
    }

    this.requestData.fill(0);
    requests.forEach((request, index) => {
      const offset = index * 4;
      this.requestData[offset] = request.slot >>> 0;
      this.requestData[offset + 1] = request.generation >>> 0;
      this.requestData[offset + 2] = 1;
    });
    this.requestAttribute.needsUpdate = true;
  }

  initialize(renderer: GPUStorageBufferRenderer): void {
    initializeStorageAttribute(renderer, this.requestAttribute);
    initializeStorageAttribute(renderer, this.outputFloatAttribute);
    initializeStorageAttribute(renderer, this.outputStateAttribute);
  }

  gather(
    renderer: GPUStorageBufferRenderer & { compute?: (node: ComputeNode) => void },
    source: GPUParticleBufferState,
  ): void {
    if (!renderer.compute) throw new Error('GPU selective readback requires a renderer with compute support.');
    if (this.requests.length <= 0) return;
    this.initialize(renderer);
    renderer.compute(this.getComputeNode(source));
  }

  async readback(renderer: GPUReadbackRenderer): Promise<GPUSelectiveReadbackResult[]> {
    const floatBytes = this.requests.length * this.fields.length * 4 * Float32Array.BYTES_PER_ELEMENT;
    const stateBytes = this.requests.length * 4 * Uint32Array.BYTES_PER_ELEMENT;
    const [floatBuffer, stateBuffer] = await Promise.all([
      floatBytes > 0
        ? renderer.getArrayBufferAsync(this.outputFloatAttribute, null, 0, floatBytes)
        : Promise.resolve(new ArrayBuffer(0)),
      renderer.getArrayBufferAsync(this.outputStateAttribute, null, 0, stateBytes),
    ]);
    const floatData = new Float32Array(floatBuffer);
    const stateData = new Uint32Array(stateBuffer);

    return this.requests.map((request, index) => {
      const particle = request.identity?.clone() ?? new Particle();
      const stateOffset = index * 4;
      const generation = stateData[stateOffset + 2] ?? request.generation;
      const tagMask = stateData[stateOffset + 1] ?? 0;
      particle.alive = (stateData[stateOffset] ?? 0) !== 0;
      this.fields.forEach((field, fieldIndex) => {
        this.readField(particle, field, floatData, (index * this.fields.length + fieldIndex) * 4);
      });
      particle.cache();

      if (!request.identity) {
        particle.id = `gpu:${request.slot}:${generation}`;
        particle.startTime = -particle.realtime;
      }

      return {
        slot: request.slot,
        generation,
        valid: particle.alive,
        tagMask,
        particle,
      };
    });
  }

  dispose(renderer?: GPUStorageBufferRenderer): void {
    this.computeNode?.dispose?.();
    this.computeNode = undefined;
    destroyGPUStorageAttribute(renderer, this.requestAttribute);
    destroyGPUStorageAttribute(renderer, this.outputFloatAttribute);
    destroyGPUStorageAttribute(renderer, this.outputStateAttribute);
  }

  private getComputeNode(source: GPUParticleBufferState): ComputeNode {
    if (this.computeNode && this.sourceVersion === source.version) return this.computeNode;

    const requests = storage(this.requestAttribute, 'uvec4', this.capacity) as PackedUintStorage;
    const output = storage(
      this.outputFloatAttribute,
      'vec4',
      this.capacity * READBACK_FIELDS.length,
    ) as PackedFloatStorage;
    const states = storage(this.outputStateAttribute, 'uvec4', this.capacity) as PackedUintStorage;
    const fieldCount = this.fields.length;

    this.computeNode?.dispose?.();
    this.computeNode = Fn(() => {
      const request = requests.element(instanceIndex);
      const slot = request.x;
      const generation = request.y;
      const enabled = request.z.notEqual(uint(0));

      If(enabled.and(slot.lessThan(uint(source.count))), () => {
        const particle = source.storage.createParticle(slot, true);
        If(generation.equal(uint(0)).or(particle.generation.equal(generation)), () => {
          states.element(instanceIndex).assign(uvec4(
            particle.alive,
            particle.tagMask,
            particle.generation,
            0,
          ));
          this.fields.forEach((field, fieldIndex) => {
            output.element(instanceIndex.mul(fieldCount).add(fieldIndex))
              .assign(this.getFieldNode(particle, field));
          });
        }).Else(() => this.writeInvalid(output, states, generation, fieldCount));
      }).Else(() => this.writeInvalid(output, states, generation, fieldCount));
    })().compute(this.capacity);
    this.sourceVersion = source.version;
    return this.computeNode;
  }

  private writeInvalid(
    output: PackedFloatStorage,
    states: PackedUintStorage,
    generation: Node<'uint'>,
    fieldCount: number,
  ): void {
    states.element(instanceIndex).assign(uvec4(0, 0, generation, 0));
    this.fields.forEach((_field, fieldIndex) => {
      output.element(instanceIndex.mul(fieldCount).add(fieldIndex)).assign(vec4(0));
    });
  }

  private getFieldNode(
    particle: GPUParticleLike,
    field: GPUParticleReadbackField,
  ): Node<'vec4'> {
    const value = particle[field];
    return VECTOR_FIELDS.has(field)
      ? vec4(value as Node<'vec3'>, 0)
      : vec4(value as Node<'float'>, 0, 0, 0);
  }

  private readField(
    particle: Particle,
    field: GPUParticleReadbackField,
    data: Float32Array,
    offset: number,
  ): void {
    if (field === 'color') {
      particle.color.setRGB(data[offset], data[offset + 1], data[offset + 2]);
    } else if (VECTOR_FIELDS.has(field)) {
      (particle[field] as THREE.Vector3).set(data[offset], data[offset + 1], data[offset + 2]);
    } else {
      (particle as unknown as Record<GPUParticleScalarField, number>)[field as GPUParticleScalarField] = data[offset];
    }
  }
}
