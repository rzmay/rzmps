import { Fn, If, instanceIndex, storage } from 'three/tsl';
import { StorageBufferAttribute, type ComputeNode, type Node, type WebGPURenderer } from 'three/webgpu';
import type ParticleSystem from '../../core/ParticleSystem';
import type { SubSystemOptions } from '../../core/ParticleSystem';
import type { GPUEventReader } from '../../events/gpu/EventBuffer';
import { destroyGPUStorageAttribute } from '../../simulation/gpu/Particle';

interface PredicateState {
  key: string;
  attribute: StorageBufferAttribute;
  node?: ComputeNode;
  storage: { element(index: Node | number): Node<'uint'> };
}

/** Shared eligibility results keep neighborhood queries out of emitter allocation kernels. @internal */
export default class GPUSubSystemPredicates {
  private readonly states = new Map<string, PredicateState>();
  private readonly identities = new WeakMap<object, number>();
  private nextIdentity = 0;

  private identity(value: object): number {
    let id = this.identities.get(value);
    if (id === undefined) this.identities.set(value, (id = ++this.nextIdentity));
    return id;
  }

  evaluate(
    parent: ParticleSystem,
    child: ParticleSystem,
    options: SubSystemOptions,
    renderer: WebGPURenderer,
    reader?: GPUEventReader,
    eventCapacity?: number,
    sources: ParticleSystem[] = [parent],
    journal = false,
  ): PredicateState | undefined {
    const condition = options.shouldEmitGPU;
    const buffers = parent.gpuSimulation._gpuBuffers;
    if (!condition || !buffers) return undefined;

    const count = eventCapacity ?? buffers.capacity;
    const name = [this.identity(condition), parent.id, reader?.versionKey ?? 'continuous'].join(':');
    let state = this.states.get(name);
    if (!state || state.attribute.count !== count) {
      state?.node?.dispose();
      if (state) destroyGPUStorageAttribute(renderer, state.attribute);
      const attribute = new StorageBufferAttribute(new Uint32Array(count), 1);
      state = { key: '', attribute, storage: storage(attribute, 'uint', count) };
      this.states.set(name, state);
    }

    // Resolve live neighborhoods after integration, even when testing a captured event state.
    const inputs = sources.map(system => {
      const grid = condition.spatialGridOptions
        ? system.acquireParticleSpatialGrid(condition.spatialGridOptions)
        : undefined;
      const sourceBuffers = system.gpuSimulation._gpuBuffers;
      if (sourceBuffers) grid?.rebuild(renderer, sourceBuffers, {});
      return { system, grid };
    });
    const key = [
      this.identity(buffers),
      buffers.version,
      options.shouldEmit === false,
      ...inputs.map(({ system, grid }) => `${system.id}:${grid ? this.identity(grid) : ''}:${grid?.resourceVersion}`),
    ].join('|');

    if (state.key !== key) {
      state.node?.dispose();
      state.key = key;
      const target = state.storage;
      state.node = Fn(() => {
        target.element(instanceIndex).assign(0);
        const eligible = reader
          ? instanceIndex.lessThan(reader.count())
          : buffers.storage.createParticle(undefined, true).alive.notEqual(0);
        If(eligible.and(options.shouldEmit !== false), () => {
          const event = reader?.load(instanceIndex);
          const particle = event?.particle ?? buffers.storage.createParticle(undefined, true);
          inputs.forEach(({ system, grid }) => {
            const evaluate = () =>
              target
                .element(instanceIndex)
                .assign(
                  condition(particle, system.gpuSimulation._gpuDeltaTimeNode, {
                    system,
                    childSystem: child,
                    spatialGrid: grid,
                    eventType: event?.type,
                  }).select(1, 0),
                );
            if (event && journal) If(event.origin.equal(system.id), evaluate);
            else evaluate();
          });
        });
      })()
        .compute(count)
        .setName('rzmps.emission.subsystemEligibility');
    }

    renderer.compute(state.node!);
    return state;
  }

  dispose(renderer?: WebGPURenderer): void {
    this.states.forEach(state => {
      state.node?.dispose();
      destroyGPUStorageAttribute(renderer, state.attribute);
    });
    this.states.clear();
  }
}
