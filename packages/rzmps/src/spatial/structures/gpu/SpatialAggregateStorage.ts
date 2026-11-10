import { StorageBufferAttribute, type Node } from 'three/webgpu';
import { floatBitsToUint, uintBitsToFloat, uint, int, vec2, vec3, vec4, storage } from 'three/tsl';
import { destroyGPUStorageAttribute } from '../../../simulation/gpu/Particle';
import type { GPUStorageBufferRenderer, ScalarUintStorage } from '../../../utils/gpu/storage.utils';
import type {
  SpatialAggregateLayout, SpatialAggregateNodes, SpatialAggregateType,
} from '../../../types/spatialAggregator.types';

/** One packed binding for named, fixed-layout GPU channels. Each field reserves four uint words. */
export default class SpatialAggregateStorage<L extends SpatialAggregateLayout> {
  readonly attribute: StorageBufferAttribute;
  readonly fields: [string, SpatialAggregateType][];
  readonly stride: number;
  private readonly data: ScalarUintStorage;

  constructor(readonly layout: L, capacity: number) {
    // Validate both channel encoding and the shared memory used by region reductions.
    this.fields = Object.entries(layout);
    if (!this.fields.length) throw new RangeError('A GPU aggregate needs at least one channel.');

    const supported = ['float', 'uint', 'int', 'vec2', 'vec3', 'vec4'];
    if (this.fields.some(([, type]) => !supported.includes(type))) {
      throw new TypeError('GPU aggregate channels support float, uint, int, vec2, vec3 and vec4.');
    }

    const sharedBytes = this.fields.reduce((sum, [, type]) => sum
      + (type === 'vec4' || type === 'vec3' ? 16 : type === 'vec2' ? 8 : 4), 0) * 64;
    if (sharedBytes > 16384) {
      throw new RangeError('GPU aggregate layout exceeds portable workgroup reduction storage.');
    }

    // Four-word slots keep every channel aligned while sharing one storage binding.
    this.stride = this.fields.length * 4;
    this.attribute = new StorageBufferAttribute(new Uint32Array(Math.max(1, capacity) * this.stride), 1);
    this.data = storage(this.attribute, 'uint', this.attribute.count) as ScalarUintStorage;
  }

  read(index: Node<'uint'>): SpatialAggregateNodes<L> {
    const result: Record<string, Node> = {};

    this.fields.forEach(([name, type], field) => {
      const start = index.mul(this.stride).add(field * 4);
      const word = this.data.element(start);

      if (type === 'uint') result[name] = word;
      else if (type === 'int') result[name] = int(word);
      else {
        const v = [0, 1, 2, 3].map(i => uintBitsToFloat(this.data.element(start.add(i))) as unknown as Node<'float'>);
        result[name] = type === 'float' ? v[0] : type === 'vec2' ? vec2(v[0], v[1])
          : type === 'vec3' ? vec3(v[0], v[1], v[2]) : vec4(v[0], v[1], v[2], v[3]);
      }
    });

    return result as SpatialAggregateNodes<L>;
  }

  write(index: Node<'uint'>, value: SpatialAggregateNodes<L>): void {
    this.fields.forEach(([name, type], field) => {
      const start = index.mul(this.stride).add(field * 4);
      const node = value[name];

      if (type === 'uint' || type === 'int') this.data.element(start).assign(uint(node as unknown as Node<'uint'>));
      else {
        const width = type === 'float' ? 1 : Number(type.slice(-1));
        for (let i = 0; i < width; i++) {
          const component = type === 'float' ? node
            : (node as unknown as Node<'vec4'>)[(['x', 'y', 'z', 'w'] as const)[i]];
          this.data.element(start.add(i))
            .assign(floatBitsToUint(component as Node<'float'>) as unknown as Node<'uint'>);
        }
      }
    });
  }

  dispose(renderer?: GPUStorageBufferRenderer): void {
    destroyGPUStorageAttribute(renderer, this.attribute);
  }
}
