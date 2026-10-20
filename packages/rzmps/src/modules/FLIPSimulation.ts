import * as THREE from 'three';
import { type ComputeNode } from 'three/webgpu';
import { Fn, If, float, instanceIndex, max, mix, uint, vec3, vec4 } from 'three/tsl';
import type { GPUParticleLike, GPUParticleUpdateContext } from '../gpu/Particle';
import ParticleSpatialGrid, { type ParticleSpatialGridRenderer } from '../gpu/ParticleSpatialGrid';
import Collision from './Collision';
import FluidSimulation, { type FluidSimulationOptions } from './FluidSimulation';

export interface FLIPSimulationOptions extends FluidSimulationOptions {
  picRatio: number;
  advectParticles: boolean;
  /** Seconds of current maximum particle velocity reserved around live particle bounds. */
  velocityPaddingLookahead: number;
}

class FLIPSimulation extends FluidSimulation {
  picRatio: number;
  advectParticlesEnabled: boolean;
  velocityPaddingLookahead: number;
  private gatherNode?: ComputeNode;
  private forceNodeCompute?: ComputeNode;
  private transferNode?: ComputeNode;
  private gatherCacheKey = '';

  constructor(options: Partial<FLIPSimulationOptions> = {}) {
    super({
      ...options,
      automaticPadding: options.automaticPadding ?? true,
    });
    this.picRatio = THREE.MathUtils.clamp(options.picRatio ?? 0.05, 0, 1);
    this.advectParticlesEnabled = options.advectParticles ?? false;
    this.velocityPaddingLookahead = Math.max(0, options.velocityPaddingLookahead ?? 0.5);
    this.usesParticleColliderSweeps = true;
    this.modifyGPU = () => {};
    this.dependents.push(new Collision({
      backend: this.particleCollisionBackend,
      bounce: 0,
      dampen: 0,
      radiusScale: 1,
    }));
  }

  public override computeGPU(
    context: GPUParticleUpdateContext,
    renderer: ParticleSpatialGridRenderer,
    grid?: ParticleSpatialGrid,
  ): void {
    if (!grid) throw new Error('FLIPSimulation requires a GPU spatial grid.');
    this.ensureGridResolution(renderer, grid);
    this.refreshBounds(grid, renderer);
    this.computeSolidField(context, renderer);
    const tagMask = context.system.getGPUFilterTagMask(this.tags);

    const cacheKey = [grid.resourceVersion, context.buffers.version, tagMask].join('|');
    if (cacheKey !== this.gatherCacheKey) {
      this.gatherCacheKey = cacheKey;
      this.gatherNode = undefined;
      this.transferNode = undefined;
    }

    const gather = this.gatherNode ?? Fn(() => {
      const coordinate = this.cellCoordinate(instanceIndex);
      const center = this.cellCenter(coordinate);
      const radius = this.cellSizeNode.mul(1.5);
      const momentum = vec3(0).toVar('flipMomentum');
      const totalMass = float(0).toVar('flipMass');
      grid.forEachParticleInRadius(center, radius, (particle, distanceSq) => {
        const weight = max(float(0), float(1).sub(distanceSq.sqrt().div(radius)));
        const mass = max(particle.mass, float(0)).mul(weight);
        momentum.addAssign(particle.velocity.mul(mass));
        totalMass.addAssign(mass);
      }, { tagMask });
      this.velocityCurrent.element(instanceIndex).assign(
        vec4(momentum.div(max(totalMass, float(1e-6))), totalMass.greaterThan(1e-6).select(1, 0)),
      );
    })().compute(this.cellCount);
    this.gatherNode = gather;
    renderer.compute(gather);

    const force = this.forceNodeCompute ?? Fn(() => {
      const velocity = vec3(this.velocityCurrent.element(instanceIndex).xyz);
      this.velocityNext.element(instanceIndex).assign(this.isSolid().select(
        vec4(0),
        vec4(
          this.clampVelocity(velocity.add(this.forceNode.mul(context.deltaTimeNode))),
          this.velocityCurrent.element(instanceIndex).w,
        ),
      ));
    })().compute(this.cellCount);
    this.forceNodeCompute = force;
    renderer.compute(force);
    this.solveProjection(renderer, this.velocityNext, this.velocityCurrent, true, this.solid);

    const transfer = this.transferNode ?? Fn(() => {
      const particle = context.buffers.storage.loadParticle();
      If(particle.alive.notEqual(uint(0)), () => this.gridToParticleGPU(particle));
      context.buffers.storage.storeParticle(particle);
    })().compute(context.buffers.count);
    this.transferNode = transfer;
    renderer.compute(transfer);
  }

  protected override onGridResolutionChanged(): void {
    this.gatherNode = undefined;
    this.forceNodeCompute = undefined;
    this.transferNode = undefined;
    this.gatherCacheKey = '';
  }

  private gridToParticleGPU(particle: GPUParticleLike): void {
    const picSample = this.sampleField(particle.position, this.velocityCurrent);
    const beforeSample = this.sampleField(particle.position, this.velocityNext);
    const picVelocity = vec3(picSample.xyz).div(max(picSample.w, float(1e-6)));
    const before = vec3(beforeSample.xyz).div(max(beforeSample.w, float(1e-6)));
    const flipVelocity = vec3(particle.velocity).add(picVelocity.sub(before));
    const velocity = this.clampVelocity(mix(flipVelocity, picVelocity, float(this.picRatio)));
    particle.velocity.assign(velocity);
  }

  protected override readAutomaticPadding(
    _renderer: ParticleSpatialGridRenderer,
    _grid: ParticleSpatialGrid,
    maximumSpeed: number,
  ): Promise<number> {
    return Promise.resolve(maximumSpeed * this.velocityPaddingLookahead);
  }
}

export default FLIPSimulation;
