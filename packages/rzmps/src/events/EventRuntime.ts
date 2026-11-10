import { uniform } from 'three/tsl';
import type { WebGPURenderer } from 'three/webgpu';
import type Particle from '../core/Particle';
import type ParticleSystem from '../core/ParticleSystem';
import type { ParticleListener } from '../core/ParticleSystem';
import type { SubSystemSource } from '../emission/EmissionSource';
import type { GPUUniformNode } from '../utils/gpu/computeCache.types';
import { nextPowerOfTwo } from '../utils/gpu/storage.utils';
import type { CollisionListener } from '../modules/Collision';
import type { Tag } from '../types/tag.types';
import type EventReceiver from './EventReceiver';
import type { SimulationEvent } from './EventReceiver';
import { GPUCollisionEventBufferState, GPUEventBufferState, type GPUEventReadbackBatch } from './gpu/EventBuffer';

export interface GPUEventReadbackExecution {
  required(): boolean;
  lifecycle(): number;
  identity(slot: number, generation: number): Particle | undefined;
  tags(mask: number): Tag[] | undefined;
  debug(message: string, data: unknown): void;
  deliver(event: GPUEventReadbackBatch['events'][number]): void;
}

/** Owns event identities, subscriptions, reentrant delivery and native transport state. */
export default class EventRuntime {
  constructor(
    readonly origin: ParticleSystem,
    readonly prepare: () => void,
    readonly route: (event: SimulationEvent) => void,
  ) {}
  readonly _eventObservers = new Set<{
    names: readonly string[];
    consume: (event: SimulationEvent) => void;
    receiver: boolean | EventReceiver;
  }>();

  _eventSequence = 0;

  _dispatchingEvent = false;

  readonly _deferredSimulationEvents: SimulationEvent[] = [];

  readonly _eventTypes = new Map<string, number>([
    ['death', 1],
    ['spawn', 2],
    ['collision', 3],
  ]);

  readonly _pendingGPUEvents: Array<{ slot: number; generation: number; event: string; data?: unknown }> = [];

  _sharedGPUEvents?: GPUEventBufferState;

  _gpuFrameEventBuffer?: GPUEventBufferState;

  _gpuEventBuffer?: GPUEventBufferState;

  _gpuCollisionEventBuffer?: GPUCollisionEventBufferState;

  _gpuEventReadbacksPending = 0;

  _gpuEventReadbackCount = 0;

  _gpuEventFrameSequence = 0;

  _gpuNextEventDispatchSequence = 1;

  readonly _gpuCompletedEventBatches = new Map<number, GPUEventReadbackBatch>();

  readonly _gpuDeliveredDeathEvents = new Set<string>();

  _gpuEventOverflowCount = 0;

  readonly _gpuEventFrameNode = uniform(0, 'uint').setName('rzmpsEventFrame') as unknown as GPUUniformNode<
    number,
    'uint'
  >;

  _deathListeners: ParticleListener[] = [];

  _spawnListeners: ParticleListener[] = [];

  _collisionListeners: CollisionListener[] = [];

  onEvent(
    names: string | readonly string[],
    consume: (event: SimulationEvent) => void,
    /** @internal */ receiver: boolean | EventReceiver = false,
  ): () => void {
    const observer = { names: typeof names === 'string' ? [names] : [...names], consume, receiver };
    observer.names.forEach(name => this._registerEventType(name));
    this._eventObservers.add(observer);
    return () => {
      this._eventObservers.delete(observer);
    };
  }

  _registerEventType(name: string): number {
    if (!this._eventTypes.has(name)) {
      if (this._eventTypes.size >= 32) throw new Error('RZMPS supports at most 32 event types per system.');
      this._eventTypes.set(name, this._eventTypes.size + 1);
    }
    return this._eventTypes.get(name)!;
  }

  _publishSimulationEvent(name: string, data?: unknown, source?: SubSystemSource, gpu = false): SimulationEvent {
    this.prepare();
    const sequence = ++this._eventSequence;
    const event: SimulationEvent = Object.freeze({
      name,
      type: this._eventTypes.get(name) ?? 0,
      data,
      source,
      origin: this.origin,
      sequence,
      gpu,
      id: `${this.origin.uuid}:${sequence}`,
    });
    if (this._dispatchingEvent) this._deferredSimulationEvents.push(event);
    else this._deliverSimulationEvent(event);
    return event;
  }

