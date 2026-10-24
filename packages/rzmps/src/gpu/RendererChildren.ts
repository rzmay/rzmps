import { StorageBufferAttribute, type ComputeNode, type Node, type WebGPURenderer } from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  atomicAdd,
  atomicLoad,
  atomicStore,
  cos,
  float,
  hash,
  instanceIndex,
  sin,
  storage,
  uint,
  uniform,
  uvec2,
  vec3,
} from 'three/tsl';
import type ParticleSystem from '../ParticleSystem';
import type { DynamicValue } from '../types/DynamicValue';
import type { RendererChildrenOptions, CompensationMode } from '../Renderer';
import { GPUDynamicParameterStore } from '../helpers/evaluateDynamicGPU';
import { evaluateByParameterNumberGPU } from '../helpers/evaluateByParameterGPU';
import {
  GPUParticleRenderBufferState,
  destroyGPUStorageAttribute,
  type GPUParticleBufferState,
} from './Particle';
import { nextPowerOfTwo, type AtomicUintStorage, type PackedFloatStorage } from './Storage';

/** A reusable, compact GPU visual arena. Simulation slots are never modified here. */
export default class GPURendererChildren {
  private output?: GPUParticleRenderBufferState;
  private mapping?: StorageBufferAttribute;
  private counters?: StorageBufferAttribute;
  private spacing?: PackedFloatStorage;
  private renderer?: WebGPURenderer;
  private nodes: ComputeNode[] = [];
  private key = '';
  private input?: GPUParticleBufferState | GPUParticleRenderBufferState;
  private readonly parameters = new GPUDynamicParameterStore();
  private options: RendererChildrenOptions = {};
  private readonly quality = uniform(1, 'float');

  prepare(
    input: GPUParticleBufferState | GPUParticleRenderBufferState,
    system: ParticleSystem,
    options: RendererChildrenOptions,
    compensation: CompensationMode | `${CompensationMode}`,
    version: number,
    tagMask?: number,
  ): GPUParticleBufferState | GPUParticleRenderBufferState {
    if (system.quality <= 0) return input;
    const mode = compensation === 'children' && system.quality >= 1 ? 'none' : compensation;
    if ((!options.count || options.count === 0) && mode !== 'children') return input;
    const renderer = system.sceneRenderer as WebGPURenderer;
    if (!renderer || input.count === 0) return input;
    this.renderer = renderer;
    this.options = options;
    const q = system.quality;
    this.quality.value = q;
    // Buffers cannot be resized by a GPU shader. Reserve an aggregate arena from
    // the distribution's mean and variance, rather than N * maximum child count.
    // All writes are bounds checked; capacity is also bounded by default device limits.
    const moments = this.getCountMoments(options.count ?? 0);
    const multiplier = mode === 'children' && q > 0 ? 1 / q : 1;
    const expected = input.count * (1 + moments.mean);
    const reserve = expected + 8 * Math.sqrt(input.count * moments.variance) + 16 * moments.mean + moments.maximum;
    const backend = renderer.backend as unknown as {
      device?: { limits: { maxStorageBufferBindingSize: number } };
    };
    const limit = Math.floor((backend?.device?.limits.maxStorageBufferBindingSize ?? 134217728) / 64);
    // Opaque TSL expressions cannot provide a CPU-side allocation bound. Use
    // the device-bounded global arena, not an assumed per-parent maximum.
    const capacity = moments.opaque ? limit
      : Math.min(nextPowerOfTwo(Math.max(input.count, Math.ceil(reserve * multiplier), 256)), limit);
    if (!this.output || this.output.capacity < capacity || this.input !== input) {
      this.reset();
      this.renderer = renderer;
      this.output = new GPUParticleRenderBufferState(capacity);
      this.output.ensureCount(capacity);
      this.mapping = new StorageBufferAttribute(new Uint32Array((capacity + 1) * 2), 2);
      this.counters = new StorageBufferAttribute(new Uint32Array(4), 1);
      this.input = input;
    }
    if (mode === 'children' && system.gpuParticleBuffers) {
      const spacing = system.getParticleSpacingGPU();
      if (this.spacing !== spacing) {
        this.spacing = spacing;
        this.key = '';
      }
    }
    this.parameters.sync();
    const key = `${version}:${input.version}:${input.count}:${this.output.capacity}:${mode}`;
    if (key !== this.key) {
      this.nodes.forEach(n => n.dispose());
      this.nodes = this.build(input, mode, tagMask);
      this.key = key;
    }
    this.nodes.forEach(node => renderer.compute(node));
    return this.output;
  }

