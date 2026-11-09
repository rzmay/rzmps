import * as THREE from 'three';
import { Fn, If, float, instanceIndex, storage, uint } from 'three/tsl';
import { StorageBufferAttribute, type ComputeNode, type WebGPURenderer } from 'three/webgpu';
import type Module from '../../core/Module';
import type Particle from '../../core/Particle';
import { resolveSpatialLevels } from '../../enums/resolveSpatialLevels';
import type { PackedFloatStorage } from '../../utils/gpu/storage.utils';
import { destroyGPUStorageAttribute, type GPUParticleBufferState } from '../../simulation/gpu/Particle';
import ParticleOctree from './ParticleOctree';
import ParticleSpatialGrid, { type ParticleSpatialGridOptions } from './ParticleSpatialGrid';

/** Owns system spatial structures and their population/GPU cache lifetimes. */
export default class SpatialRuntime {
  octree?: ParticleOctree<unknown>;
  readonly _particleSpatialGrids = new Map<string, ParticleSpatialGrid>();

  _particleSpacing = new Map<string, number>();

  _particleOctreeToken?: object;

  _gpuParticleSpacing?: {
    buffers: GPUParticleBufferState; version: number;
    attribute: StorageBufferAttribute; storage: PackedFloatStorage; node: ComputeNode; token?: object;
  };

  readonly _explicitParticleSpatialGrids = new Set<ParticleSpatialGrid>();

  _gpuSpatialBuildSequence = 0;

  acquireParticleSpatialGrid(
    gridOrOptions: ParticleSpatialGrid | Partial<ParticleSpatialGridOptions> = {},
  ): ParticleSpatialGrid {
    if (gridOrOptions instanceof ParticleSpatialGrid) {
      this._explicitParticleSpatialGrids.add(gridOrOptions);
      return gridOrOptions;
    }

    const bounds = gridOrOptions.bounds;
    const key = JSON.stringify({
      bounds: bounds ? [bounds.min.toArray(), bounds.max.toArray()] : undefined,
      brickSubdivisions: gridOrOptions.brickSubdivisions ?? 3,
      cellSubdivisions: gridOrOptions.cellSubdivisions ?? 4,
      levels: gridOrOptions.levels === undefined || gridOrOptions.levels === 'none' || gridOrOptions.levels === 'None'
        ? undefined : resolveSpatialLevels(gridOrOptions.levels, gridOrOptions.brickSubdivisions ?? 3,
          gridOrOptions.cellSubdivisions ?? 4),
      powerOfTwoBounds: gridOrOptions.powerOfTwoBounds ?? true,
      autoExpand: gridOrOptions.autoExpand ?? true,
      expansionHysteresis: gridOrOptions.expansionHysteresis ?? 0.125,
      timeQuality: gridOrOptions.timeQuality ?? 1,
      maxQuerySteps: gridOrOptions.maxQuerySteps ?? 0,
    });
    let grid = this._particleSpatialGrids.get(key);
    if (!grid) {
      grid = new ParticleSpatialGrid(gridOrOptions);
      this._particleSpatialGrids.set(key, grid);
    }
    return grid;
  }

  getParticleSpacing(particle: Particle, population: Particle[], token: object, modules: Module[]): number {
    const cached = this._particleSpacing.get(particle.id);
    if (cached !== undefined) return cached;
    if (this._particleOctreeToken !== token) {
      // Reuse an unfiltered module tree when available. Filtered trees cannot
      // represent the whole system's population.
      const spatialModule = modules.find(module => !module.tags?.length && module.getParticleOctree());
      const existing = spatialModule?.getParticleOctree();
      this.octree = existing ?? this.octree ?? new ParticleOctree<number>(
        { maxDepth: 3, particlesPerLeaf: 16 },
        { new: p => p ? 1 : 0, combine: (a, b) => a + b },
      );
      if (!existing) {
        const bounds = new THREE.Box3();
        for (const p of population) if (p.alive) bounds.expandByPoint(p.position);
        if (bounds.isEmpty()) bounds.set(particle.position, particle.position);
        this.octree.setBounds(bounds).rebuild(population);
      }
      const liveIds = new Set(population.filter(p => p.alive).map(p => p.id));
      for (const id of this._particleSpacing.keys()) if (!liveIds.has(id)) this._particleSpacing.delete(id);
      this._particleOctreeToken = token;
    }
    const spacing = this.octree!.estimateSpacing(particle);
    this._particleSpacing.set(particle.id, spacing);
    return spacing;
  }

  getParticleSpacingGPU(buffers: GPUParticleBufferState, renderer: WebGPURenderer, token: object): PackedFloatStorage {
    let state = this._gpuParticleSpacing;
    if (!state || state.buffers !== buffers || state.version !== buffers.version) {
      if (state) {
        state.node.dispose();
        destroyGPUStorageAttribute(renderer, state.attribute);
      }
      const grid = this.acquireParticleSpatialGrid({ brickSubdivisions: 2, cellSubdivisions: 0, maxQuerySteps: 64 });
      grid.rebuild(renderer, buffers, token);
      const attribute = new StorageBufferAttribute(new Float32Array(buffers.capacity * 4), 4);
      const spacing = storage(attribute, 'vec4', buffers.capacity) as PackedFloatStorage;
      const node = Fn(() => {
        const particle = buffers.storage.createParticle();
        const value = spacing.element(instanceIndex);
        If(particle.alive.notEqual(uint(0)).and(value.y.notEqual(float(particle.generation))), () => {
          const fallback = particle.scale.length().mul(0.5).max(0.001);
          value.x.assign(grid.estimateLocalSpacingNode(particle.position, instanceIndex, fallback));
          value.y.assign(float(particle.generation));
        });
      })().compute(buffers.capacity).setName('rzmps.spacing');
      state = { buffers, version: buffers.version, attribute, storage: spacing, node };
      this._gpuParticleSpacing = state;
    }
    if (state.token !== token) {
      const grid = this.acquireParticleSpatialGrid({ brickSubdivisions: 2, cellSubdivisions: 0, maxQuerySteps: 64 });
      grid.rebuild(renderer, buffers, token);
      renderer.compute(state.node);
      state.token = token;
    }
    return state.storage;
  }

  /** Clears population-dependent views without releasing reusable/caller-owned grids. */
  clear(renderer?: WebGPURenderer): void {
    this._particleSpacing.clear(); this.octree = undefined; this._particleOctreeToken = undefined;
    if (this._gpuParticleSpacing) {
      this._gpuParticleSpacing.node.dispose();
      destroyGPUStorageAttribute(renderer, this._gpuParticleSpacing.attribute);
      this._gpuParticleSpacing = undefined;
    }
  }
  dispose(renderer?: WebGPURenderer): void {
    this.clear(renderer);
    this._particleSpatialGrids.forEach(grid => grid.dispose(renderer));
    this._particleSpatialGrids.clear();
    this._explicitParticleSpatialGrids.clear();
  }
}
