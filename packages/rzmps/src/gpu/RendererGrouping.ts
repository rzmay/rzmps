import { Matrix4 } from 'three';
import { IndirectStorageBufferAttribute, StorageBufferAttribute, type ComputeNode, type Node, type WebGPURenderer } from 'three/webgpu';
import { Fn, If, Loop, Break, float, uint, vec3, vec4, uvec4, instanceIndex, storage,
  uniform, floatBitsToUint, uintBitsToFloat, atomicLoad, atomicStore, atomicAdd, atomicMin, atomicMax, atomicFunc } from 'three/tsl';
import Particle from '../Particle';
import type ParticleSystem from '../ParticleSystem';
import { GPUParticleRenderBufferState, destroyGPUStorageAttribute, type GPUParticleBufferState } from './Particle';
import ParticleSpatialGrid from './ParticleSpatialGrid';
import { nextPowerOfTwo, orderedFloatNode, unorderedFloatNode, type AtomicUintStorage } from './Storage';
import { rendererGroupCount } from '../helpers/groupRendererParticles';

type Input = GPUParticleBufferState | GPUParticleRenderBufferState;
const CELLS = 512;
const EMPTY = 0xffffffff;

/** Frame-local density bins, spatial-grid assignment and segmented reductions.
 * No sorting network, global all-pairs assignment, or per-population shader rebuilds.
 */
export default class GPURendererGrouping {
  private input?: Input;
  private output?: GPUParticleRenderBufferState;
  private scratch?: StorageBufferAttribute;
  private particleDispatch?: IndirectStorageBufferAttribute;
  private groupDispatch?: IndirectStorageBufferAttribute;
  private renderer?: WebGPURenderer;
  private nodes: ComputeNode[] = [];
  private reductions: ComputeNode[] = [];
  private key = '';
  private capacity = 0;
  private maximum = 0;
  private readonly centers = new ParticleSpatialGrid({ brickSubdivisions: 2, cellSubdivisions: 0, powerOfTwoBounds: false, autoExpand: false });
  private readonly toWorld = uniform(new Matrix4(), 'mat4');
  private readonly quality = uniform(1);
  private readonly inputCount = uniform(0, 'uint');
  eligibleCount = 0;

  prepare(input: Input, system: ParticleSystem, count: number, ratio: number, radius: number, tagMask?: number): Input {
    if ((count < 0 || count >= input.count) && ratio >= 1) return input;
    if (!input.count) return input;
    const renderer = system.sceneRenderer as WebGPURenderer;
    if (!renderer?.compute) return input;
    if (system.simulationSpace === 'world') this.toWorld.value.identity();
    else this.toWorld.value.copy(system.matrixWorld);
    this.quality.value = system.quality;
    this.inputCount.value = input.count;
    this.radius = radius;
    const capacity = nextPowerOfTwo(Math.max(1, input.count));
    const maximum = Math.max(1, rendererGroupCount(input.count, count, ratio));
    const limit = (renderer.backend as unknown as { device?: { limits: { maxStorageBufferBindingSize: number } } })
      .device?.limits.maxStorageBufferBindingSize ?? 134217728;
    if ((3 * capacity + 3 * CELLS + 6 * nextPowerOfTwo(maximum) + 12) * 4 > limit || nextPowerOfTwo(maximum) * 80 > limit) {
      throw new RangeError('Renderer grouping exceeds the device storage-buffer capacity.');
    }
    if (this.input !== input || this.capacity < capacity || this.maximum < maximum) {
      this.reset();
      this.renderer = renderer;
      this.input = input;
      this.capacity = capacity;
      this.maximum = nextPowerOfTwo(maximum);
      this.output = new GPUParticleRenderBufferState(this.maximum);
      this.particleDispatch = new IndirectStorageBufferAttribute(new Uint32Array([0, 1, 1]), 1);
      this.groupDispatch = new IndirectStorageBufferAttribute(new Uint32Array([0, 1, 1]), 1);
      // records, owners and membership links; histogram, starts and cursors;
      // group regions, membership heads and heap; one small metadata block.
      this.scratch = new StorageBufferAttribute(new Uint32Array(3 * capacity + 3 * CELLS + 6 * this.maximum + 12), 1);
    }
    this.output!.ensureCount(maximum);
    const key = `${input.version}:${count}:${ratio}:${radius}:${tagMask}`;
    if (key !== this.key) {
      this.nodes.forEach(node => node.dispose());
      this.reductions.forEach(node => node.dispose());
      this.centers.dispose(renderer);
      this.nodes = this.buildSelection(input, count, ratio, radius, tagMask);
      this.output!.version++;
      this.key = key;
      this.centers.initialize(renderer, this.output! as unknown as GPUParticleBufferState);
      this.reductions = this.buildAssignment(input);
    }
    // Batched dispatches share command encoding/submission. The pass count is
    // constant with population size, rather than two O(log² capacity) networks.
    renderer.compute(this.nodes);
    // Centers temporarily hold world-space anchor positions. The common grid
    // fields are identical in compact and simulation storage; queries only read
    // position, alive, generation and index. Aggregation restores simulation space.
    this.centers.rebuild(renderer, this.output! as unknown as GPUParticleBufferState);
    renderer.compute(this.reductions);
    return this.output!;
  }