  private build(
    input: GPUParticleBufferState | GPUParticleRenderBufferState,
    compensation: CompensationMode | `${CompensationMode}`,
    tagMask?: number,
  ): ComputeNode[] {
    const output = this.output!;
    const count = input.count;
    const capacity = output.capacity;
    const options = this.options;
    const mapping = storage(this.mapping!, 'uvec2', capacity + 1);
    const counters = storage(this.counters!, 'uint', 4).toAtomic() as unknown as AtomicUintStorage;
    const spacing = this.spacing;
    const originalCount = uint(count);
    const lodStart = originalCount.add(atomicLoad(counters.element(0)));
    const range = originalCount.add(atomicLoad(counters.element(0))).add(atomicLoad(counters.element(1)));
    output.instanceCountNode = range.lessThan(uint(capacity)).select(range, uint(capacity)) as Node<'uint'>;
    output.storage.hierarchy = { mapping, originalCount, lodStart: mapping.element(capacity).y };
    // Recreate the public view after installing hierarchy metadata.
    output.particle = output.storage.createParticle();
    output.version += 1;
    const nodes: ComputeNode[] = [];
    nodes.push(Fn(() => {
      atomicStore(counters.element(0), uint(0));
      atomicStore(counters.element(1), uint(0));
      atomicStore(counters.element(2), uint(0));
    })().compute(1));
    nodes.push(Fn(() => {
      output.storage.createStateNode().x.assign(uint(0));
    })().compute(capacity));
    const lod = compensation === 'children';
    const copy = (sourceIndex: Node<'uint'>, destination: Node<'uint'>, fromInput: boolean) => {
      const sourceStorage = fromInput ? input.storage : output.storage;
      const source = sourceStorage.createParticle(sourceIndex);
      const target = output.storage.createParticle(destination);
      target.position.assign(source.position);
      target.rotation.assign(source.rotation);
      target.scale.assign(source.scale);
      target.color.assign(source.color);
      target.alpha.assign(source.alpha);
      target.distortionStrength.assign(source.distortionStrength);
      target.realtime.assign(source.realtime);
      target.time.assign(source.time);
      output.storage.createStateNode(destination).assign(sourceStorage.createStateNode(sourceIndex));
      return target;
    };
    const seedFor = (id: Node<'uvec2'>, ordinal: Node<'uint'>, stage: number) =>
      id.x.bitXor(id.y.mul(uint(65537))).bitXor(ordinal.mul(uint(2246822519))).bitXor(uint(stage));
    const offset = (seed: Node<'uint'>, radius: Node<'float'>) => {
      const z = hash(seed.add(1)).mul(2).sub(1);
      const angle = hash(seed.add(2)).mul(Math.PI * 2);
      const r = hash(seed.add(3)).pow(1 / 3).mul(radius);
      const xy = float(1).sub(z.mul(z)).max(0).sqrt();
      return vec3(xy.mul(cos(angle)), xy.mul(sin(angle)), z).mul(r);
    };
    nodes.push(Fn(() => {
      const parent = copy(instanceIndex, instanceIndex, true);
      const selected = tagMask === undefined ? parent.alive.notEqual(uint(0))
        : parent.alive.notEqual(uint(0)).and(parent.tagMask.bitAnd(uint(tagMask)).notEqual(uint(0)));
      If(selected, () => {
        const id = uvec2(instanceIndex, parent.generation);
        const seed = seedFor(id, uint(0), 12347);
        const count = this.parameters.number('children.count', () => this.options.count, float(0), 0, seed);
        const n = uint(count.max(0).floor()).toVar();
        const start = atomicAdd(counters.element(0), n).add(originalCount).toVar();
        Loop({ start: uint(0), end: n, type: 'uint', condition: '<' }, ({ i }) => {
          const destination = start.add(i).toVar();
          If(destination.lessThan(uint(capacity)), () => {
            const child = copy(instanceIndex, destination, true);
            mapping.element(destination.sub(originalCount)).assign(uvec2(instanceIndex, i));
            const childSeed = seedFor(id, i, 0x72656e64);
            const radius = float(Math.max(0, options.radius ?? 0));
            const delta = offset(childSeed, radius);
            child.position.addAssign(delta);
            const d = radius.greaterThan(float(0)).select(delta.length().div(radius.max(1e-8)), float(0));
            const parameter = (amount: number, stream: number) => {
              const t = d.add(hash(childSeed.add(stream)).sub(0.5).mul(amount)).clamp(0, 1);
              return options.radialFalloff ? evaluateByParameterNumberGPU(options.radialFalloff, t) : t;
            };
            const evaluate = (v: RendererChildrenOptions['scale'], t: Node<'float'>) =>
              typeof v === 'number' || v === undefined ? float(v ?? 1) : evaluateByParameterNumberGPU(v, t);
            child.scale.mulAssign(evaluate(options.scale, parameter(options.randomizeScale ?? 0, 4)));
            child.alpha.mulAssign(evaluate(options.alpha, parameter(options.randomizeAlpha ?? 0, 5)));
          }).Else(() => {
            atomicAdd(counters.element(2), uint(1));
          });
        });
      });
    })().compute(count));
    nodes.push(Fn(() => {
      mapping.element(capacity).assign(uvec2(originalCount, lodStart));
    })().compute(1));
    if (lod) {
      nodes.push(Fn(() => {
        If(instanceIndex.lessThan(lodStart).and(instanceIndex.lessThan(uint(capacity))), () => {
          const parent = output.storage.createParticle();
          If(parent.alive.notEqual(uint(0)), () => {
            const count = this.quality.greaterThan(float(0)).select(
              float(1).div(this.quality.max(1e-8)).sub(1),
              float(0),
            );
            const full = uint(count.floor());
            const seed = seedFor(parent.id, full, 0x6c6f6421);
            const n = full.add(hash(seed).lessThan(count.sub(float(full))).select(uint(1), uint(0))).toVar();
            const start = atomicAdd(counters.element(1), n).add(lodStart).toVar();
            const rootIndex = parent.root.index;
            Loop({ start: uint(0), end: n, type: 'uint', condition: '<' }, ({ i }) => {
              const destination = start.add(i).toVar();
              If(destination.lessThan(uint(capacity)), () => {
                const child = copy(instanceIndex, destination, false);
                mapping.element(destination.sub(originalCount)).assign(uvec2(instanceIndex, i));
                const radius = spacing!.element(rootIndex).x;
                child.position.addAssign(offset(seedFor(parent.id, i, 0x6c6f6421), radius));
              }).Else(() => {
                atomicAdd(counters.element(2), uint(1));
              });
            });
          });
        });
      })().compute(capacity));
    }
    const phases = ['reset', 'clear', 'artistic', 'partitions', ...(lod ? ['lod'] : [])];
    nodes.forEach((node, index) => node.setName(`rzmps.children.${phases[index]}`));
    return nodes;
  }

