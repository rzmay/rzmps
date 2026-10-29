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
export type CPUEventHandler = (data: unknown, source: SubSystemSource, context: EmissionContext) =>
  Partial<EmissionContext> | void;
export type GPUEventHandler = (data: GPUEventData, particle: GPUParticleLike, context: GPUEmissionContext) =>
  Partial<GPUEmissionContext> | void;
export type EventSubscriptions = string[] | ({ gpu?: Record<string, GPUEventHandler> } & {
  [name: string]: true | CPUEventHandler | Record<string, GPUEventHandler> | undefined;
});
export function eventNames(events?: EventSubscriptions): string[] {
  if (!events) return [];
  return Array.isArray(events) ? events : Array.from(new Set([
    ...Object.keys(events).filter(name => name !== 'gpu'), ...Object.keys(events.gpu ?? {}),
  ]));
}
export function cpuEventHandler(events: EventSubscriptions | undefined, name: string): CPUEventHandler | undefined {
  const handler = events && !Array.isArray(events) ? events[name] : undefined;
  return typeof handler === 'function' ? handler : undefined;
}
