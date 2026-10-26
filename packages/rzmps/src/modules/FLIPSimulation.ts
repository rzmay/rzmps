import * as THREE from 'three';
import { StorageBufferAttribute, type ComputeNode, type Node } from 'three/webgpu';
import { Fn, If, float, instanceIndex, max, min, mix, storage, uint, uniform, vec3, vec4 } from 'three/tsl';
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
  /** Normalized strength of the bounded particle overlap position correction. */
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
  private separationApplyNode?: ComputeNode;
  private separationAttribute?: StorageBufferAttribute;
  private separationPositions?: { element(index: Node | number): Node<'vec4'> };
  private velocityBeforeAttribute?: StorageBufferAttribute;
  private velocityBefore?: { element(index: Node | number): Node<'vec4'> };
  private gatherCacheKey = '';
  private readonly picRatioNode = uniform(0);

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
    this.gatherNode = undefined;
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
    this.picRatioNode.value = THREE.MathUtils.clamp(this.picRatio, 0, 1);
    this.ensureGridResolution(renderer, grid);
    this.refreshBounds(grid, renderer);
    this.computeSolidField(context, renderer);
    const tagMask = context.system.getGPUFilterTagMask(this.tags);
    if (!this.velocityBeforeAttribute) {
      this.velocityBeforeAttribute = new StorageBufferAttribute(new Float32Array(this.cellCount * 4), 4);
      this.velocityBefore = storage(this.velocityBeforeAttribute, 'vec4', this.cellCount);
    }

    const cacheKey = [grid.resourceVersion, context.buffers.version, tagMask].join('|');
    if (cacheKey !== this.gatherCacheKey) {
      this.gatherCacheKey = cacheKey;
      this.gatherNode = undefined;
      this.transferNode = undefined;
      this.separationNode = undefined;
      this.separationApplyNode = undefined;
    }

    const gather = this.gatherNode ?? Fn(() => {
      const coordinate = this.cellCoordinate(instanceIndex);
      const center = this.cellCenter(coordinate);
      const radius = this.cellSizeNode.mul(1.5);
      const momentum = vec3(0).toVar('flipMomentum');
      const momentumBefore = vec3(0).toVar('flipMomentumBefore');
      const totalMass = float(0).toVar('flipMass');
      const totalVolume = float(0).toVar('flipVolume');
      grid.forEachParticleInRadius(center, radius, (particle, distanceSq) => {
        const weight = max(float(0), float(1).sub(distanceSq.sqrt().div(radius)));
        const mass = max(particle.mass, float(0)).mul(weight);
        const gravityModifier = this.gpuParameters.number(
          'gravityModifier.flip', () => context.system.gravityModifier,
          particle.time, 0, particle.index,
        );
        const gravityStep = context.gravityNode.mul(context.deltaTimeNode.mul(gravityModifier));
        momentumBefore.addAssign(particle.velocity.mul(mass));
        momentum.addAssign(particle.velocity.add(gravityStep).mul(mass));
        totalMass.addAssign(mass);
        const spacing = max(
          particle.scale.x.abs(), max(particle.scale.y.abs(), particle.scale.z.abs()),
        ).mul(this.particleSpacing);
        totalVolume.addAssign(spacing.mul(spacing).mul(spacing).mul(weight)
          .mul(particle.mass.greaterThan(0).select(1, 0)));
      }, { tagMask });
      this.velocityCurrent.element(instanceIndex).assign(
        vec4(momentum.div(max(totalMass, float(1e-6))), totalMass.greaterThan(1e-6).select(1, 0)),
      );
      this.velocityBefore!.element(instanceIndex).assign(
        vec4(
          momentumBefore.div(max(totalMass, float(1e-6))),
          totalMass.greaterThan(1e-6).select(
            // Integral of the radial cone kernel: pi * radius^3 / 3.
            totalVolume.div(radius.mul(radius).mul(radius).mul(Math.PI / 3)).max(1e-6),
            0,
          ),
        ),
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
      const particle = context.buffers.storage.createParticle(undefined, true);
      If(particle.alive.notEqual(uint(0)), () => this.gridToParticleGPU(
        particle,
        context,
      ));
      context.buffers.storage.storeParticle(particle);
    })().compute(context.buffers.count);
    this.transferNode = transfer;
    renderer.compute(transfer);

    if (this.particleSeparation > 0 && this.particleSpacing > 0) {
      if (this.separationAttribute?.count !== context.buffers.capacity) {
        this.separationAttribute?.dispose();
        this.separationAttribute = new StorageBufferAttribute(
          new Float32Array(context.buffers.capacity * 4), 4,
        );
        this.separationPositions = storage(
          this.separationAttribute, 'vec4', context.buffers.capacity,
        );
        this.separationNode = undefined;
        this.separationApplyNode = undefined;
      }
      const separation = this.separationNode ?? Fn(() => {
        const particle = context.buffers.storage.createParticle(undefined, true);
        const separatedPosition = particle.position.toVar('flipSeparatedPosition');
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
            const displacement = vec3(correction
              .div(neighborCount)
              .mul(this.particleSeparation));
            const distance = displacement.length().max(1e-5);
            const maxDisplacement = diameter.mul(0.1);
            displacement.mulAssign(min(float(1), maxDisplacement.div(distance)));
            separatedPosition.assign(particle.position.add(displacement));
          });
        });
        this.separationPositions!.element(instanceIndex).assign(vec4(separatedPosition, 0));
      })().compute(context.buffers.count);
      this.separationNode = separation;
      renderer.compute(separation);
      // Commit after every neighbor query has finished reading the original positions.
      const apply = this.separationApplyNode ?? Fn(() => {
        const particle = context.buffers.storage.createParticle(undefined, true);
        If(particle.alive.notEqual(uint(0)), () => {
          const targetPosition = this.separationPositions!.element(instanceIndex).xyz;
          if (this.hasParticleColliderGeometry) {
            const radius = max(
              particle.scale.x.abs(),
              max(particle.scale.y.abs(), particle.scale.z.abs()),
            ).mul(0.5).add(this.particleCollisionThickness);
            const hit = this.queryParticleCollider(
              transformPointGPU(particle.position, context.simulationToWorldNode),
              transformPointGPU(targetPosition, context.simulationToWorldNode),
              radius,
            );
            If(hit.get('found') as Node<'bool'>, () => {
              const normal = (hit.get('normal') as Node<'vec3'>).normalize();
              const distance = (hit.get('distanceSq') as Node<'float'>).sqrt();
              const position = (hit.get('capsulePoint') as Node<'vec3'>).add(
                normal.mul(radius.sub(distance).max(0)),
              );
              particle.position.assign(transformPointGPU(position, context.worldToSimulationNode));
            }).Else(() => {
              particle.position.assign(targetPosition);
            });
          } else {
            particle.position.assign(targetPosition);
          }
          context.buffers.storage.storeParticle(particle);
        });
      })().compute(context.buffers.count);
      this.separationApplyNode = apply;
      renderer.compute(apply);
    }
  }

  protected override onGridResolutionChanged(): void {
    this.velocityBeforeAttribute?.dispose();
    this.velocityBeforeAttribute = undefined;
    this.velocityBefore = undefined;
    this.gatherNode = undefined;
    this.forceNodeCompute = undefined;
    this.transferNode = undefined;
    this.separationNode = undefined;
    this.separationApplyNode = undefined;
    this.gatherCacheKey = '';
  }

  protected override onParticleColliderGeometryChanged(): void {
    this.separationApplyNode = undefined;
    this.boundaryCollisions.forEach((collision) => {
      collision.radiusOffset = this.particleCollisionThicknessValue;
    });
  }

  protected override targetDivergence(index: Node<'uint'>): Node<'float'> {
    // Relax excess marker density without creating a tensile force at free surfaces.
    return this.velocityBefore!.element(index).w.sub(1).clamp(0, 1).mul(3);
  }

  public override cleanup(): void {
    this.separationAttribute?.dispose();
    this.separationAttribute = undefined;
    this.separationPositions = undefined;
    this.onGridResolutionChanged();
    super.cleanup();
  }

  private gridToParticleGPU(particle: GPUParticleLike, context: GPUParticleUpdateContext): void {
    const picSample = this.sampleField(particle.position, this.velocityCurrent);
    const beforeSample = this.sampleField(particle.position, this.velocityBefore!, true);
    const inside = particle.position.greaterThanEqual(this.boundsMinNode).all()
      .and(particle.position.lessThan(this.boundsMinNode.add(this.cellSizeNode.mul(this.resolution))).all())
      .and(beforeSample.w.greaterThan(1e-6));
    const picVelocity = vec3(picSample.xyz).div(max(picSample.w, float(1e-6)));
    const before = vec3(beforeSample.xyz).div(max(beforeSample.w, float(1e-6)));
    const flipVelocity = vec3(particle.velocity).add(picVelocity.sub(before));
    const velocity = this.clampVelocity(mix(flipVelocity, picVelocity, this.picRatioNode));
    const gravityModifier = this.gpuParameters.number(
      'gravityModifier.flip', () => context.system.gravityModifier,
      particle.time, 0, particle.index,
    );
    const gravityStep = context.gravityNode.mul(context.deltaTimeNode.mul(gravityModifier));
    // The system integrator adds gravity immediately before moving particles.
    If(inside, () => {
      particle.velocity.assign(velocity.sub(gravityStep));
      if (this.advectParticlesEnabled) particle.position.addAssign(velocity.mul(context.deltaTimeNode));
    });
  }

  protected override readAutomaticPadding(
    _renderer: ParticleSpatialGridRenderer,
    _grid: ParticleSpatialGrid,
    maximumSpeed: number,
  ): Promise<number> {
    return Promise.resolve(maximumSpeed * this.velocityPaddingLookahead);
  }
}

function transformPointGPU(point: Node<'vec3'>, matrix: Node<'mat4'>): Node<'vec3'> {
  return matrix.mul(vec4(point, 1)).xyz as Node<'vec3'>;
}

export default FLIPSimulation;