  private layout() {
    const data = storage(this.scratch!, 'uint', this.scratch!.count).toAtomic() as AtomicUintStorage;
    const records = 0, owners = this.capacity, links = 2 * this.capacity;
    const histogram = 3 * this.capacity, starts = histogram + CELLS, cursors = starts + CELLS;
    const regions = cursors + CELLS, heads = regions + 4 * this.maximum, heap = heads + this.maximum;
    const meta = heap + this.maximum;
    const asUint = (value: Node<'uint'> | number) => typeof value === 'number' ? uint(value) : value;
    const at = (offset: number, index: Node<'uint'> | number = 0) => data.element(uint(offset).add(index));
    const read = (offset: number, index: Node<'uint'> | number = 0) => atomicLoad(at(offset, index));
    const write = (offset: number, index: Node<'uint'> | number, value: Node<'uint'> | number) => { atomicStore(at(offset, index), asUint(value)); };
    const region = (g: Node<'uint'> | number, field: number) => read(regions, asUint(g).mul(4).add(field));
    const setRegion = (g: Node<'uint'> | number, field: number, value: Node<'uint'> | number) => { write(regions, asUint(g).mul(4).add(field), value); };
    return { data, records, owners, links, histogram, starts, cursors, regions, heads, heap, meta, at, read, write, region, setRegion };
  }

