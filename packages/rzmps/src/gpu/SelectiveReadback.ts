import { StorageBufferAttribute, type ComputeNode, type Node } from 'three/webgpu';
import { float, Fn, If, instanceIndex, storage, uint, vec3 } from 'three/tsl';
import Particle from '../Particle';
import {
  createGPUParticleBufferState,
  destroyGPUStorageAttribute,
  type GPUParticleBufferState,
  type GPUParticleLike,
  type GPUReadbackRenderer,
  type GPUStorageBufferRenderer,
} from './Particle';

export interface GPUSelectiveReadbackRequest {
  slot: number;
  generation: number;
  identity?: Particle;
}

export interface GPUSelectiveReadbackResult {
  slot: number;
  generation: number;
  valid: boolean;
  tagMask: number;
  particle: Particle;
}

type PackedUintStorage = { element(index: number | Node): Node<'uvec4'> };

export class GPUSelectiveReadbackState {
  readonly capacity: number;
  readonly requestAttribute: StorageBufferAttribute;
  readonly output: GPUParticleBufferState;
  readonly version: number;

  private readonly requestData: Uint32Array;
  private readonly requests: GPUSelectiveReadbackRequest[] = [];
  private computeNode?: ComputeNode;
  private sourceVersion = -1;
  private static nextVersion = 1;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.ceil(capacity));
    this.version = GPUSelectiveReadbackState.nextVersion;
    GPUSelectiveReadbackState.nextVersion += 1;
    this.requestData = new Uint32Array(this.capacity * 4);
    this.requestAttribute = new StorageBufferAttribute(this.requestData, 4);
    this.output = createGPUParticleBufferState(
      Array.from({ length: this.capacity }, () => new Particle()),
      this.capacity,
    );
  }

  setRequests(requests: GPUSelectiveReadbackRequest[]): void {
    if (requests.length > this.capacity) {
      throw new Error(`GPU selective readback capacity ${this.capacity} exceeded by ${requests.length} requests.`);
    }

    this.requests.length = 0;
    this.requests.push(...requests);
    this.requestData.fill(0);

    requests.forEach((request, index) => {
      const offset = index * 4;
      this.requestData[offset] = request.slot >>> 0;
      this.requestData[offset + 1] = request.generation >>> 0;
      this.requestData[offset + 2] = 1;
      this.requestData[offset + 3] = 0;
    });

    this.requestAttribute.needsUpdate = true;
  }

  initialize(renderer: GPUStorageBufferRenderer): void {
    initializeStorageAttribute(renderer, this.requestAttribute);
    this.output.initialize(renderer);
  }

  gather(renderer: GPUStorageBufferRenderer & { compute?: (node: ComputeNode) => void }, source: GPUParticleBufferState): void {
    if (!renderer.compute) throw new Error('GPU selective readback requires a renderer with compute support.');
    if (this.requests.length <= 0) return;

    this.initialize(renderer);
    renderer.compute(this.getComputeNode(source));
  }

  async readback(renderer: GPUReadbackRenderer): Promise<GPUSelectiveReadbackResult[]> {
    const outputParticles = this.requests.map((request) => request.identity?.clone() ?? new Particle());
    await this.output.readback(renderer, outputParticles);

    const uintData = this.output.attributes.uintData.array as Uint32Array;
    return outputParticles.map((particle, index) => {
      const generation = uintData[index * 4 + 2] ?? this.requests[index].generation;
      const tagMask = uintData[index * 4 + 1] ?? 0;
      if (!this.requests[index].identity) {
        particle.id = `gpu:${this.requests[index].slot}:${generation}`;
        particle.startTime = -particle.realtime;
      }

      return {
        slot: this.requests[index].slot,
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
    this.output.dispose(renderer);
    destroyGPUStorageAttribute(renderer, this.requestAttribute);
  }

  private getComputeNode(source: GPUParticleBufferState): ComputeNode {
    if (this.computeNode && this.sourceVersion === source.version) return this.computeNode;

    const requestStorage = storage(this.requestAttribute, 'uvec4', this.capacity) as PackedUintStorage;

    this.computeNode?.dispose?.();
    this.computeNode = Fn(() => {
      const request = requestStorage.element(instanceIndex);
      const slot = request.x;
      const generation = request.y;
      const enabled = request.z.notEqual(uint(0));

      If(enabled.and(slot.lessThan(uint(source.count))), () => {
        const sourceParticle = source.storage.loadParticle(slot);

        If(generation.equal(uint(0)).or(sourceParticle.generation.equal(generation)), () => {
          this.output.storage.storeParticle(withIndex(sourceParticle, instanceIndex));
        }).Else(() => {
          this.output.storage.storeParticle(deadParticle(instanceIndex, generation));
        });
      }).Else(() => {
        this.output.storage.storeParticle(deadParticle(instanceIndex, generation));
      });
    })().compute(this.capacity);
    this.sourceVersion = source.version;

    return this.computeNode;
  }
}

function deadParticle(index: Node<'uint'>, generation: Node<'uint'>): GPUParticleLike {
  const zero = vec3(0, 0, 0);

  return {
    index,
    position: zero,
    orbitCenter: zero,
    rotation: zero,
    scale: zero,
    velocity: zero,
    angularVelocity: zero,
    scalarVelocity: zero,
    acceleration: zero,
    angularAcceleration: zero,
    scalarAcceleration: zero,
    color: zero,
    speed: float(0),
    alpha: float(0),
    mass: float(0),
    distortionStrength: float(0),
    lifetime: float(0),
    time: float(0),
    realtime: float(0),
    alive: uint(0),
    tagMask: uint(0),
    generation,
  };
}

function withIndex(particle: GPUParticleLike, index: Node<'uint'>): GPUParticleLike {
  return {
    index,
    position: particle.position,
    orbitCenter: particle.orbitCenter,
    rotation: particle.rotation,
    scale: particle.scale,
    velocity: particle.velocity,
    angularVelocity: particle.angularVelocity,
    scalarVelocity: particle.scalarVelocity,
    acceleration: particle.acceleration,
    angularAcceleration: particle.angularAcceleration,
    scalarAcceleration: particle.scalarAcceleration,
    color: particle.color,
    speed: particle.speed,
    alpha: particle.alpha,
    mass: particle.mass,
    distortionStrength: particle.distortionStrength,
    lifetime: particle.lifetime,
    time: particle.time,
    realtime: particle.realtime,
    alive: particle.alive,
    tagMask: particle.tagMask,
    generation: particle.generation,
  };
}

function initializeStorageAttribute(
  renderer: GPUStorageBufferRenderer,
  attribute: StorageBufferAttribute,
): void {
  const backend = renderer.backend as {
    get?(attribute: StorageBufferAttribute): { buffer?: unknown };
    createStorageAttribute?(attribute: StorageBufferAttribute): void;
  } | undefined;
  const data = backend?.get?.(attribute);

  if (!data?.buffer) backend?.createStorageAttribute?.(attribute);
}