  reset(): void {
    this.nodes.forEach(node => node.dispose());
    this.nodes = [];
    this.key = '';
    this.output?.dispose(this.renderer);
    this.output = undefined;
    for (const attribute of [this.mapping, this.counters]) {
      if (attribute) destroyGPUStorageAttribute(this.renderer, attribute);
    }
    this.mapping = undefined;
    this.counters = undefined;
    this.spacing = undefined;
    this.input = undefined;
  }

  private getCountMoments(value: DynamicValue<number> | undefined): {
    mean: number;
    variance: number;
    maximum: number;
    opaque: boolean;
  } {
    if (typeof value === 'number' || value === undefined) {
      const count = Number.isFinite(value ?? 0) ? Math.max(0, value ?? 0) : 0;
      return { mean: count, variance: 0, maximum: count, opaque: false };
    }
    if (Array.isArray(value)) {
      const a = this.getCountMoments(value[0]);
      const b = this.getCountMoments(value[1]);
      return {
        mean: (a.mean + b.mean) / 2,
        variance: (a.mean - b.mean) ** 2 / 12 + a.variance + b.variance,
        maximum: Math.max(a.maximum, b.maximum),
        opaque: a.opaque || b.opaque,
      };
    }
    if (value instanceof Set) {
      const moments = [...value].map(item => this.getCountMoments(item));
      const count = Math.max(1, moments.length);
      const mean = moments.reduce((sum, item) => sum + item.mean, 0) / count;
      return {
        mean,
        variance: moments.reduce((sum, item) => sum + item.variance + (item.mean - mean) ** 2, 0) / count,
        maximum: Math.max(0, ...moments.map(item => item.maximum)),
        opaque: moments.some(item => item.opaque),
      };
    }
    const node = value as { isNode?: boolean; value?: unknown };
    if (node.isNode && typeof node.value === 'number') return this.getCountMoments(node.value);
    return { mean: 0, variance: 0, maximum: 0, opaque: true };
  }
}
