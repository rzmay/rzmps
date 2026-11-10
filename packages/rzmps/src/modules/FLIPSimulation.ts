import * as THREE from 'three';
import { StorageBufferAttribute, type ComputeNode, type Node } from 'three/webgpu';
import {
  Fn, If, clamp, float, floor, instanceIndex, ivec3, max, min, mix, storage, uint, uniform, vec3, vec4,
} from 'three/tsl';
import type { GPUParticleBufferState, GPUParticleLike, GPUParticleUpdateContext } from '../simulation/gpu/Particle';
import ParticleSpatialGrid, { type ParticleSpatialGridRenderer } from '../spatial/structures/ParticleSpatialGrid';
import Collision from './Collision';
import FluidPressureProjection from '../simulation/gpu/FluidPressureProjection';
import SparseVolumeGrid from '../spatial/structures/gpu/SparseVolumeGrid';
import FluidSimulation, { type FluidSimulationOptions } from './FluidSimulation';
import type { SubSystemGPUCondition } from '../core/ParticleSystem';

/** Lightweight spray-source gates; child emission rate, ratio and lifetime stay on the subsystem. */
export interface FLIPSprayConditionOptions {
  /** Minimum particle speed in simulation units/second, including its speed multiplier. Defaults to 1. */
  minimumSpeed?: number;
  /** Minimum source age in seconds, preventing immediate emission from newborn liquid. Defaults to 0.05. */
  minimumAge?: number;
  /** Maximum other live particles in the search sphere. Defaults to 8; null disables isolation filtering. */
  maximumNeighbors?: number | null;
  /** Search radius as a multiple of largest absolute particle scale. Defaults to 2. */
  neighborRadius?: number;
}

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
  /** Selects fast, sparsely surrounded source particles without sampling an Eulerian fluid field.
   * Inspired by energy/air-entrainment source controls, not a complete whitewater model.
   * Neighborhoods use current parent positions, even when testing a captured event.
   * No FLIP module is required; this predicate also works on other GPU particle sources. */
  static SprayCondition(options: FLIPSprayConditionOptions = {}): SubSystemGPUCondition {
    const minimumSpeed = options.minimumSpeed ?? 1;
    const minimumAge = options.minimumAge ?? 0.05;
    const maximumNeighbors = options.maximumNeighbors === undefined ? 8 : options.maximumNeighbors;
    const neighborRadius = options.neighborRadius ?? 2;
    if (!Number.isFinite(minimumSpeed) || minimumSpeed < 0
      || !Number.isFinite(minimumAge) || minimumAge < 0
      || !Number.isFinite(neighborRadius) || neighborRadius <= 0
      || (maximumNeighbors !== null && (!Number.isInteger(maximumNeighbors) || maximumNeighbors < 0))) {
      throw new RangeError('SprayCondition requires nonnegative speed/age/count and a finite positive radius.');
    }
    const condition: SubSystemGPUCondition = (particle, _dt, context) => {
      const eligible = particle.velocity.length().mul(particle.speed.abs()).greaterThanEqual(minimumSpeed)
        .and(particle.realtime.greaterThanEqual(minimumAge * 1000)).toVar();
      if (maximumNeighbors !== null) {
        const grid = context.spatialGrid;
        if (!grid) throw new Error('SprayCondition isolation requires its managed parent spatial grid.');
        If(eligible, () => {
          const radius = max(particle.scale.x.abs(), max(particle.scale.y.abs(), particle.scale.z.abs()))
            .mul(neighborRadius).max(1e-5);
          const neighbors = uint(0).toVar();
          grid.forEachParticleInRadius(particle.position, radius, neighbor => {
            // Event slots may have been reused: exclude only the source identity.
            If(neighbor.index.notEqual(particle.index).or(neighbor.generation.notEqual(particle.generation)), () => {
              neighbors.addAssign(1);
            });
          });
          eligible.assign(neighbors.lessThanEqual(maximumNeighbors));
        });
      }
      return eligible;
    };
    if (maximumNeighbors !== null) condition.spatialGridOptions = {
      brickSubdivisions: 3, cellSubdivisions: 1, maxQuerySteps: 0, timeQuality: 1,
    };
    return condition;
  }

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
  private gatherBuffers?: GPUParticleBufferState;
  private gatherGrid?: ParticleSpatialGrid;
  private pressureProjection?: FluidPressureProjection;
  private readonly picRatioNode = uniform(0);
  private workGrid?: SparseVolumeGrid;
  private clearFieldsNode?: ComputeNode;
  private resetFields = true;
  private movingWallsNode?: ComputeNode;
  private movingWallsKey = '';

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
    super.computeGPU(context, renderer, grid);
    this.picRatioNode.value = THREE.MathUtils.clamp(this.picRatio, 0, 1);
    this.ensureGridResolution(renderer, grid);
    this.refreshBounds(grid, renderer);
    this.computeMovingWalls(context, renderer, grid);
    if (!this.workGrid || this.workGrid.brickSubdivisions !== grid.brickSubdivisions
      || this.workGrid.cellSubdivisions !== grid.cellSubdivisions) {
      this.onGridResolutionChanged();
      this.workGrid = new SparseVolumeGrid({
        brickSubdivisions: grid.brickSubdivisions, cellSubdivisions: grid.cellSubdivisions,
      }, (2 ** grid.brickSubdivisions) ** 3);
      this.workGrid.updateDispatch(renderer);
    }
    const tagMask = context.system.getGPUFilterTagMask(this.tags);
    if (!this.velocityBeforeAttribute) {
      this.velocityCurrentAttribute.dispose();
      this.velocityCurrentAttribute = new StorageBufferAttribute(new Float32Array(this.cellCount * 8), 4);
      const packed = storage(this.velocityCurrentAttribute, 'vec4', this.cellCount * 2);
      this.velocityCurrent = packed;
      this.velocityBeforeAttribute = this.velocityCurrentAttribute;
      this.velocityBefore = { element: index => packed.element(
        typeof index === 'number' ? index + this.cellCount : uint(index as Node<'uint'>).add(this.cellCount),
      ) };
    }
    const clearFields = (index: Node<'uint'>) => {
      this.velocityCurrent.element(index).assign(vec4(0));
      this.velocityNext.element(index).assign(vec4(0));
      this.velocityBefore!.element(index).assign(vec4(0));
      this.pressureCurrent.element(index).assign(0);
      this.divergence.element(index).assign(0);
    };
    if (this.resetFields) {
      renderer.compute(Fn(() => clearFields(instanceIndex))().compute(this.cellCount));
      this.resetFields = false;
    }
    this.clearFieldsNode ??= this.computeCells(clearFields);
    // Clear old addresses before page reassignment, including retired bricks.
    renderer.compute(this.clearFieldsNode);
    this.pressureProjection?.clearPreviousFaces(renderer);
    this.workGrid.bounds.copy(this.bounds);
    this.workGrid.rebuild(context, renderer, undefined, undefined,
      this.boundsMinNode, this.cellSizeNode, float(0), tagMask);
    this.computeSolidField(context, renderer);

    const cacheKey = [grid.resourceVersion, context.buffers.version, tagMask].join('|');
    if (cacheKey !== this.gatherCacheKey || this.gatherBuffers !== context.buffers || this.gatherGrid !== grid) {
      this.gatherCacheKey = cacheKey;
      this.gatherBuffers = context.buffers;
      this.gatherGrid = grid;
      this.gatherNode = undefined;
      this.transferNode = undefined;
      this.separationNode = undefined;
      this.separationApplyNode = undefined;
    }

    const gather = this.gatherNode ?? this.computeCells(index => {
      const coordinate = this.cellCoordinate(index);
      const center = this.cellCenter(coordinate);
      const radius = this.cellSizeNode.mul(1.5);
      const momentum = vec3(0).toVar('flipMomentum');
      const momentumBefore = vec3(0).toVar('flipMomentumBefore');
      const totalMass = float(0).toVar('flipMass');
      const totalVolume = float(0).toVar('flipVolume');
      const fluidCell = float(0).toVar('flipFluidCell');
      grid.forEachParticleInRadius(center, radius, (particle, distanceSq) => {
        const halfCell = this.cellSizeNode.mul(0.5);
        const containsMarker = particle.position.greaterThanEqual(center.sub(halfCell)).all()
          .and(particle.position.lessThan(center.add(halfCell)).all());
        fluidCell.assign(max(fluidCell, containsMarker.select(1, 0)));
        const weight = max(float(0), float(1).sub(distanceSq.sqrt().div(radius)));
        const mass = max(particle.mass, float(0)).mul(weight);
        const gravityModifier = this.evaluateDynamicGPU.number(
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
      // Marker centers undersample fine grids: reconstructed bulk support must
      // not become zero-pressure air just because this cell has no marker center.
      const volumeFraction = totalVolume.div(radius.mul(radius).mul(radius).mul(Math.PI / 3));
      const liquid = fluidCell.greaterThan(0).or(volumeFraction.greaterThanEqual(0.5));
      this.velocityCurrent.element(index).assign(
        // Packed occupancy: 2 contains a marker, 1 is velocity support, 0 is empty.
        vec4(momentum.div(max(totalMass, float(1e-6))),
          totalMass.greaterThan(1e-6).select(liquid.select(2, 1), 0)),
      );
      this.velocityBefore!.element(index).assign(
        vec4(
          momentumBefore.div(max(totalMass, float(1e-6))),
          totalMass.greaterThan(1e-6).select(
            // Integral of the radial cone kernel: pi * radius^3 / 3.
            volumeFraction.max(1e-6),
            0,
          ),
        ),
      );
    });
    this.gatherNode = gather;
    renderer.compute(gather);

    const force = this.forceNodeCompute ?? this.computeCells(index => {
      const velocity = vec3(this.velocityCurrent.element(index).xyz);
      // Mask after gather to stay within its eight-storage-buffer budget.
      // Both transfer fields must exclude the same solid donors.
      If(this.isSolid(index), () => {
        this.velocityBefore!.element(index).assign(vec4(0));
      });
      this.velocityNext.element(index).assign(this.isSolid(index).select(
        vec4(0),
        vec4(
          this.clampVelocity(velocity.add(this.forceNode.mul(context.deltaTimeNode))),
          this.velocityCurrent.element(index).w,
        ),
      ));
    });
    this.forceNodeCompute = force;
    renderer.compute(force);
    this.solveProjection(renderer, this.velocityNext, this.velocityCurrent);

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
        If(particle.alive.notEqual(uint(0)).and(this.isInsideCap(particle.position)), () => {
          const diameter = max(
            particle.scale.x.abs(),
            max(particle.scale.y.abs(), particle.scale.z.abs()),
          );
          const searchRadius = max(diameter, grid.getMaxParticleRadiusNode().mul(2))
            .mul(this.particleSpacing).max(1e-5);
          const correction = vec3(0).toVar('flipParticleSeparation');
          grid.forEachParticleInRadius(
            particle.position,
            searchRadius,
            (neighbor, distanceSquared) => {
              const offset = vec3(particle.position.sub(neighbor.position));
              const neighborDiameter = max(neighbor.scale.x.abs(),
                max(neighbor.scale.y.abs(), neighbor.scale.z.abs()));
              const pairDistance = diameter.add(neighborDiameter).mul(0.5 * this.particleSpacing);
              const distance = distanceSquared.sqrt();
              const overlap = pairDistance.sub(distance).max(0);
              // Coincident pairs need a stable antisymmetric direction, not a
              // zero vector. Both particles see the same hash and opposite signs.
              const ordered = particle.index.lessThan(neighbor.index);
              const low = ordered.select(particle.index, neighbor.index);
              const high = ordered.select(neighbor.index, particle.index);
              const hash = uint(low.mul(73856093)).bitXor(uint(high.mul(19349663)));
              const fallback = vec3(hash.bitAnd(1023), hash.shiftRight(10).bitAnd(1023),
                hash.shiftRight(20).bitAnd(1023)).div(511.5).sub(1).normalize()
                .mul(particle.index.lessThan(neighbor.index).select(1, -1));
              const direction = distance.greaterThan(1e-5).select(offset.div(distance.max(1e-5)), fallback);
              correction.addAssign(direction.mul(overlap).mul(0.5));
            },
            { excludeIndex: particle.index, tagMask },
          );
          If(correction.lengthSq().greaterThan(0), () => {
            const displacement = vec3(correction
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
              const contact = hit.get('capsulePoint') as Node<'vec3'>;
              const remaining = transformPointGPU(targetPosition, context.simulationToWorldNode).sub(contact);
              // A contact at the start of a sweep must not discard tangential
              // separation: markers resting on a wall still need room to spread.
              const tangent = remaining.sub(normal.mul(min(remaining.dot(normal), float(0))));
              const position = contact.add(normal.mul(radius.sub(distance).max(0))).add(tangent);
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
      // Grid advection may have moved markers since the system built the hash.
      if (this.advectParticlesEnabled) grid.rebuild(renderer, context.buffers, {});
      renderer.compute(separation);
      renderer.compute(apply);
    }
  }

  protected override onGridResolutionChanged(): void {
    this.movingWallsNode = undefined;
    this.movingWallsKey = '';
    this.workGrid?.dispose();
    this.workGrid = undefined;
    this.clearFieldsNode = undefined;
    this.resetFields = true;
    this.pressureProjection?.dispose();
    this.pressureProjection = undefined;
    this.velocityBeforeAttribute = undefined;
    this.velocityBefore = undefined;
    this.gatherNode = undefined;
    this.forceNodeCompute = undefined;
    this.transferNode = undefined;
    this.separationNode = undefined;
    this.separationApplyNode = undefined;
    this.gatherCacheKey = '';
    this.gatherBuffers = undefined;
    this.gatherGrid = undefined;
  }

  protected override computeCells(callback: (index: Node<'uint'>) => void): ComputeNode {
    return this.workGrid ? this.workGrid.computeDense(callback) : super.computeCells(callback);
  }

  protected override computeSolidCells(callback: (index: Node<'uint'>) => void): ComputeNode {
    return Fn(() => callback(instanceIndex))().compute(this.cellCount);
  }

  protected override get cacheSolidOccupancy(): boolean { return true; }

  protected override onParticleColliderGeometryChanged(): void {
    this.movingWallsNode = undefined;
    this.separationApplyNode = undefined;
    this.boundaryCollisions.forEach((collision) => {
      collision.radiusOffset = this.particleCollisionThicknessValue;
    });
  }

  private computeMovingWalls(
    context: GPUParticleUpdateContext,
    renderer: ParticleSpatialGridRenderer,
    grid: ParticleSpatialGrid,
  ): void {
    const backend = this.particleCollisionBackend;
    if (!backend.hasGeometry || !backend.hasMotion) return;
    const tagMask = context.system.getGPUFilterTagMask(this.tags);
    const key = [context.buffers.version, backend.motionVersion, tagMask].join('|');
    if (key !== this.movingWallsKey || this.gatherBuffers !== context.buffers) this.movingWallsNode = undefined;
    this.movingWallsKey = key;
    this.movingWallsNode ??= Fn(() => {
      const particle = context.buffers.storage.createParticle(undefined, true);
      const selected = tagMask === undefined ? particle.alive.notEqual(0)
        : particle.alive.notEqual(0).and(particle.tagMask.bitAnd(uint(tagMask)).notEqual(0));
      If(selected.and(this.isInsideCap(particle.position)), () => {
        const radius = max(particle.scale.x.abs(), max(particle.scale.y.abs(), particle.scale.z.abs()))
          .mul(0.5).add(this.particleCollisionThickness);
        const position = transformPointGPU(particle.position, context.simulationToWorldNode);
        const hit = backend.queryMovingCapsule(position, position, radius);
        const displacement = hit.get('wallDisplacement') as Node<'vec3'>;
        If((hit.get('found') as Node<'bool'>).and(displacement.lengthSq().greaterThan(1e-12)), () => {
          particle.position.assign(transformPointGPU(hit.get('capsulePoint') as Node<'vec3'>,
            context.worldToSimulationNode));
          const normal = context.worldToSimulationNode.mul(vec4(hit.get('normal') as Node<'vec3'>, 0))
            .xyz.normalize();
          const wallVelocity = context.worldToSimulationNode.mul(vec4(displacement, 0)).xyz
            .div(context.deltaTimeNode.max(1e-6));
          const approach = particle.velocity.mul(particle.speed).sub(wallVelocity).dot(normal).min(0);
          If(particle.speed.abs().greaterThan(1e-6), () => {
            particle.velocity.assign(this.clampVelocity(particle.velocity.sub(normal.mul(approach)
              .div(particle.speed))));
          });
          context.buffers.storage.storeParticle(particle);
        });
      });
    })().compute(context.buffers.count);
    this.movingWallsNode.count = context.buffers.count;
    renderer.compute(this.movingWallsNode);
    // P2G and separation must query the corrected positions, not the old hash.
    grid.rebuild(renderer, context.buffers, {});
  }

  protected override solveProjection(
    renderer: ParticleSpatialGridRenderer,
    input: { element(index: Node | number): Node<'vec4'> },
    output: { element(index: Node | number): Node<'vec4'> },
  ): void {
    this.pressureProjection ??= new FluidPressureProjection(
      this.resolution, this.cellSizeNode, this.maxVelocityNode, this.solid, this.pressureCurrent, this.divergence,
      this.closedMinNode, this.closedMaxNode, undefined, input, index => this.targetDivergence(index),
      this.workGrid,
    );
    this.pressureProjection.captureBefore(renderer, this.velocityBefore!);
    this.pressureProjection.solve(renderer, input, output, this.pressureIterations);
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
    const beforeSample = this.sampleTransferField(particle.position, this.velocityBefore!);
    const inside = particle.position.greaterThanEqual(this.boundsMinNode).all()
      .and(particle.position.lessThan(this.boundsMinNode.add(this.cellSizeNode.mul(this.resolution))).all())
      .and(beforeSample.w.greaterThan(1e-6));
    const coordinate = particle.position.sub(this.boundsMinNode).div(this.cellSizeNode);
    const picVelocity = this.pressureProjection!.sample(coordinate);
    const before = this.pressureProjection!.sample(coordinate, true);
    const flipVelocity = vec3(particle.velocity).add(picVelocity.sub(before));
    const velocity = this.clampVelocity(mix(flipVelocity, picVelocity, this.picRatioNode));
    const gravityModifier = this.evaluateDynamicGPU.number(
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

  private sampleTransferField(
    position: Node<'vec3'>,
    field: { element(index: Node | number): Node<'vec4'> },
  ): Node<'vec4'> {
    const gridPosition = vec3(position.sub(this.boundsMinNode).div(this.cellSizeNode).sub(0.5));
    const base = floor(gridPosition);
    const ratio = clamp(gridPosition.sub(base), vec3(0), vec3(1));
    const result = vec4(0).toVar();
    for (let z = 0; z <= 1; z += 1) {
      for (let y = 0; y <= 1; y += 1) {
        for (let x = 0; x <= 1; x += 1) {
          const index = this.cellIndex(ivec3(clamp(
            base.add(vec3(x, y, z)), vec3(0), vec3(this.resolution - 1),
          )));
          // FLIP deltas require identical donors before and after projection.
          // Density in the before field is not an interpolation weight.
          const valid = this.velocityBefore!.element(index).w.greaterThan(0)
            .and(this.velocityCurrent.element(index).w.greaterThan(0));
          const weight = (x ? ratio.x : float(1).sub(ratio.x))
            .mul(y ? ratio.y : float(1).sub(ratio.y))
            .mul(z ? ratio.z : float(1).sub(ratio.z));
          result.addAssign(valid.select(vec4(field.element(index).xyz, 1).mul(weight), vec4(0)));
        }
      }
    }
    return result;
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