  private buildSelection(input: Input, count: number, ratio: number, radius: number, tagMask?: number): ComputeNode[] {
    const output = this.output!;
    const { records, owners, histogram, starts, cursors, heads, heap, meta, at, read, write, region, setRegion } = this.layout();
    const world = (i: Node<'uint'>) => this.toWorld.mul(vec4(input.storage.createParticle(i).position, 1)).xyz;
    const selected = () => {
      const p = input.storage.createParticle();
      let valid = instanceIndex.lessThan(this.inputCount).and(p.alive.notEqual(uint(0))).and(this.quality.greaterThan(0));
      if (tagMask !== undefined) valid = valid.and(p.tagMask.bitAnd(uint(tagMask)).notEqual(uint(0)));
      return valid;
    };
    const code = (p: Node<'vec3'>) => {
      const minimum = vec3(unorderedFloatNode(read(meta, 2)), unorderedFloatNode(read(meta, 3)), unorderedFloatNode(read(meta, 4)));
      const maximum = vec3(unorderedFloatNode(read(meta, 5)), unorderedFloatNode(read(meta, 6)), unorderedFloatNode(read(meta, 7)));
      const extent = maximum.sub(minimum);
      const size = extent.x.max(extent.y).max(extent.z).max(1e-6).mul(17 / 16).log2().ceil().exp2();
      const increment = size.div(16);
      const origin = minimum.div(increment).floor().mul(increment);
      const q = p.sub(origin).div(size).mul(8).floor().clamp(0, 7);
      const spread = (v: Node<'uint'>) => v.bitAnd(uint(1)).bitOr(v.bitAnd(uint(2)).shiftLeft(uint(2))).bitOr(v.bitAnd(uint(4)).shiftLeft(uint(4)));
      return spread(uint(q.x)).bitOr(spread(uint(q.y)).shiftLeft(uint(1))).bitOr(spread(uint(q.z)).shiftLeft(uint(2)));
    };
    const nodes: ComputeNode[] = [];
    nodes.push(Fn(() => {
      If(instanceIndex.lessThan(uint(CELLS)), () => { write(histogram, instanceIndex, 0); });
      If(instanceIndex.lessThan(uint(this.capacity)), () => { write(owners, instanceIndex, EMPTY); });
      If(instanceIndex.lessThan(uint(this.maximum)), () => {
        write(heads, instanceIndex, EMPTY); output.storage.createStateNode().assign(uvec4(0));
      });
      If(instanceIndex.lessThan(uint(8)), () => {
        write(meta, instanceIndex, instanceIndex.greaterThanEqual(uint(2)).and(instanceIndex.lessThan(uint(5))).select(uint(EMPTY), uint(0)));
      });
    })().compute(Math.max(this.capacity, CELLS, this.maximum)).setName('rzmps.grouping.reset'));
    nodes.push(Fn(() => {
      If(selected(), () => {
        const p = world(instanceIndex);
        atomicAdd(at(meta), uint(1));
        atomicMin(at(meta, 2), orderedFloatNode(p.x)); atomicMin(at(meta, 3), orderedFloatNode(p.y)); atomicMin(at(meta, 4), orderedFloatNode(p.z));
        atomicMax(at(meta, 5), orderedFloatNode(p.x)); atomicMax(at(meta, 6), orderedFloatNode(p.y)); atomicMax(at(meta, 7), orderedFloatNode(p.z));
      });
    })().compute(this.capacity).setName('rzmps.grouping.bounds'));
    nodes.push(Fn(() => {
      If(selected(), () => { atomicAdd(at(histogram, code(world(instanceIndex))), uint(1)); });
    })().compute(this.capacity).setName('rzmps.grouping.histogram'));
    nodes.push(Fn(() => {
      const sum = uint(0).toVar();
      Loop(CELLS, ({ i }) => {
        write(starts, uint(i), sum); write(cursors, uint(i), sum); sum.addAssign(read(histogram, uint(i)));
      });
      const cap = count < 0 || count === Infinity ? float(sum) : float(Number.isNaN(count) ? 0 : Math.max(0, count));
      const fraction = Number.isFinite(ratio) ? Math.max(0, ratio) : ratio > 0 ? 1 : 0;
      const k = uint(float(sum).mul(fraction).min(cap).add(0.5).floor().min(float(sum)));
      write(meta, 1, k);
      const particles = storage(this.particleDispatch!, 'uint', 3);
      const groups = storage(this.groupDispatch!, 'uint', 3);
      particles.element(0).assign(k.greaterThan(uint(0)).select(uint(float(sum).div(64).ceil()), uint(0)));
      groups.element(0).assign(uint(float(k).div(64).ceil()));
    })().compute(1).setName('rzmps.grouping.prefix'));
    nodes.push(Fn(() => {
      If(selected(), () => {
        const destination = atomicAdd(at(cursors, code(world(instanceIndex))), uint(1));
        write(records, destination, instanceIndex);
      });
    })().compute(this.capacity).setName('rzmps.grouping.scatter'));
    nodes.push(Fn(() => {
      setRegion(0, 0, 0); setRegion(0, 1, read(meta)); write(heap, 0, 0);
      const preferred = (a: Node<'uint'>, b: Node<'uint'>) => region(a, 1).greaterThan(region(b, 1))
        .or(region(a, 1).equal(region(b, 1)).and(region(a, 0).lessThan(region(b, 0))));
      const groupCount = read(meta, 1).toVar();
      Loop({ start: uint(1), end: groupCount, type: 'uint', condition: '<' }, ({ i }) => {
        const best = read(heap).toVar();
        const start = region(best, 0).toVar(), length = region(best, 1).toVar();
        const half = length.div(uint(2)).toVar();
        setRegion(i, 0, start.add(half)); setRegion(i, 1, length.sub(half)); setRegion(best, 1, half);
        // Sift the split root down, then insert the new region. O(K log K).
        const cursor = uint(0).toVar();
        Loop(() => {
          const child = cursor.mul(2).add(1).toVar();
          If(child.greaterThanEqual(i), () => { Break(); });
          If(child.add(1).lessThan(i), () => {
            If(preferred(read(heap, child.add(1)), read(heap, child)), () => { child.addAssign(1); });
          });
          If(preferred(read(heap, cursor), read(heap, child)), () => { Break(); });
          const old = read(heap, cursor).toVar(); write(heap, cursor, read(heap, child)); write(heap, child, old); cursor.assign(child);
        });
        const insert = i.toVar(); write(heap, insert, i);
        Loop(() => {
          If(insert.equal(uint(0)), () => { Break(); });
          const parent = insert.sub(1).div(uint(2)).toVar();
          If(preferred(read(heap, parent), read(heap, insert)), () => { Break(); });
          const old = read(heap, parent).toVar(); write(heap, parent, read(heap, insert)); write(heap, insert, old); insert.assign(parent);
        });
      });
    })().compute(1).setName('rzmps.grouping.subdivide'));
    nodes.push(Fn(() => {
      If(instanceIndex.lessThan(read(meta, 1)), () => {
        const start = region(instanceIndex, 0).toVar(), end = start.add(region(instanceIndex, 1)).toVar();
        const centroid = vec3(0).toVar();
        Loop({ start, end, type: 'uint', condition: '<' }, ({ i }) => { centroid.addAssign(world(read(records, i))); });
        centroid.divAssign(float(region(instanceIndex, 1)));
        const anchor = uint(EMPTY).toVar(), best = float(3.402823e38).toVar();
        Loop({ start, end, type: 'uint', condition: '<' }, ({ i }) => {
          const slot = read(records, i).toVar(), distance = world(slot).sub(centroid).lengthSq();
          If(distance.lessThan(best).or(distance.equal(best).and(slot.lessThan(anchor))), () => { anchor.assign(slot); best.assign(distance); });
        });
        const scaleSquared = float(1e-12).toVar();
        Loop({ start, end, type: 'uint', condition: '<' }, ({ i }) => {
          scaleSquared.assign(scaleSquared.max(world(read(records, i)).sub(world(anchor)).lengthSq()));
        });
        setRegion(instanceIndex, 2, anchor); setRegion(instanceIndex, 3, floatBitsToUint(radius > 0 ? float(radius * radius) : scaleSquared) as unknown as Node<'uint'>);
        write(owners, anchor, instanceIndex);
        output.storage.createParticle().position.assign(world(anchor));
        output.storage.createStateNode().assign(input.storage.createStateNode(anchor));
      });
    })().compute(this.maximum).setName('rzmps.grouping.centers'));
    nodes.push(Fn(() => {
      this.centers.setBoundsNode(
        vec3(unorderedFloatNode(read(meta, 2)), unorderedFloatNode(read(meta, 3)), unorderedFloatNode(read(meta, 4))),
        vec3(unorderedFloatNode(read(meta, 5)), unorderedFloatNode(read(meta, 6)), unorderedFloatNode(read(meta, 7))),
      );
    })().compute(1).setName('rzmps.grouping.gridBounds'));
    // Three supports per-node indirect dispatch at runtime; @types/three still
    // limits dispatchSize to numeric arrays. Each cached stage gets GPU counts.
    const centerNode = nodes.find(node => node.name === 'rzmps.grouping.centers')!;
    centerNode.dispatchSize = this.groupDispatch! as unknown as number[];
    output.instanceCountNode = read(meta, 1);
    output.spacingIndex = i => region(i, 2);
    return nodes;
  }

