import { StorageBufferAttribute, type ComputeNode, type Node, type WebGPURenderer } from 'three/webgpu';
import { Fn, If, atomicAdd, atomicLoad, atomicStore, instanceIndex, storage, uint, uniform } from 'three/tsl';
import Particle from '../../core/Particle';
import type ParticleSystem from '../../core/ParticleSystem';
import type { ParticleGPUCondition } from '../../core/particleCondition.types';
import {
  GPUParticleRenderBufferState,
  createEmptyGPUParticleBufferState,
  destroyGPUStorageAttribute,
  type GPUParticleBufferState,
  type GPUParticleLike,
} from '../../simulation/gpu/Particle';
import { nextPowerOfTwo } from '../../utils/gpu/storage.utils';

type Input = GPUParticleBufferState | GPUParticleRenderBufferState;

/** Condition evaluation precedes compaction: custom predicates never share the copy pass's binding budget. */
export default class GPURendererSelection {
  private output?: GPUParticleRenderBufferState;
  private snapshot?: GPUParticleBufferState;
  private metadata?: StorageBufferAttribute;
  private flags?: StorageBufferAttribute;
  private input?: Input;
  private renderer?: WebGPURenderer;
  private nodes: ComputeNode[] = [];
  private key = '';
  private revision = 0;

  prepare(
    input: Input,
    system: ParticleSystem,
    condition: ParticleGPUCondition,
    version: number,
    tagMask: number | undefined,
    cpuSnapshot: boolean,
    deltaTime: number
  ): Input {
    const renderer = system.sceneRenderer as WebGPURenderer;
    const capacity = nextPowerOfTwo(Math.max(1, input.count));
    if (!this.output || this.output.capacity < capacity || this.input !== input) {
      this.reset();
      this.renderer = renderer;
      this.input = input;
      this.output = new GPUParticleRenderBufferState(capacity);
      this.flags = new StorageBufferAttribute(new Uint32Array(capacity), 1);
      this.metadata = new StorageBufferAttribute(new Uint32Array(capacity + 1), 1);
      if (cpuSnapshot) this.snapshot = createEmptyGPUParticleBufferState(capacity);
    }
    const particleAt = (index: Node<'uint'>): GPUParticleLike => {
      const visual = input.storage.createParticle(index);
      const canonical = system.gpuParticleBuffers?.storage.createParticle(index);
      return new Proxy(visual, {
        get: (target, key) => {
          // Render velocity is already speed-scaled; predicates/full CPU snapshots follow Particle's raw API.
          if (key === 'velocity' && input instanceof GPUParticleRenderBufferState && canonical) {
            return canonical.velocity;
          }
          return key in target ? Reflect.get(target, key) : canonical && Reflect.get(canonical, key);
        },
      }) as unknown as GPUParticleLike;
    };
    const output = this.output!;
    output.ensureCount(input.count);
    output.initialize(renderer);
    if (this.snapshot) {
      this.snapshot.count = input.count;
      this.snapshot.initialize(renderer);
    }
    const key = [input.version, system.gpuParticleBuffers?.version, version, tagMask, cpuSnapshot].join('|');
    if (key !== this.key) {
      this.nodes.forEach(node => node.dispose());
      this.key = key;
      const flags = storage(this.flags!, 'uint', output.capacity);
      const metadata = storage(this.metadata!, 'uint', output.capacity + 1).toAtomic();
      output.instanceCountNode = atomicLoad(metadata.element(0));
      output.storage.sourceIndex = index => atomicLoad(metadata.element(index.add(1)));
      output.spacingIndex = output.storage.sourceIndex;
      const evaluate = Fn(() => {
        const particle = particleAt(instanceIndex);
        const eligible = particle.alive
          .notEqual(0)
          .and(tagMask === undefined ? uint(1).equal(1) : particle.tagMask.bitAnd(tagMask).notEqual(0));
        flags.element(instanceIndex).assign(0);
        If(eligible, () =>
          flags.element(instanceIndex).assign(
            condition(
              particle as unknown as GPUParticleLike,
              // Use a frame-updated uniform, not a captured frame duration.
              this.deltaTime,
              { system }
            ).select(uint(1), uint(0))
          )
        );
      })()
        .compute(input.count)
        .setName('rzmps.renderer.condition');
      const clear = Fn(() => {
        atomicStore(metadata.element(0), uint(0));
      })().compute(1);
      const clearState = Fn(() => {
        output.storage.createStateNode().assign(0);
        this.snapshot?.storage.createStateNode().assign(0);
      })().compute(output.capacity);
      const copy = Fn(() => {
        If(flags.element(instanceIndex).notEqual(0), () => {
          const destination = atomicAdd(metadata.element(0), uint(1)).toVar();
          atomicStore(metadata.element(destination.add(1)), instanceIndex);
          const source = input.storage.createParticle(instanceIndex);
          const target = output.storage.createParticle(destination);
          for (const key of [
            'position',
            'rotation',
            'scale',
            'color',
            'velocity',
            'materialCopy',
            'materialCopyU',
            'materialCopyV',
            'alpha',
            'contribution',
            'time',
            'realtime',
            'distortionStrength',
          ] as const) {
            target[key]!.assign(source[key]!);
          }
          output.storage.createStateNode(destination).assign(input.storage.createStateNode());
        });
      })()
        .compute(input.count)
        .setName('rzmps.renderer.compact');
      this.nodes = [clear, clearState, evaluate, copy];
      if (this.snapshot) {
        const snapshot = this.snapshot;
        const gather = Fn(() => {
          If(instanceIndex.lessThan(atomicLoad(metadata.element(0))), () => {
            const index = atomicLoad(metadata.element(instanceIndex.add(1))).toVar();
            const source = particleAt(index);
            const full = snapshot.storage.createParticle(instanceIndex, true);
            for (const key of [
              'position',
              'orbitCenter',
              'rotation',
              'scale',
              'velocity',
              'angularVelocity',
              'scalarVelocity',
              'acceleration',
              'angularAcceleration',
              'scalarAcceleration',
              'color',
              'speed',
              'alpha',
              'mass',
              'distortionStrength',
              'lifetime',
              'time',
              'realtime',
              'materialCopy',
              'materialCopyU',
              'materialCopyV',
            ] as const)
              full[key]!.assign(source[key]!);
            snapshot.storage.storeParticle(full);
            snapshot.storage.createStateNode().assign(input.storage.createStateNode(index));
          });
        })()
          .compute(input.count)
          .setName('rzmps.renderer.snapshot');
        this.nodes.push(gather);
      }
    }
    this.deltaTime.value = deltaTime;
    this.quality.value = system.quality;
    // ComputeNode counts are runtime uniforms; a growing population must not rebuild these programs.
    for (let i = 2; i < this.nodes.length; i++) this.nodes[i].count = input.count;
    this.nodes.forEach(node => renderer.compute(node));
    return output;
  }