  _deliverSimulationEvent(event: SimulationEvent): void {
    this._dispatchingEvent = true;
    try {
      this.route(event);
      for (const observer of [...this._eventObservers]) {
        if (observer.names.includes(event.name)) observer.consume(event);
      }
    } finally {
      this._dispatchingEvent = false;
    }
  }
  flush(): void {
    const deferred = this._deferredSimulationEvents.splice(0);
    deferred.forEach(event => this._deliverSimulationEvent(event));
  }
  clearGPU(gpuRenderer?: WebGPURenderer): void {
    this._pendingGPUEvents.length = 0;
    this._gpuFrameEventBuffer = undefined;
    this._gpuEventBuffer?.dispose(gpuRenderer);
    this._gpuEventBuffer = undefined;
    this._gpuCollisionEventBuffer?.dispose(gpuRenderer);
    this._gpuCollisionEventBuffer = undefined;
    this._gpuEventReadbacksPending = 0;
    this._gpuEventReadbackCount = 0;
    this._gpuEventFrameSequence = 0;
    this._gpuNextEventDispatchSequence = 1;
    this._gpuCompletedEventBatches.clear();
    this._gpuDeliveredDeathEvents.clear();
    this._gpuEventOverflowCount = 0;
  }
  disposeJournal(renderer?: WebGPURenderer): void {
    this._sharedGPUEvents?.dispose(renderer);
    this._sharedGPUEvents = undefined;
  }
  acquireBuffer(renderer: WebGPURenderer, capacity: number, allocated: () => void) {
    if (!this._gpuEventBuffer || this._gpuEventBuffer.capacity !== nextPowerOfTwo(capacity)) {
      allocated();
      this._gpuEventBuffer = new GPUEventBufferState(capacity);
    }

    this._gpuEventBuffer.initialize(renderer);
    return this._gpuEventBuffer;
  }
  acquireCollisionBuffer(renderer: WebGPURenderer, capacity: number, allocated: () => void) {
    if (!this._gpuCollisionEventBuffer || this._gpuCollisionEventBuffer.capacity !== capacity) {
      this._gpuCollisionEventBuffer?.dispose(renderer);
      allocated();
      this._gpuCollisionEventBuffer = new GPUCollisionEventBufferState(capacity);
    }

    this._gpuCollisionEventBuffer.initialize(renderer);
    return this._gpuCollisionEventBuffer;
  }
  scheduleReadback(buffer: GPUEventBufferState, renderer: WebGPURenderer, execution: GPUEventReadbackExecution): void {
    if (!execution.required()) {
      this._gpuCompletedEventBatches.set(buffer.sequence, {
        sequence: buffer.sequence,
        events: [],
        rawEventCount: 0,
        overflowCount: 0,
        capacity: buffer.capacity,
      });
      this.flushGPU(execution);
      return;
    }
    if (typeof (renderer as { getArrayBufferAsync?: unknown }).getArrayBufferAsync !== 'function') return;
    if (!renderer.backend) return;

    const sequence = buffer.sequence;
    const lifecycleGeneration = execution.lifecycle();
    const readback = buffer.readback(
      renderer,
      (slot, generation) => execution.identity(slot, generation),
      buffer.journal ? this.origin.id : undefined,
    );
    this._gpuEventReadbacksPending += 1;
    this._gpuEventReadbackCount += 1;
    void (async () => {
      try {
        const batch = await readback;
        if (lifecycleGeneration !== execution.lifecycle()) return;
        batch.events.forEach(event => {
          event.particle.tags = execution.tags(event.tagMask ?? 0);
        });

        this._gpuCompletedEventBatches.set(batch.sequence, batch);
        this.flushGPU(execution);
      } catch (error) {
        if (lifecycleGeneration !== execution.lifecycle()) return;
        execution.debug('event readback failed', {
          sequence,
          error,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        this._gpuCompletedEventBatches.set(sequence, {
          sequence,
          events: [],
          rawEventCount: 0,
          capacity: buffer.capacity,
          overflowCount: 1,
        });
        this.flushGPU(execution);
      } finally {
        if (lifecycleGeneration === execution.lifecycle()) {
          this._gpuEventReadbacksPending = Math.max(0, this._gpuEventReadbacksPending - 1);
        }
      }
    })();
  }
  flushGPU(execution: GPUEventReadbackExecution): void {
    while (this._gpuCompletedEventBatches.has(this._gpuNextEventDispatchSequence)) {
      const batch = this._gpuCompletedEventBatches.get(this._gpuNextEventDispatchSequence)!;
      this._gpuCompletedEventBatches.delete(this._gpuNextEventDispatchSequence);
      this._gpuNextEventDispatchSequence += 1;

      if (batch.overflowCount > 0 || batch.rawEventCount > batch.capacity) {
        this._gpuEventOverflowCount += Math.max(batch.overflowCount, batch.rawEventCount - batch.capacity);
        execution.debug('event buffer overflow', {
          sequence: batch.sequence,
          rawEventCount: batch.rawEventCount,
          capacity: batch.capacity,
          overflowCount: batch.overflowCount,
        });
      }

      batch.events.forEach(execution.deliver);
    }
  }
  acquireJournal(
    renderer: WebGPURenderer,
    capacity: number,
    initialize: (journal: GPUEventBufferState) => void,
  ): GPUEventBufferState {
    if (!this._sharedGPUEvents) {
      this._sharedGPUEvents = new GPUEventBufferState(capacity, true);
      this._sharedGPUEvents.initialize(renderer);
      initialize(this._sharedGPUEvents);
    }
    return this._sharedGPUEvents;
  }
}
