import type { Node } from 'three/webgpu';
import type Particle from '../Particle';
import type { OctreeNode } from '../helpers/ParticleOctree';
import type { GPUParticleLike } from '../gpu/Particle';

export type SpatialBackend = 'cpu' | 'gpu';
export type SpatialAggregateType = 'float' | 'uint' | 'int' | 'vec2' | 'vec3' | 'vec4';
/** GPU channels are explicitly named fixed-layout scalar/vector fields, not arbitrary CPU objects. */
export type SpatialAggregateLayout = Record<string, SpatialAggregateType>;
export type SpatialAggregateNodes<T> = {
  [K in keyof T]: Node<Extract<T[K], SpatialAggregateType>>;
};

/** Frame-local GPU region handle. Never retain handles across spatial rebuilds. */
export interface GPUSpatialRegion {
  depth: number;
  index: Node<'uint'>;
  valid: Node<'bool'>;
}

/** Associative raw reduction with optional derived output on retrieval.
 * CPU contributions retain the existing octree node argument and constructor-style `new` member.
 * GPU T describes the storage layout; new/combine/finalize construct TSL channel expressions.
 */
export type SpatialAggregator<T, B extends SpatialBackend = 'cpu'> = B extends 'gpu' ? {
  layout: T & SpatialAggregateLayout;
  'new'(particle?: GPUParticleLike, particleIndex?: Node<'uint'>, region?: GPUSpatialRegion): SpatialAggregateNodes<T>;
  combine(a: SpatialAggregateNodes<T>, b: SpatialAggregateNodes<T>): SpatialAggregateNodes<T>;
  finalize?(aggregate: SpatialAggregateNodes<T>): SpatialAggregateNodes<T>;
} : {
  'new'(particle?: Particle, particleIndex?: number, node?: OctreeNode<T>): T;
  combine(a: T, b: T): T;
  finalize?(aggregate: T): T;
};
