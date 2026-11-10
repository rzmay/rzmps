import { Matrix4 } from 'three';
import {
  IndirectStorageBufferAttribute,
  StorageBufferAttribute,
  type ComputeNode,
  type Node,
  type WebGPURenderer,
} from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  Break,
  float,
  uint,
  vec3,
  vec4,
  uvec4,
  instanceIndex,
  storage,
  uniform,
  floatBitsToUint,
  uintBitsToFloat,
  atomicLoad,
  atomicStore,
  atomicAdd,
  atomicMin,
  atomicMax,
  atomicFunc,
  localId,
  workgroupId,
  workgroupArray,
  workgroupBarrier,
} from 'three/tsl';
import Particle from '../../core/Particle';
import type ParticleSystem from '../../core/ParticleSystem';
import {
  GPUParticleRenderBufferState,
  destroyGPUStorageAttribute,
  type GPUParticleBufferState,
} from '../../simulation/gpu/Particle';
import ParticleSpatialGrid from '../../spatial/structures/ParticleSpatialGrid';
import { RENDER_FLOAT_SLOT_COUNT } from '../../simulation/gpu/particleLayout.utils';
import {
  nextPowerOfTwo,
  orderedFloatNode,
  unorderedFloatNode,
  type AtomicUintStorage,
} from '../../utils/gpu/storage.utils';
import { rendererGroupCount } from '../groupRendererParticles';
import { computeRange, writeComputeDispatch, type GPUComputeRange } from '../../utils/gpu/computeDispatch.utils';
import { SpatialLevels } from '../../enums/resolveSpatialLevels';
import type { SpatialAggregator } from '../../types/spatialAggregator.types';

type Input = GPUParticleBufferState | GPUParticleRenderBufferState;
type Summary = { count: 'uint'; sum: 'vec3' };
const EMPTY = 0xffffffff;
const summary: SpatialAggregator<Summary, 'gpu'> = {
  layout: { count: 'uint', sum: 'vec3' },
  new: p => ({ count: uint(p ? 1 : 0), sum: p?.position ?? vec3(0) }),
  combine: (a, b) => ({ count: a.count.add(b.count), sum: a.sum.add(b.sum) }),
};

/** Renderer policy over reusable spatial aggregates. Membership remains exact nearest-anchor assignment. */
export default class GPURendererGrouping {
  private input?: Input;
  private output?: GPUParticleRenderBufferState;
  private snapshot?: GPUParticleRenderBufferState;
  private scratch?: StorageBufferAttribute;
  private scratchNode?: AtomicUintStorage;
  private particleDispatch?: IndirectStorageBufferAttribute;
  private groupDispatch?: IndirectStorageBufferAttribute;
  private anchorDispatch?: IndirectStorageBufferAttribute;
  private particleRange?: GPUComputeRange;
  private groupRange?: GPUComputeRange;
  private renderer?: WebGPURenderer;
  private nodes: ComputeNode[] = [];
  private selection: ComputeNode[] = [];
  private reductions: ComputeNode[] = [];
  private key = '';
  private capacity = 0;
  private maximum = 0;
  private regionCapacity = 0;
  private readonly source = new ParticleSpatialGrid<Summary>(
    {
      brickSubdivisions: 2,
      cellSubdivisions: 2,
      powerOfTwoBounds: false,
      autoExpand: false,
      levels: SpatialLevels.All,
    },
    summary,
  );
  private readonly centers = new ParticleSpatialGrid({
    brickSubdivisions: 2,
    cellSubdivisions: 0,
    powerOfTwoBounds: false,
    autoExpand: false,
  });
  private readonly toWorld = uniform(new Matrix4(), 'mat4');
  private readonly quality = uniform(1);
  private readonly inputCount = uniform(0, 'uint');
  eligibleCount = 0;
  private radius = -1;

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

