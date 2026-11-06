import type { Node } from 'three/webgpu';
import type { EmissionContext } from './Emitter';
import type { SubSystemSource } from './EmissionSource';
import type { GPUParticleLike } from './gpu/Particle';

export type GPUEventPayload = Node<'vec4'> | readonly [Node<'vec4'>, Node<'vec4'>?, Node<'vec4'>?];
export type GPUEventData = readonly [Node<'vec4'>, Node<'vec4'>, Node<'vec4'>];

export interface GPUEmissionContext {
  transform: Node<'mat4'>;
  position: Node<'vec3'>;
  color: Node<'vec3'>;
  alpha: Node<'float'>;
  mass: Node<'float'>;
  velocity: Node<'vec3'>;
  scale: Node<'float'>;
  velocityScale: Node<'float'>;
  distortionStrength: Node<'float'>;
  duration: Node<'float'>;
}

// Payload schemas are chosen by applications. CPU payloads are intentionally unrestricted.
// False cancels the selected run; GPU boolean nodes accept or reject it per event at runtime.
export type CPUEventHandler = (data: unknown, source: SubSystemSource, context: EmissionContext) =>
  Partial<EmissionContext> | false | void;
export type GPUEventHandler = (data: GPUEventData, particle: GPUParticleLike, context: GPUEmissionContext) =>
  Partial<GPUEmissionContext> | false | Node<'bool'> | void;
export type EventSubscriptions = string[] | ({ gpu?: Record<string, GPUEventHandler> } & {
  [name: string]: true | CPUEventHandler | Record<string, GPUEventHandler> | undefined;
});

/** Transforms evaluated renderer parameters for one event-driven output; false cancels it. */
export type ParameterEventHandler<T, Data = unknown> = (data: Data, source: SubSystemSource, parameters: Readonly<T>) =>
  Partial<T> | false | void;
export type ParameterEventSubscription<T, Data = unknown> = boolean | ParameterEventHandler<T, Data>;
export type ParameterEventSubscriptions<T> = string[] | Record<string, ParameterEventSubscription<T> | undefined>;

export function parameterEventHandler<T>(events: ParameterEventSubscriptions<T>, name: string):
ParameterEventSubscription<T> | undefined {
  return Array.isArray(events) ? events.includes(name) ? true : undefined : events[name];
}

/** Shares selection syntax with emitters while preserving a renderer's own parameter type. */
export function subscribeParameterEvent<T>(events: ParameterEventSubscriptions<T>, name: string,
  handler: ParameterEventSubscription<T>): ParameterEventSubscriptions<T> {
  return { ...(Array.isArray(events) ? Object.fromEntries(events.map(event => [event, true])) : events),
    [name]: handler };
}

export function transformEventParameters<T>(handler: ParameterEventSubscription<T>, data: unknown,
  source: SubSystemSource, parameters: T): T | undefined {
  if (!handler) return;
  const overrides = typeof handler === 'function' ? handler(data, source, parameters) : undefined;
  return overrides === false ? undefined : { ...parameters, ...overrides };
}

/** Resolves event names selected by either the shorthand list or CPU/GPU handler maps. */
export function eventNames(events?: string[] | Record<string, unknown>): string[] {
  if (!events) return [];
  return Array.isArray(events) ? events : Array.from(new Set([
    ...Object.keys(events).filter(name => name !== 'gpu'),
    ...Object.keys(events.gpu && typeof events.gpu === 'object' ? events.gpu : {}),
  ]));
}

/** Returns a CPU callback when the subscription supplies one for the selected event. */
export function cpuEventHandler(events: EventSubscriptions | undefined, name: string): CPUEventHandler | undefined {
  const handler = events && !Array.isArray(events) ? events[name] : undefined;
  return typeof handler === 'function' ? handler : undefined;
}
