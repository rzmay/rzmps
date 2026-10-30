import type ParticleSystem from './ParticleSystem';
import type { SubSystemSource } from './EmissionSource';
import { emptyGPUEvents, type GPUEventBatch } from './gpu/EventBatch';

export type EventOrigin = 'local' | 'parent' | 'child';

/** Each selected origin is exclusive; arrays explicitly combine immediate origins. */
export type EventScope = EventOrigin | readonly EventOrigin[];

export interface EventReceiverOptions {
  events?: readonly string[];
  eventScope?: EventScope;
}

export interface SimulationEvent<T = unknown> {
  readonly name: string;
  readonly type: number;
  readonly data: T;
  readonly origin: ParticleSystem;
  readonly source?: SubSystemSource;
  readonly id: string;
  readonly sequence: number;
  /** True when CPU observation originated from a native GPU event. */
  readonly gpu?: boolean;
}

export interface EventExecutionContext {
  readonly system: ParticleSystem;
  readonly deltaTime: number;
  readonly events: readonly SimulationEvent[];
}

export interface GPUEventExecutionContext {
  readonly events: GPUEventBatch;
}

/** Subscription and execution-batch state, shared by modules, renderers and emitters. */
export default class EventReceiver {
  static readonly CAPACITY = 1024;

  // Subscription configuration supplied by modules, renderers, and emitters.
  events: readonly string[];
  eventScope?: EventScope;

  // Stable contexts retained until this receiver's next execution boundary.
  executionContext?: EventExecutionContext;
  gpuExecutionContext: GPUEventExecutionContext = Object.freeze({ events: emptyGPUEvents });

  // Resolved producer subscriptions, refreshed when names, scope, or relationships change.
  private readonly _eventOrigins = new Map<ParticleSystem, () => void>();
  private _receiverSystem?: ParticleSystem;
  private _eventNames: readonly string[] = [];
  private _eventSignature = '';
  private _eventResolvedScope?: EventScope;
  private _eventDefaultScope: EventScope = 'local';
  private _eventRevision = 0;

  // CPU events accumulate separately from the immutable batch currently being consumed.
  private _eventPending: SimulationEvent[] = [];
  private _eventBatch: readonly SimulationEvent[] = Object.freeze([]);
  private _eventOverflowCount = 0;

  // GPU consumer classification and callbacks releasing shared receiver metadata.
  private _eventGPUNative = false;
  private readonly _eventDisposers = new Set<() => void>();

  constructor(options: EventReceiverOptions = {}) {
    this.events = options.events ?? [];
    this.eventScope = options.eventScope;
  }

  /** Number of CPU events dropped when the pending batch reached capacity. */
  get overflowCount(): number {
    return this._eventOverflowCount;
  }

  /** @internal Changes when selected producers or event names change. */
  get revision(): number {
    return this._eventRevision;
  }

  /** @internal Native consumers use storage batches; CPU consumers opt into GPU readback. */
  get gpuNative(): boolean {
    return this._eventGPUNative;
  }

  set gpuNative(value: boolean) {
    this._eventGPUNative = value;
  }

  /** @internal Event names selected after applying relationship overrides and emitter triggers. */
  get subscriptions(): readonly string[] {
    return this._eventNames;
  }

  // Subscription resolution: select producers without propagating events between systems.

  /** @internal The system reconciles this before dispatch, including between execution boundaries. */
  synchronize(
    system: ParticleSystem,
    defaultScope: EventScope = 'local',
    names = this.events,
    scope: EventScope = this.eventScope ?? defaultScope,
  ): void {
    this._receiverSystem = system;
    this._eventNames = names;
    this._eventDefaultScope = defaultScope;
    this._eventResolvedScope = scope;

    const visible = this.visibleSystems(system, scope);
    const signature = `${names.join('\0')}|${visible.map(owner => owner.uuid).join('|')}`;
    if (signature === this._eventSignature) return;

    this._eventSignature = signature;
    this._eventRevision++;

    for (const unsubscribe of this._eventOrigins.values()) unsubscribe();
    this._eventOrigins.clear();

    const selected = new Set(names);
    this._eventPending = this._eventPending.filter(event => visible.includes(event.origin) && selected.has(event.name));
    if (!selected.size) return;

    for (const origin of visible) {
      this._eventOrigins.set(origin, origin.onEvent([...selected], event => this.receive(event), this));
    }
  }