    // Keep allocations stable until the source or required capacity changes.
    const capacity = nextPowerOfTwo(Math.max(1, input.count));
    const maximum = Math.max(1, rendererGroupCount(input.count, count, ratio));
    if (this.input !== input || this.capacity < capacity || this.maximum < maximum) {
      this.reset();
      this.renderer = renderer;
      this.input = input;
      this.capacity = capacity;
      this.maximum = nextPowerOfTwo(maximum);
      this.output = new GPUParticleRenderBufferState(this.maximum);
      this.snapshot = new GPUParticleRenderBufferState(capacity);
      this.snapshot.ensureCount(input.count);

      // These spatial snapshots expose only position/state; the source reducer reads no simulation-only channels.
      this.source.initialize(renderer, this.snapshot as unknown as GPUParticleBufferState);
      this.centers.initialize(renderer, this.output as unknown as GPUParticleBufferState);
      this.regionCapacity = this.source.levels.reduce((sum, depth) => sum + this.source.getRegions(depth).capacity, 0);

      this.particleDispatch = new IndirectStorageBufferAttribute(new Uint32Array([0, 1, 1]), 1);
      this.groupDispatch = new IndirectStorageBufferAttribute(new Uint32Array([0, 1, 1]), 1);
      this.anchorDispatch = new IndirectStorageBufferAttribute(new Uint32Array([0, 1, 1]), 1);

      const words = 3 * capacity + 6 * this.maximum + 2 * this.regionCapacity + 12;
      const limit =
        (
          renderer.backend as unknown as {
            device?: { limits: { maxStorageBufferBindingSize: number } };
          }
        ).device?.limits.maxStorageBufferBindingSize ?? 134217728;
      if (words * 4 > limit || capacity * 80 > limit) {
        this.reset();
        throw new RangeError('Renderer grouping exceeds the device storage-buffer capacity.');
      }
      this.scratch = new StorageBufferAttribute(new Uint32Array(words), 1);
    }

    this.output!.ensureCount(maximum);
    this.snapshot!.ensureCount(input.count);

    // Recreate shader graphs only when their inputs or grouping policy change.
    const key = `${input.version}:${count}:${ratio}:${radius}:${tagMask}`;
    if (key !== this.key) {
      [...this.nodes, ...this.selection, ...this.reductions].forEach(node => node.dispose());
      const layout = this.layout();
      this.particleRange = { count: layout.read(layout.meta), dispatch: this.particleDispatch! };
      this.groupRange = { count: layout.read(layout.meta, 1), dispatch: this.groupDispatch! };
      this.nodes = this.buildSnapshot(input, count, ratio, tagMask);
      this.selection = this.buildSelection(input);
      this.reductions = this.buildAssignment(input);
      this.output!.instanceCountNode = this.groupRange.count;
      this.output!.spacingIndex = i => layout.read(layout.seeds, i);
      this.output!.version++;
      this.key = key;
    }

    // Snapshot -> source hierarchy -> anchor selection -> nearest assignment -> visual reduction.
    renderer.compute(this.nodes);
    this.source.rebuild(renderer, this.snapshot! as unknown as GPUParticleBufferState, undefined, this.particleRange);
    renderer.compute(this.selection);
    this.centers.rebuild(renderer, this.output! as unknown as GPUParticleBufferState, undefined, this.groupRange);
    renderer.compute(this.reductions);