  private buildAssignment(input: Input): ComputeNode[] {
    const output = this.output!;
    const { records, owners, links, heads, meta, at, read, write, region } = this.layout();
    const assign = Fn(() => {
      If(instanceIndex.lessThan(read(meta)), () => {
        const slot = read(records, instanceIndex).toVar();
        const position = this.toWorld.mul(vec4(input.storage.createParticle(slot).position, 1)).xyz;
        const group = read(owners, slot).toVar();
        If(group.equal(uint(EMPTY)), () => { group.assign(this.centers.nearestParticleIndexNode(position, float(this.radius))); });
        If(group.notEqual(uint(EMPTY)), () => {
          const previous = atomicFunc('atomicExchange' as Parameters<typeof atomicFunc>[0], at(heads, group), slot);
          write(links, slot, previous);
        });
      });
    })().compute(this.capacity).setName('rzmps.grouping.assign');
    const reduce = Fn(() => {
      If(instanceIndex.lessThan(read(meta, 1)), () => {
        const anchor = region(instanceIndex, 2).toVar();
        const center = this.toWorld.mul(vec4(input.storage.createParticle(anchor).position, 1)).xyz;
        const s = uintBitsToFloat(region(instanceIndex, 3)) as unknown as Node<'float'>;
        const target = output.storage.createParticle();
        const weightSum = float(0).toVar(), contribution = float(0).toVar();
        const position = vec3(0).toVar(), rotation = vec3(0).toVar(), scale = vec3(0).toVar(), color = vec3(0).toVar(), velocity = vec3(0).toVar();
        const alpha = float(0).toVar(), distortion = float(0).toVar(), time = float(0).toVar(), realtime = float(0).toVar();
        const slot = read(heads, instanceIndex).toVar();
        Loop(() => {
          If(slot.equal(uint(EMPTY)), () => { Break(); });
          const source = input.storage.createParticle(slot);
          const d = this.toWorld.mul(vec4(source.position, 1)).xyz.sub(center).lengthSq();
          const w = float(1).div(float(1).add(d.div(s.max(1e-12))));
          weightSum.addAssign(w); contribution.addAssign(source.contribution);
          position.addAssign(source.position.mul(w)); rotation.addAssign(source.rotation.mul(w)); scale.addAssign(source.scale.mul(w));
          color.addAssign(source.color.mul(w)); velocity.addAssign(source.velocity.mul(w)); alpha.addAssign(source.alpha.mul(w));
          distortion.addAssign(source.distortionStrength.mul(w)); time.addAssign(source.time.mul(w)); realtime.addAssign(source.realtime.mul(w));
          slot.assign(read(links, slot));
        });
        target.position.assign(position.div(weightSum)); target.rotation.assign(rotation.div(weightSum)); target.scale.assign(scale.div(weightSum));
        target.color.assign(color.div(weightSum)); target.velocity.assign(velocity.div(weightSum)); target.alpha.assign(alpha.div(weightSum));
        target.distortionStrength.assign(distortion.div(weightSum)); target.time.assign(time.div(weightSum)); target.realtime.assign(realtime.div(weightSum));
        target.contribution.assign(contribution);
      });
    })().compute(this.maximum).setName('rzmps.grouping.aggregate');
    assign.dispatchSize = this.particleDispatch! as unknown as number[];
    reduce.dispatchSize = this.groupDispatch! as unknown as number[];
    return [assign, reduce];
  }

