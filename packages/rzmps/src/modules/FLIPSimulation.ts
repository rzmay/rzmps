import * as THREE from 'three';
import { type ComputeNode, type Node } from 'three/webgpu';
import { Fn, float, instanceIndex, max, mix, vec3, vec4 } from 'three/tsl';
import type { GPUParticleLike, GPUParticleUpdateContext } from '../gpu/Particle';
import ParticleSpatialGrid, { type ParticleSpatialGridRenderer } from '../gpu/ParticleSpatialGrid';
import FluidSimulation, { type FluidSimulationOptions } from './FluidSimulation';

export interface FLIPSimulationOptions extends FluidSimulationOptions {
  picRatio: number;
  advectParticles: boolean;
}

class FLIPSimulation extends FluidSimulation {
  picRatio: number;
  advectParticlesEnabled: boolean;
  private gatherNode?: ComputeNode;
  private forceNodeCompute?: ComputeNode;
  private gatherCacheKey = '';

  constructor(options: Partial<FLIPSimulationOptions> = {}) {
    super(options);
    this.picRatio = THREE.MathUtils.clamp(options.picRatio ?? 0.05, 0, 1);
    this.advectParticlesEnabled = options.advectParticles ?? false;
    this.modifyGPU = (particle, dt) => this.gridToParticleGPU(particle, dt);
  }

  public override computeGPU(
    context: GPUParticleUpdateContext,
    renderer: ParticleSpatialGridRenderer,
    grid?: ParticleSpatialGrid,
  ): void {
    if (!grid) throw new Error('FLIPSimulation requires a GPU spatial grid.');
    this.refreshBounds(grid, renderer);
    const tagMask = context.system.getGPUFilterTagMask(this.tags);

    const cacheKey = [grid.resourceVersion, context.buffers.version, tagMask].join('|');
    if (cacheKey !== this.gatherCacheKey) {
      this.gatherCacheKey = cacheKey;
      this.gatherNode = undefined;
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
        vec4(momentum.div(max(totalMass, float(1e-6))), 0),
      );
    })().compute(this.cellCount);
    this.gatherNode = gather;
    renderer.compute(gather);

    const force = this.forceNodeCompute ?? Fn(() => {
      const velocity = vec3(this.velocityCurrent.element(instanceIndex).xyz);
      this.velocityNext.element(instanceIndex).assign(vec4(
        this.clampVelocity(velocity.add(this.forceNode.mul(context.deltaTimeNode))),
        0,
      ));
    })().compute(this.cellCount);
    this.forceNodeCompute = force;
    renderer.compute(force);
    this.solveProjection(renderer, this.velocityNext, this.velocityCurrent);
  }

  private gridToParticleGPU(particle: GPUParticleLike, dt: Node<'float'>): void {
    const picVelocity = this.sampleVelocity(particle.position);
    const before = this.sampleVelocity(particle.position, this.velocityNext);
    const flipVelocity = vec3(particle.velocity).add(picVelocity.sub(before));
    particle.velocity.assign(mix(flipVelocity, picVelocity, float(this.picRatio)));
    if (this.advectParticlesEnabled) particle.position.addAssign(particle.velocity.mul(dt));
  }
}

export default FLIPSimulation;