    return this.output!;
  }

  private layout() {
    const data = (this.scratchNode ??= storage(
      this.scratch!,
      'uint',
      this.scratch!.count,
    ).toAtomic() as AtomicUintStorage);
    const records = 0;
    const owners = this.capacity;
    const links = 2 * this.capacity;
    const heads = 3 * this.capacity;
    const seeds = heads + this.maximum;
    const support = seeds + this.maximum;
    const taskCells = support + this.maximum;
    const taskLevels = taskCells + this.maximum;
    const ordinals = taskLevels + this.maximum;
    const budgets = ordinals + this.maximum;
    const starts = budgets + this.regionCapacity;
    const meta = starts + this.regionCapacity;

    const at = (offset: number, index: Node<'uint'> | number = 0) => data.element(uint(offset).add(index));
    const read = (offset: number, index: Node<'uint'> | number = 0) => atomicLoad(at(offset, index)).toVar();
    const write = (offset: number, index: Node<'uint'> | number, value: Node<'uint'> | number) => {
      atomicStore(at(offset, index), typeof value === 'number' ? uint(value) : value);
    };

    return {
      records,
      owners,
      links,
      heads,
      seeds,
      support,
      taskCells,
      taskLevels,
      ordinals,
      budgets,
      starts,
      meta,
      at,
      read,
      write,
    };
  }

  private buildSnapshot(input: Input, count: number, ratio: number, tagMask?: number): ComputeNode[] {
    const { records, owners, heads, budgets, meta, at, read, write } = this.layout();

    const reset = Fn(() => {
      If(instanceIndex.lessThan(this.maximum), () => {
        write(heads, instanceIndex, EMPTY);
        this.output!.storage.createStateNode().assign(uvec4(0));
      });
      If(instanceIndex.lessThan(this.regionCapacity), () => {
        write(budgets, instanceIndex, 0);
      });
      If(instanceIndex.lessThan(8), () => {
        write(
          meta,
          instanceIndex,
          instanceIndex.greaterThanEqual(2).and(instanceIndex.lessThan(5)).select(uint(EMPTY), uint(0)),
        );
      });
    })()
      .compute(Math.max(this.maximum, this.regionCapacity, 8))
      .setName('rzmps.grouping.reset');

    // Compact eligible slots while reducing their world-space bounds.
    const project = Fn(() => {
      const p = input.storage.createParticle();
      let selected = instanceIndex.lessThan(this.inputCount).and(p.alive.notEqual(0)).and(this.quality.greaterThan(0));
      if (tagMask !== undefined) selected = selected.and(p.tagMask.bitAnd(tagMask).notEqual(0));
      If(selected, () => {
        const destination = atomicAdd(at(meta), 1).toVar();
        const position = this.toWorld.mul(vec4(p.position, 1)).xyz.toVar();
        this.snapshot!.storage.createParticle(destination).position.assign(position);
        this.snapshot!.storage.createStateNode(destination).assign(input.storage.createStateNode());
        write(records, destination, instanceIndex);
        write(owners, instanceIndex, EMPTY);
        atomicMin(at(meta, 2), orderedFloatNode(position.x));
        atomicMin(at(meta, 3), orderedFloatNode(position.y));
        atomicMin(at(meta, 4), orderedFloatNode(position.z));
        atomicMax(at(meta, 5), orderedFloatNode(position.x));
        atomicMax(at(meta, 6), orderedFloatNode(position.y));
        atomicMax(at(meta, 7), orderedFloatNode(position.z));
      });
    })()
      .compute(this.capacity)
      .setName('rzmps.grouping.snapshot');

    // Convert the resulting population and anchor budget into indirect dispatch sizes.
    const schedule = Fn(() => {
      const n = read(meta);
      const cap = count < 0 || count === Infinity ? float(n) : float(Number.isNaN(count) ? 0 : Math.max(0, count));
      const fraction = Number.isFinite(ratio) ? Math.max(0, ratio) : ratio > 0 ? 1 : 0;
      const k = uint(float(n).mul(fraction).min(cap).add(0.5).floor().min(float(n))).toVar();
      write(meta, 1, k);
      writeComputeDispatch(this.particleRange!);
      // K was written in this pass, so use the local value, not a cached load from before the write.
      writeComputeDispatch({ count: k, dispatch: this.groupDispatch! });
      const args = storage(this.anchorDispatch!, 'uint', 3);
      args.element(0).assign(uint(float(k).min(256)));
      args.element(1).assign(k.add(255).div(256));
      args.element(2).assign(1);

      If(n.greaterThan(0), () => {
        const minimum = vec3(
          unorderedFloatNode(read(meta, 2)),
          unorderedFloatNode(read(meta, 3)),
          unorderedFloatNode(read(meta, 4)),
        );
        const maximum = vec3(
          unorderedFloatNode(read(meta, 5)),
          unorderedFloatNode(read(meta, 6)),
          unorderedFloatNode(read(meta, 7)),
        );
        this.source.setBoundsNode(minimum, maximum);
        this.centers.setBoundsNode(minimum, maximum);
      });
    })()
      .compute(1)
      .setName('rzmps.grouping.schedule');

    return [reset, project, schedule];
  }

  private buildSelection(input: Input): ComputeNode[] {
    const { records, owners, seeds, support, taskCells, taskLevels, ordinals, budgets, starts, meta, read, write } =
      this.layout();
    const nodes: ComputeNode[] = [];

    // Refine a population-proportional budget through the maintained source levels.
    nodes.push(
      Fn(() => {
        If(read(meta, 1).greaterThan(0), () => {
          const root = this.source.getRegions(0).region(uint(0));
          write(budgets, root.index, read(meta, 1));
          write(starts, root.index, 0);
        });
      })()
        .compute(1)
        .setName('rzmps.grouping.root'),
    );

    let base = 0;
    for (const depth of this.source.levels) {
      const offset = base;
      const regions = this.source.getRegions(depth);
      const nextOffset = base + regions.capacity;
      nodes.push(
        this.source
          .computeRegions(depth, region => {
            const budget = read(budgets, region.index.add(offset)).toVar();
            const start = read(starts, region.index.add(offset)).toVar();
            If(budget.greaterThan(0), () => {
              const children = this.source.getChildren(region);
              If(budget.equal(1).or(children.count.equal(0)), () => {
                const bounds = this.source.getBounds(region);
                const scale =
                  this.radius > 0 ? float(this.radius * this.radius) : bounds.max.sub(bounds.min).lengthSq().max(1e-12);
                Loop({ start: uint(0), end: budget, type: 'uint', condition: '<' }, ({ i }) => {
                  const group = start.add(i);
                  write(taskCells, group, region.index);
                  write(taskLevels, group, depth);
                  write(support, group, floatBitsToUint(scale) as unknown as Node<'uint'>);
                  const ordinal = uint(
                    float(i)
                      .div(float(budget))
                      .mul(float(this.source.getAggregate(region).count)),
                  );
                  write(ordinals, group, budget.equal(1).select(uint(EMPTY), ordinal));
                });
              }).Else(() => {
                const total = float(this.source.getAggregate(region).count).toVar();
                const cumulative = float(0).toVar();
                const assigned = uint(0).toVar();
                Loop({ start: uint(0), end: children.count, type: 'uint', condition: '<' }, ({ i }) => {
                  const child = children.region(uint(i));
                  const size = float(this.source.getAggregate(child).count).toVar();
                  cumulative.addAssign(size);
                  const end = uint(
                    float(budget)
                      .mul(cumulative.div(total))
                      .floor()
                      .max(float(budget).sub(total.sub(cumulative)).max(0))
                      .min(float(assigned).add(size))
                      .min(float(budget)),
                  ).toVar();
                  write(budgets, child.index.add(nextOffset), end.sub(assigned));
                  write(starts, child.index.add(nextOffset), start.add(assigned));
                  assigned.assign(end);
                });
              });
            });
          })
          .setName('rzmps.grouping.refine'),
      );
      base = nextOffset;
    }

    // Snap each selected region to an actual particle using a cooperative nearest-centroid reduction.
    const sharedDistance = workgroupArray('float', 64) as unknown as { element(i: Node): Node<'float'> };
    const sharedIndex = workgroupArray('uint', 64) as unknown as { element(i: Node): Node<'uint'> };
    const anchors = Fn(() => {
      const group = workgroupId.x.add(workgroupId.y.mul(256));
      const best = float(3.402823e38).toVar();
      const seed = uint(EMPTY).toVar();
      If(group.lessThan(this.groupRange!.count), () => {
        const depth = read(taskLevels, group).toVar();
        const cell = read(taskCells, group).toVar();
        const centroid = vec3(0).toVar();
        for (const d of this.source.levels) {
          If(depth.equal(d), () => {
            const a = this.source.getAggregate({ depth: d, index: cell, valid: uint(1).equal(1) });
            centroid.assign(a.sum.div(float(a.count).max(1)));
          });
        }

        // Descend only the selected region. Distinct selected regions cannot snap to the same source slot.
        for (const d of this.source.levels.slice(0, -1)) {
          If(depth.equal(d), () => {
            const children = this.source.getChildren({ depth: d, index: cell, valid: uint(1).equal(1) });
            const best = float(3.402823e38).toVar();
            const selected = cell.toVar();
            Loop({ start: uint(0), end: children.count, type: 'uint', condition: '<' }, ({ i }) => {
              const child = children.region(uint(i));
              const a = this.source.getAggregate(child);
              const distance = a.sum.div(float(a.count).max(1)).sub(centroid).lengthSq().toVar();
              If(distance.lessThan(best), () => {
                best.assign(distance);
                selected.assign(child.index);
              });
            });
            cell.assign(selected);
            depth.assign(d + 1);
          });
        }

        const particles = this.source.getParticleIndices({
          depth: this.source.maxDepth,
          index: cell,
          valid: uint(1).equal(1),
        });
        const ordinal = read(ordinals, group).toVar();
        If(ordinal.notEqual(EMPTY), () => {
          If(localId.x.equal(0), () => {
            seed.assign(particles.index(ordinal));
            best.assign(0);
          });
        }).Else(() => {
          const cursor = localId.x.toVar();
          Loop(() => {
            If(cursor.greaterThanEqual(particles.count), () => {
              Break();
            });
            const candidate = particles.index(cursor).toVar();
            const distance = this.snapshot!.storage.createParticle(candidate).position.sub(centroid).lengthSq().toVar();
            If(distance.lessThan(best).or(distance.equal(best).and(candidate.lessThan(seed))), () => {
              best.assign(distance);
              seed.assign(candidate);
            });
            cursor.addAssign(64);
          });
        });
      });
      sharedDistance.element(localId.x).assign(best);
      sharedIndex.element(localId.x).assign(seed);
      workgroupBarrier();

      for (let stride = 32; stride >= 1; stride /= 2) {
        If(localId.x.lessThan(stride), () => {
          const other = sharedDistance.element(localId.x.add(stride));
          const otherIndex = sharedIndex.element(localId.x.add(stride));
          If(
            other
              .lessThan(sharedDistance.element(localId.x))
              .or(
                other.equal(sharedDistance.element(localId.x)).and(otherIndex.lessThan(sharedIndex.element(localId.x))),
              ),
            () => {
              sharedDistance.element(localId.x).assign(other);
              sharedIndex.element(localId.x).assign(otherIndex);
            },
          );
        });
        workgroupBarrier();
      }

      If(localId.x.equal(0).and(group.lessThan(this.groupRange!.count)), () => {
        const selected = sharedIndex.element(uint(0)).toVar();
        const original = read(records, selected).toVar();
        write(seeds, group, original);
        write(owners, original, group);
        this.output!.storage.createParticle(group).position.assign(
          this.snapshot!.storage.createParticle(selected).position,
        );
        this.output!.storage.createStateNode(group).assign(input.storage.createStateNode(original));
      });
    })()
      .computeKernel([64])
      .setName('rzmps.grouping.anchors');
    anchors.dispatchSize = this.anchorDispatch! as unknown as number[];
    nodes.push(anchors);

    return nodes;
  }

  private buildAssignment(input: Input): ComputeNode[] {
    const output = this.output!;
    const { records, owners, links, heads, support, meta, at, read, write } = this.layout();

    // Link particles to their nearest anchor; selected anchor particles keep their own group.
    const assign = computeRange(this.particleRange!, index => {
      If(read(meta, 1).greaterThan(0), () => {
        const slot = read(records, index).toVar();
        const position = this.snapshot!.storage.createParticle(index).position;
        const group = read(owners, slot).toVar();
        If(group.equal(EMPTY), () => {
          group.assign(this.centers.nearestParticleIndexNode(position, float(this.radius)));
        });
        If(group.notEqual(EMPTY), () => {
          const previous = atomicFunc('atomicExchange' as Parameters<typeof atomicFunc>[0], at(heads, group), slot);
          write(links, slot, previous);
        });
      });
    }).setName('rzmps.grouping.assign');

    // Average visual channels while preserving total particle contribution.
    const reduce = computeRange(this.groupRange!, group => {
      const center = output.storage.createParticle(group).position.toVar();
      const s = uintBitsToFloat(read(support, group)) as unknown as Node<'float'>;
      const target = output.storage.createParticle(group);
      const weightSum = float(0).toVar();
      const contribution = float(0).toVar();
      const position = vec3(0).toVar();
      const rotation = vec3(0).toVar();
      const scale = vec3(0).toVar();
      const color = vec3(0).toVar();
      const velocity = vec3(0).toVar();
      const alpha = float(0).toVar();
      const distortion = float(0).toVar();
      const time = float(0).toVar();
      const realtime = float(0).toVar();
      const slot = read(heads, group).toVar();

      Loop(() => {
        If(slot.equal(EMPTY), () => {
          Break();
        });
        const source = input.storage.createParticle(slot);
        const d = this.toWorld.mul(vec4(source.position, 1)).xyz.sub(center).lengthSq();
        const w = float(1).div(float(1).add(d.div(s.max(1e-12))));
        weightSum.addAssign(w);
        contribution.addAssign(source.contribution);
        position.addAssign(source.position.mul(w));
        rotation.addAssign(source.rotation.mul(w));
        scale.addAssign(source.scale.mul(w));
        color.addAssign(source.color.mul(w));
        velocity.addAssign(source.velocity.mul(w));
        alpha.addAssign(source.alpha.mul(w));
        distortion.addAssign(source.distortionStrength.mul(w));
        time.addAssign(source.time.mul(w));
        realtime.addAssign(source.realtime.mul(w));
        slot.assign(read(links, slot));
      });

      target.position.assign(position.div(weightSum));
      target.rotation.assign(rotation.div(weightSum));
      target.scale.assign(scale.div(weightSum));
      target.color.assign(color.div(weightSum));
      target.velocity.assign(velocity.div(weightSum));
      target.alpha.assign(alpha.div(weightSum));
      target.distortionStrength.assign(distortion.div(weightSum));
      target.time.assign(time.div(weightSum));
      target.realtime.assign(realtime.div(weightSum));
      target.contribution.assign(contribution);
    }).setName('rzmps.grouping.aggregate');

    return [assign, reduce];
  }

  async readback(): Promise<Particle[]> {
    const output = this.output!;
    const renderer = this.renderer!;
    const { meta } = this.layout();
    const [floatBuffer, stateBuffer, metaBuffer] = await Promise.all([
      renderer.getArrayBufferAsync(output.attributes.floatData),
      renderer.getArrayBufferAsync(output.attributes.uintData),
      renderer.getArrayBufferAsync(this.scratch!, null, meta * 4, 8),
    ]);
    const data = new Float32Array(floatBuffer);
    const states = new Uint32Array(stateBuffer);
    const counts = new Uint32Array(metaBuffer);
    this.eligibleCount = counts[0];
    return Array.from({ length: Math.min(counts[1], output.count) }, (_, i) => {
      const p = new Particle();
      // Material-copy channels extend the layout beyond the original five vec4s.
      // A stale stride reads later lights' colors/alpha from unrelated fields.
      const o = i * RENDER_FLOAT_SLOT_COUNT * 4;
      p.position.fromArray(data, o);
      p.alpha = data[o + 3];
      p.rotation.fromArray(data, o + 4);
      p.distortionStrength = data[o + 7];
      p.scale.fromArray(data, o + 8);
      p.realtime = data[o + 11];
      p.color.fromArray(data, o + 12);
      p.time = data[o + 15];
      p.contribution = data[o + 16];
      p.velocity.fromArray(data, o + 17);
      p.id = `group:${i}:${states[i * 4 + 2]}`;
      return p;
    });
  }

  reset(): void {
    [...this.nodes, ...this.selection, ...this.reductions].forEach(node => node.dispose());
    this.nodes = [];
    this.selection = [];
    this.reductions = [];
    this.source.dispose(this.renderer);
    this.centers.dispose(this.renderer);
    this.output?.dispose(this.renderer);
    this.output = undefined;
    this.snapshot?.dispose(this.renderer);
    this.snapshot = undefined;

    if (this.scratch) destroyGPUStorageAttribute(this.renderer, this.scratch);
    for (const args of [this.particleDispatch, this.groupDispatch, this.anchorDispatch]) {
      if (args) destroyGPUStorageAttribute(this.renderer, args);
    }

    this.scratchNode = undefined;
    this.scratch = undefined;
    this.input = undefined;
    this.particleDispatch = undefined;
    this.groupDispatch = undefined;
    this.anchorDispatch = undefined;
    this.particleRange = undefined;
    this.groupRange = undefined;
    this.key = '';
    this.capacity = 0;
    this.maximum = 0;
    this.regionCapacity = 0;
  }
}