  private readonly deltaTime = uniform(0);
  private readonly quality = uniform(1);

  /** Complete source snapshots retain original slot/generation identities, never grouped synthetic identities. */
  async readback(): Promise<Particle[]> {
    const snapshot = this.snapshot!,
      metadata = this.metadata!,
      revision = this.revision;
    try {
      const indices = new Uint32Array(await this.renderer!.getArrayBufferAsync(metadata));
      if (revision !== this.revision) return [];
      const particles = Array.from({ length: Math.min(indices[0], snapshot.count) }, () => new Particle());
      await snapshot.readback(this.renderer!, particles);
      if (revision !== this.revision) return [];
      return particles.map((particle, index) => {
        const states = snapshot.attributes.uintData.array as Uint32Array;
        particle.id = `gpu:${indices[index + 1]}:${states[index * 4 + 2]}`;
        return particle;
      });
    } catch (error) {
      if (revision !== this.revision) return [];
      throw error;
    }
  }

  reset(): void {
    this.revision++;
    this.nodes.forEach(node => node.dispose());
    this.nodes = [];
    this.output?.dispose(this.renderer);
    this.snapshot?.dispose(this.renderer);
    for (const attribute of [this.metadata, this.flags]) {
      if (attribute) {
        destroyGPUStorageAttribute(this.renderer, attribute);
        attribute.dispose();
      }
    }
    this.output = undefined;
    this.snapshot = undefined;
    this.input = undefined;
    this.key = '';
  }
}