  /** Selects producers without forwarding or traversing beyond immediate relatives. */
  visibleSystems(
    system = this._receiverSystem!,
    scope = this._eventResolvedScope ?? this.eventScope ?? this._eventDefaultScope,
  ): ParticleSystem[] {
    const selected = new Set(typeof scope === 'string' ? [scope] : scope);
    const owners = new Set<ParticleSystem>();
    if (selected.has('local')) owners.add(system);
    if (selected.has('parent') && system.subSystemParent) owners.add(system.subSystemParent);
    if (selected.has('child')) {
      for (const child of system.subSystems.keys()) owners.add(child);
    }

    return [...owners];
  }

  // Execution boundaries: freeze CPU batches and select native GPU storage batches.

  /** Snapshots once per actual execution; events raised during execution remain pending. */
  begin(
    system: ParticleSystem,
    deltaTime: number,
    defaultScope: EventScope = 'local',
    names = this.events,
    scope?: EventScope,
  ): EventExecutionContext {
    this.synchronize(system, defaultScope, names, scope);
    this._eventBatch = Object.freeze(this._eventPending);
    this._eventPending = [];
    return Object.freeze({ system, deltaTime, events: this._eventBatch });
  }

  /** Creates and retains the context shared by every callback in this execution. */
  beginExecution(
    system: ParticleSystem,
    deltaTime: number,
    defaultScope: EventScope = 'local',
    names = this.events,
    scope?: EventScope,
  ): EventExecutionContext {
    this.executionContext = this.createExecutionContext(this.begin(system, deltaTime, defaultScope, names, scope));
    return this.executionContext;
  }

  /** Components can extend the context without duplicating subscription or batch state. */
  protected createExecutionContext(context: EventExecutionContext): EventExecutionContext {
    return context;
  }

  /** @internal Uses the system's shared native event storage without CPU readback. */
  beginGPUExecution(system: ParticleSystem): GPUEventExecutionContext {
    this.gpuExecutionContext = Object.freeze({ events: system.beginGPUEventExecution(this) });
    return this.gpuExecutionContext;
  }

  // Pending CPU delivery: deduplicate by event identity and retain a bounded queue.

  private receive(event: SimulationEvent): void {
    // A dispatcher delivers once; identity also protects explicit forwarding of the same event.
    if (this._eventPending.some(value => value.id === event.id)) return;

    if (this._eventPending.length === EventReceiver.CAPACITY) {
      this._eventPending.shift();
      this._eventOverflowCount++;
    }

    this._eventPending.push(event);
  }

  // Cleanup: release external metadata before dropping producer subscriptions and contexts.

  /** @internal Allows shared native storage to release receiver selection metadata. */
  onDispose(callback: () => void): () => void {
    this._eventDisposers.add(callback);
    return () => { this._eventDisposers.delete(callback); };
  }

  /** Clears batches and unsubscribes when a component is removed or its system is destroyed. */
  dispose(): void {
    for (const dispose of this._eventDisposers) dispose();
    this._eventDisposers.clear();

    this._eventRevision++;

    for (const unsubscribe of this._eventOrigins.values()) unsubscribe();
    this._eventOrigins.clear();

    this._eventPending = [];
    this._eventBatch = Object.freeze([]);
    this._eventSignature = '';
    this._receiverSystem = undefined;
    this._eventResolvedScope = undefined;

    this.executionContext = undefined;
    this.gpuExecutionContext = Object.freeze({ events: emptyGPUEvents });
  }
}