  private radius = -1;

  async readback(): Promise<Particle[]> {
    const output = this.output!, renderer = this.renderer!;
    const metaOffset = 3 * this.capacity + 3 * CELLS + 6 * this.maximum;
    const [floatBuffer, stateBuffer, metaBuffer] = await Promise.all([
      renderer.getArrayBufferAsync(output.attributes.floatData), renderer.getArrayBufferAsync(output.attributes.uintData),
      renderer.getArrayBufferAsync(this.scratch!, null, metaOffset * 4, 8),
    ]);
    const data = new Float32Array(floatBuffer), states = new Uint32Array(stateBuffer), meta = new Uint32Array(metaBuffer);
    this.eligibleCount = meta[0];
    return Array.from({ length: Math.min(meta[1], output.count) }, (_, i) => {
      const p = new Particle(), o = i * 20;
      p.position.fromArray(data, o); p.alpha = data[o + 3]; p.rotation.fromArray(data, o + 4); p.distortionStrength = data[o + 7];
      p.scale.fromArray(data, o + 8); p.realtime = data[o + 11]; p.color.fromArray(data, o + 12); p.time = data[o + 15];
      p.contribution = data[o + 16]; p.velocity.fromArray(data, o + 17); p.id = `group:${i}:${states[i * 4 + 2]}`;
      return p;
    });
  }

  reset(): void {
    [...this.nodes, ...this.reductions].forEach(node => node.dispose()); this.nodes = []; this.reductions = [];
    this.centers.dispose(this.renderer); this.output?.dispose(this.renderer); this.output = undefined;
    if (this.scratch) destroyGPUStorageAttribute(this.renderer, this.scratch);
    for (const args of [this.particleDispatch, this.groupDispatch]) {
      if (args) destroyGPUStorageAttribute(this.renderer, args);
    }
    this.particleDispatch = undefined; this.groupDispatch = undefined;
    this.scratch = undefined; this.input = undefined; this.key = ''; this.capacity = 0; this.maximum = 0;
  }
}
