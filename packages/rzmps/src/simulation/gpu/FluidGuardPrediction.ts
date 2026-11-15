import { Box3, Vector3 } from 'three';
import { StorageBufferAttribute, type ComputeNode, type Node } from 'three/webgpu';
import {
  Fn, If, atomicAdd, atomicLoad, atomicMax, atomicStore, clamp, float, floatBitsToUint,
  instanceIndex, max, min, storage, uint, uintBitsToFloat, uniform,
} from 'three/tsl';
import type { ParticleSpatialGridRenderer } from '../../spatial/structures/ParticleSpatialGrid';

const BINS = 32, STRIDE = BINS + 4;
export const GUARD_PREDICTION_HORIZON = 0.75;

export interface FluidGuardSample {
  position: Node<'vec3'>;
  velocity: Node<'vec3'>;
  remainingLifetime: Node<'float'>;
  active: Node<'bool'>;
  radius?: Node<'float'>;
  gas?: boolean;
}

export interface FluidGuardSource {
  key: object;
  compute(callback: (index: Node<'uint'>) => void): ComputeNode;
  sample(index: Node<'uint'>): FluidGuardSample;
}

export interface FluidGuardFace {
  occupiedOuterBrick: number;
  candidateCount: number;
  medianTravel: number;
  maximumTravel: number;
  predictedTravel: number;
  guardBricks: number;
  densityLifetime: number;
}

/** Compact face histograms; only the outer occupied brick band contributes. @internal */
export default class FluidGuardPrediction {
  private readonly attribute = new StorageBufferAttribute(new Uint32Array(6 * STRIDE), 1);
  private readonly values = storage(this.attribute, 'uint', 6 * STRIDE).toAtomic();
  private readonly minimum = uniform(new Vector3());
  private readonly maximum = uniform(new Vector3());
  private readonly brick = uniform(1);
  private readonly nodes = new WeakMap<object, ComputeNode[]>();
  private readonly reset = Fn(() => {
    atomicStore(this.values.element(instanceIndex), uint(0));
  })().compute(6 * STRIDE);

  private build(source: FluidGuardSource): ComputeNode[] {
    return [false, true].map(histogram => source.compute(index => {
      const sample = source.sample(index);
      If(sample.active, () => {
        const remaining = max(sample.remainingLifetime, float(0)).toVar();
        const time = clamp(remaining, 0, GUARD_PREDICTION_HORIZON).toVar();
        const position = sample.position.toVar(), velocity = sample.velocity.toVar();
        for (let face = 0; face < 6; face++) {
          const axis = (['x', 'y', 'z'] as const)[Math.floor(face / 2)], upper = face % 2 !== 0;
          const boundary = upper ? this.maximum[axis].sub(this.brick) : this.minimum[axis].add(this.brick);
          const radius = sample.radius ?? float(0);
          const near = upper ? position[axis].add(radius).greaterThanEqual(boundary)
            : position[axis].sub(radius).lessThanEqual(boundary);
          If(near, () => {
            const travel = max(velocity[axis].mul(upper ? 1 : -1), float(0)).mul(time);
            const offset = face * STRIDE;
            if (histogram) {
              const largest = uintBitsToFloat(atomicLoad(this.values.element(offset + 1))) as unknown as Node<'float'>;
              const bin = uint(min(travel.div(largest.max(1e-12)).mul(BINS).floor(), float(BINS - 1)));
              atomicAdd(this.values.element(bin.add(offset + 4)), uint(1));
            } else {
              atomicAdd(this.values.element(offset), uint(1));
              atomicMax(this.values.element(offset + 1), floatBitsToUint(travel));
              if (sample.gas) atomicMax(this.values.element(offset + 2), floatBitsToUint(remaining));
            }
          });
        }
      });
    }).setName(histogram ? 'rzmps.guard.histogram' : 'rzmps.guard.maximum'));
  }

  private kernels(source: FluidGuardSource): ComputeNode[] {
    let nodes = this.nodes.get(source.key);
    if (!nodes) { nodes = this.build(source); this.nodes.set(source.key, nodes); }
    return nodes;
  }

  async prepare(renderer: ParticleSpatialGridRenderer, sources: FluidGuardSource[]): Promise<void> {
    await (renderer as ParticleSpatialGridRenderer & {
      compileComputeAsync?(nodes: ComputeNode[]): Promise<void>;
    }).compileComputeAsync?.([this.reset, ...sources.flatMap(source => this.kernels(source))]);
  }

  async read(renderer: ParticleSpatialGridRenderer, bounds: Box3, brickSize: number,
    sources: FluidGuardSource[]): Promise<FluidGuardFace[]> {
    this.minimum.value.copy(bounds.min); this.maximum.value.copy(bounds.max); this.brick.value = brickSize;
    const kernels = sources.map(source => this.kernels(source));
    renderer.compute(this.reset);
    for (let phase = 0; phase < 2; phase++) renderer.compute(kernels.map(nodes => nodes[phase]));
    const raw = new Uint32Array(await renderer.getArrayBufferAsync(this.attribute));
    const floats = new Float32Array(raw.buffer, raw.byteOffset, raw.length);
    return Array.from({ length: 6 }, (_, face) => {
      const offset = face * STRIDE, count = raw[offset], largest = floats[offset + 1];
      let total = 0, bin = 0;
      for (; bin < BINS - 1; bin++) {
        total += raw[offset + 4 + bin];
        if (total >= Math.ceil(count / 2)) break;
      }
      // Histogram midpoint is a bounded median approximation; bin zero retains exact zero travel.
      const median = count && bin ? (bin + 0.5) * largest / BINS : 0;
      const predicted = median * 0.25 + largest * 0.75;
      const axis = (['x', 'y', 'z'] as const)[Math.floor(face / 2)];
      return { occupiedOuterBrick: face % 2 ? Math.ceil(bounds.max[axis] / brickSize) - 1
        : Math.floor(bounds.min[axis] / brickSize), candidateCount: count,
        medianTravel: median, maximumTravel: largest, predictedTravel: predicted,
        guardBricks: Math.max(1, Math.ceil(predicted / brickSize)), densityLifetime: floats[offset + 2] };
    });
  }

  dispose(): void { this.attribute.dispose(); this.reset.dispose(); }
}
