import * as THREE from 'three';
import { type ComputeNode, type Node } from 'three/webgpu';
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
  /** Swept boundary passes per frame. Additional passes resolve simultaneous contacts. */
  collisionIterations: number;
  /** Normalized strength of the particle overlap restoring force. */
  particleSeparation: number;
  /** Rest-distance multiplier applied to particle scale. */
  particleSpacing: number;
}

class FLIPSimulation extends FluidSimulation {
  picRatio: number;
  advectParticlesEnabled: boolean;
  velocityPaddingLookahead: number;
  private _particleSeparation = 0;
  private _particleSpacing = 0;
  private _collisionIterations = 0;
  private boundaryCollisions: Collision[] = [];
  private gatherNode?: ComputeNode;
  private forceNodeCompute?: ComputeNode;
  private transferNode?: ComputeNode;
  private separationNode?: ComputeNode;
  private gatherCacheKey = '';

  constructor(options: Partial<FLIPSimulationOptions> = {}) {
    super({
      ...options,
      automaticPadding: options.automaticPadding ?? true,
    });
    this.picRatio = THREE.MathUtils.clamp(options.picRatio ?? 0.05, 0, 1);
    this.advectParticlesEnabled = options.advectParticles ?? false;
    this.velocityPaddingLookahead = Math.max(0, options.velocityPaddingLookahead ?? 0.5);
    this.particleSeparation = THREE.MathUtils.clamp(options.particleSeparation ?? 0.05, 0, 1);
    this.particleSpacing = Math.max(0, options.particleSpacing ?? 1);
    this.usesParticleColliderSweeps = true;
    this.modifyGPU = () => {};
    this.collisionIterations = options.collisionIterations ?? 2;
  }

  get particleSeparation(): number {
    return this._particleSeparation;
  }

  set particleSeparation(value: number) {
    const next = THREE.MathUtils.clamp(Number.isFinite(value) ? value : 0, 0, 1);
    if (next === this._particleSeparation) return;
    this._particleSeparation = next;
    this.separationNode = undefined;
    this.needsUpdate = true;
  }

  get particleSpacing(): number {
    return this._particleSpacing;
  }

  set particleSpacing(value: number) {
    const next = Number.isFinite(value) ? Math.max(0, value) : 0;
    if (next === this._particleSpacing) return;
    this._particleSpacing = next;
    this.separationNode = undefined;
    this.needsUpdate = true;
  }

  get collisionIterations(): number {
    return this._collisionIterations;
  }

  set collisionIterations(value: number) {
    const next = Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
    if (next === this._collisionIterations) return;
    this.dependents = this.dependents.filter((module) => (
      !this.boundaryCollisions.includes(module as Collision)
    ));
    this.boundaryCollisions = Array.from({ length: next }, () => (
      new Collision({
        backend: this.particleCollisionBackend,
        bounce: 0,
        dampen: 0,
        radiusScale: 1,
        radiusOffset: this.particleCollisionThicknessValue,
      })
    ));
    this.dependents.push(...this.boundaryCollisions);
    this._collisionIterations = next;
    this.needsUpdate = true;
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
      this.separationNode = undefined;
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
      If(particle.alive.notEqual(uint(0)), () => this.gridToParticleGPU(
        particle,
        context.deltaTimeNode,
      ));
      context.buffers.storage.storeParticle(particle);
    })().compute(context.buffers.count);
    this.transferNode = transfer;
    renderer.compute(transfer);

    if (this.particleSeparation > 0 && this.particleSpacing > 0) {
      const separation = this.separationNode ?? Fn(() => {
        const particle = context.buffers.storage.loadParticle();
        If(particle.alive.notEqual(uint(0)), () => {
          const diameter = max(
            particle.scale.x.abs(),
            max(particle.scale.y.abs(), particle.scale.z.abs()),
          );
          const restDistance = diameter.mul(this.particleSpacing).max(1e-5);
          const correction = vec3(0).toVar('flipParticleSeparation');
          const neighborCount = float(0).toVar('flipParticleSeparationCount');
          grid.forEachParticleInRadius(
            particle.position,
            restDistance,
            (neighbor, distanceSquared) => {
              const offset = vec3(particle.position.sub(neighbor.position));
              const distance = distanceSquared.sqrt().max(1e-5);
              const overlap = restDistance.sub(distance).max(0);
              correction.addAssign(offset.div(distance).mul(overlap));
              neighborCount.addAssign(1);
            },
            { excludeIndex: particle.index, tagMask },
          );
          If(neighborCount.greaterThan(0), () => {
            const separationAcceleration = correction
              .div(neighborCount)
              // A normalized public strength maps to a stiff but explicit-Euler-stable
              // contact force at interactive frame rates. This supports a liquid column
              // after the emitter stops instead of letting particles share one position.
              .mul(this.particleSeparation * 500);
            particle.velocity.addAssign(separationAcceleration.mul(context.deltaTimeNode));
            particle.velocity.assign(this.clampVelocity(particle.velocity));
          });
        });
        context.buffers.storage.storeParticle(particle);
      })().compute(context.buffers.count);
      this.separationNode = separation;
      renderer.compute(separation);
    }
  }

  protected override onGridResolutionChanged(): void {
    this.gatherNode = undefined;
    this.forceNodeCompute = undefined;
    this.transferNode = undefined;
    this.separationNode = undefined;
    this.gatherCacheKey = '';
  }

  protected override onParticleColliderGeometryChanged(): void {
    this.boundaryCollisions.forEach((collision) => {
      collision.radiusOffset = this.particleCollisionThicknessValue;
    });
  }

  private gridToParticleGPU(particle: GPUParticleLike, dt: Node<'float'>): void {
    const picSample = this.sampleField(particle.position, this.velocityCurrent);
    const beforeSample = this.sampleField(particle.position, this.velocityNext);
    const picVelocity = vec3(picSample.xyz).div(max(picSample.w, float(1e-6)));
    const before = vec3(beforeSample.xyz).div(max(beforeSample.w, float(1e-6)));
    const flipVelocity = vec3(particle.velocity).add(picVelocity.sub(before));
    const velocity = this.clampVelocity(mix(flipVelocity, picVelocity, float(this.picRatio)));
    particle.velocity.assign(velocity);
    if (this.advectParticlesEnabled) particle.position.addAssign(velocity.mul(dt));
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
