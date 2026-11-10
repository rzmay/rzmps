import type { Node, ComputeNode } from 'three/webgpu';
export type GPUUniformNode<T, TNode extends string> = Node<TNode> & { value: T };
export interface GPUComputeCache { key: string; node: ComputeNode; }
export interface GPUComputeListCache { key: string; nodes: ComputeNode[]; }
