import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import ParticleSystem from '../ParticleSystem';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';
import acceptMultiple from '../helpers/acceptMultiple';
import tagsIntersect from '../helpers/tagsIntersect';
import ParticleOctree, {
  type OctreeAggregator,
  type OctreeConfig,
} from '../helpers/ParticleOctree';
import type { DynamicValue } from '../types/DynamicValue';
import type { Multiple } from '../types/Multiple';
import type { Tag } from '../types/Tag';
import BoidAffector from '../spatial/BoidAffector';
import BoidAffectorHelper from '../spatial/BoidAffectorHelper';
import type { BoidAffectorOptions } from '../spatial/BoidAffector';
import ParticleSpatialGrid, {
  type ParticleSpatialGridOptions,
} from '../gpu/ParticleSpatialGrid';
import type { GPUParticleLike, GPUParticleUpdateContext } from '../gpu/Particle';
import type { Node } from 'three/webgpu';
import { acos, cos, float, If, max, mix, sin, uint, vec3, vec4 } from 'three/tsl';
import { SimulationSpace } from '../enums/SimulationSpace';

const GPU_FALLOFF_MIN_DISTANCE = 1e-3;

type BoidParticleAffectorAggregate = {
  count: number;
  positionSum: THREE.Vector3;
  scaleSum: THREE.Vector3;
  center: THREE.Vector3;
  averageScale: THREE.Vector3;
};

type BoidAggregate = {
  count: number;
  positionSum: THREE.Vector3;
  velocitySum: THREE.Vector3;
  center: THREE.Vector3;
  averageVelocity: THREE.Vector3;
  averageDirection: THREE.Vector3;
  particleAffectors: Map<number, BoidParticleAffectorAggregate>;
};

type BoidInfluence = {
  alignment: THREE.Vector3;
  cohesion: THREE.Vector3;
  separation: THREE.Vector3;
  affector: THREE.Vector3;
};

export type BoidParticleAffectorOptions = Partial<
  Omit<BoidAffectorOptions, 'position' | 'geometry' | 'bvhOptions' | 'test' | 'range'>
> & {
  sourceTags: Multiple<Tag>;
};

export interface BoidsOptions extends Partial<ModuleOptions> {
  octreeOptions: Partial<OctreeConfig>;
  timeQuality: number;
  speed: DynamicValue<number>;
  alignmentWeight: DynamicValue<number>;
  cohesionWeight: DynamicValue<number>;
  separationWeight: DynamicValue<number>;
  affectorWeight: DynamicValue<number>;
  affectorDistance: DynamicValue<number>;
  steering: DynamicValue<number>;
  maintainSpeed: boolean;
  affectors: BoidAffector[];
  affectorFilter: (affector: BoidAffector) => boolean;
  particleAffectors: Multiple<BoidParticleAffectorOptions>;
  spatialGrid: ParticleSpatialGrid | Partial<ParticleSpatialGridOptions>;
  grid: ParticleSpatialGrid | Partial<ParticleSpatialGridOptions>;
  neighborRadius: DynamicValue<number>;
}

/** Flocking steering using spatial aggregates and tagged affectors; prepare once per system update before modifying particles. */
class Boids extends Module {
  static readonly BoidAffector = BoidAffector;
  static readonly BoidAffectorHelper = BoidAffectorHelper;

  octree?: ParticleOctree<BoidAggregate>;

  octreeOptions: OctreeConfig;
  speed?: DynamicValue<number>;
  alignmentWeight: DynamicValue<number>;
  cohesionWeight: DynamicValue<number>;
  separationWeight: DynamicValue<number>;
  affectorWeight: DynamicValue<number>;
  affectorDistance: DynamicValue<number>;
  steering: DynamicValue<number>;
  maintainSpeed: boolean;
  particleAffectors: BoidParticleAffectorOptions[];
  spatialGrid?: ParticleSpatialGrid;
  spatialGridOptions: ParticleSpatialGrid | Partial<ParticleSpatialGridOptions>;
  neighborRadius: DynamicValue<number>;

  private alignment = new THREE.Vector3();
  private cohesion = new THREE.Vector3();
  private separation = new THREE.Vector3();
  private affector = new THREE.Vector3();
  private toNode = new THREE.Vector3();
  private sampleCenter = new THREE.Vector3();
  private sampleVelocity = new THREE.Vector3();
  private sampleDirection = new THREE.Vector3();
  private desiredVelocity = new THREE.Vector3();
  private currentDirection = new THREE.Vector3();
  private steeringAxis = new THREE.Vector3();
  private particleSystem?: ParticleSystem;
  private affectorDirection = new THREE.Vector3();
  private affectorSamplePosition = new THREE.Vector3();
  private particleAffectorDirection = new THREE.Vector3();
  private worldQuaternion = new THREE.Quaternion();
  private inverseWorldQuaternion = new THREE.Quaternion();
  private currentParticleAffectorInfluence = new THREE.Vector3();
  private particleIndices = new WeakMap<Particle, number>();

  /** Creates the modifier with its built-in priority and optional filtering/LOD settings. */
  constructor(options: Partial<BoidsOptions> = {}) {
    const affectorFilter = options.affectorFilter;
    const {
      octreeOptions: _octreeOptions,
      spatialGrid: _spatialGrid,
      grid: _grid,
      useOctree: _useOctree,
      useSpatialGrid: _useSpatialGrid,
      ...moduleOptions
    } = options;

    super((particle, deltaTime) => {
      if (!this.octree) return;

      const influence = this.queryBoidInfluence(particle);
      const speed = this.getTargetSpeed(particle);

      // Build a desired direction from the independent steering channels.
      this.desiredVelocity
        .copy(influence.alignment)
        .add(influence.cohesion)
        .add(influence.separation)
        .add(influence.affector);

      if (this.desiredVelocity.lengthSq() === 0) {
        if (!this.maintainSpeed || particle.velocity.lengthSq() === 0) return;
        this.desiredVelocity.copy(particle.velocity);
      }

      this.desiredVelocity.normalize().multiplyScalar(speed);

      // Steering limits how quickly the boid can rotate toward the desired direction.
      const steering = Math.max(0, evaluateDynamicNumber(this.steering, particle.time, particle.id));
      const steeringAlpha = Math.min(Math.max(deltaTime * steering, 0), 1);

      if (!this.maintainSpeed) {
        particle.velocity.lerp(this.desiredVelocity, steeringAlpha);
        return;
      }

      this.currentDirection.copy(particle.velocity);
      if (this.currentDirection.lengthSq() === 0) {
        this.currentDirection.copy(this.desiredVelocity);
      }

      this.currentDirection.normalize();
      this.desiredVelocity.normalize();
      const directionDot = THREE.MathUtils.clamp(
        this.currentDirection.dot(this.desiredVelocity),
        -1,
        1,
      );
      this.steeringAxis.crossVectors(this.currentDirection, this.desiredVelocity);
      if (this.steeringAxis.lengthSq() <= Number.EPSILON) {
        this.steeringAxis.crossVectors(
          this.currentDirection,
          Math.abs(this.currentDirection.y) < 0.9
            ? THREE.Object3D.DEFAULT_UP
            : new THREE.Vector3(1, 0, 0),
        );
      }
      this.currentDirection.applyAxisAngle(
        this.steeringAxis.normalize(),
        Math.acos(directionDot) * steeringAlpha,
      );
      particle.velocity.copy(this.currentDirection.normalize().multiplyScalar(speed));
    }, {
      ...moduleOptions,
      priority: options.priority ?? Module.Priority.Permanent,
      modifyGPU: (particle, deltaTime, context) => this.modifyBoidGPU(
        particle,
        deltaTime,
        context,
      ),
      requireSpatialEffects: BoidAffector,
      spatialEffects: options.affectors,
      spatialEffectFilter: affectorFilter
        ? (spatialEffect) => (
          spatialEffect instanceof BoidAffector
          && affectorFilter(spatialEffect)
        )
        : undefined,
    });

    this.octreeOptions = {
      bounds: options.octreeOptions?.bounds?.clone() ?? new THREE.Box3(
        new THREE.Vector3(-0.5, -0.5, -0.5),
        new THREE.Vector3(0.5, 0.5, 0.5),
      ),
      maxDepth: options.octreeOptions?.maxDepth ?? 8,
      particlesPerLeaf: options.octreeOptions?.particlesPerLeaf ?? 4,
      quantizeBounds: options.octreeOptions?.quantizeBounds ?? 0,
      timeQuality: THREE.MathUtils.clamp(
        options.timeQuality ?? options.octreeOptions?.timeQuality ?? 0.5,
        Number.EPSILON,
        1,
      ),
    };
    this.speed = options.speed;
    this.alignmentWeight = options.alignmentWeight ?? 1;
    this.cohesionWeight = options.cohesionWeight ?? 1;
    this.separationWeight = options.separationWeight ?? 1.5;
    this.affectorWeight = options.affectorWeight ?? 1;
    this.affectorDistance = options.affectorDistance ?? 0;
    this.steering = options.steering ?? 0.5;
    this.maintainSpeed = options.maintainSpeed ?? true;
    this.particleAffectors = acceptMultiple(options.particleAffectors) ?? [];
    this.spatialGridOptions = options.spatialGrid ?? options.grid ?? {
      brickSubdivisions: 2,
      cellSubdivisions: 2,
    };
    this.neighborRadius = options.neighborRadius ?? 1;
  }

  public prepare(particleSystem: ParticleSystem): void {
    super.prepare(particleSystem, 0);
    this.particleSystem = particleSystem;

    // BoidAffectors are sampled per particle, so keep their matrices fresh once per frame.
    this.spatialEffects.forEach((effect) => {
      effect.updateWorldMatrix(true, false);
      if (particleSystem.isGPUProcessingActive) effect.syncGPUTransform(particleSystem);
    });

    // GPU and CPU use exact-radius queries over their respective spatial structures.
    if (particleSystem.isGPUProcessingActive) return;

    if (particleSystem.boundingBox.isEmpty()) particleSystem.updateBoundingBox();
    this.octreeOptions.bounds = particleSystem.boundingBox.clone();
    if (this.octree) this.octree.setBounds(this.octreeOptions.bounds);

    if (!this.octree) {
      this.octree = new ParticleOctree(
        {
          bounds: this.octreeOptions.bounds?.clone(),
          maxDepth: this.octreeOptions.maxDepth,
          particlesPerLeaf: this.octreeOptions.particlesPerLeaf,
          quantizeBounds: this.octreeOptions.quantizeBounds,
          timeQuality: this.octreeOptions.timeQuality,
        },
        this.createAggregator(),
      );
    }

    this.particleIndices = new WeakMap();
    particleSystem.particles.forEach((particle, index) => {
      this.particleIndices.set(particle, index);
    });

    // The tree contains regular boids plus any particles used as source affectors.
    if (!this.tags?.length && this.particleAffectors.length === 0) {
      this.octree.rebuild(particleSystem.particles);
      return;
    }

    const tags = new Set<Tag>(this.tags ?? []);
    this.particleAffectors.forEach((particleAffector) => {
      acceptMultiple(particleAffector.sourceTags)?.forEach((tag) => tags.add(tag));
    });

    this.octree.rebuild(particleSystem.particles, Array.from(tags));
  }

  public override getParticleSpatialGrid(particleSystem: ParticleSystem): ParticleSpatialGrid {
    this.spatialGrid ??= particleSystem.acquireParticleSpatialGrid(this.spatialGridOptions);
    return this.spatialGrid;
  }

  private modifyBoidGPU(
    particle: GPUParticleLike,
    deltaTime: Node<'float'>,
    context: GPUParticleUpdateContext,
  ): void {
    const grid = this.getParticleSpatialGrid(context.system);
    const radius = this.gpuParameters.number(
      'neighborRadius', () => this.neighborRadius, particle.time, 1, particle.index,
    ).max(Number.EPSILON);
    const alignment = vec3(0).toVar('boidAlignment');
    const cohesion = vec3(0).toVar('boidCohesion');
    const separation = vec3(0).toVar('boidSeparation');
    const affector = vec3(0).toVar('boidParticleAffector');
    const count = float(0).toVar('boidNeighborCount');
    const tagMask = context.system.getGPURendererTagMask(this.tags);

    grid.forEachParticleInRadius(particle.position, radius, (neighbor, distanceSquared) => {
      alignment.addAssign(neighbor.velocity);
      cohesion.addAssign(neighbor.position);
      const away = vec3(particle.position.sub(neighbor.position));
      separation.addAssign(away.div(max(distanceSquared, float(Number.EPSILON))));
      count.addAssign(1);
    }, {
      excludeIndex: particle.index,
      tagMask,
    });

    this.particleAffectors.forEach((rule, ruleIndex) => {
      const sourceTags = acceptMultiple(rule.sourceTags);
      const sourceMask = context.system.getGPURendererTagMask(sourceTags);
      const targetTags = acceptMultiple(rule.tags);
      const targetMask = context.system.getGPURendererTagMask(targetTags);
      const collect = () => {
        const sourceCount = float(0).toVar(`boidAffectorSourceCount${ruleIndex}`);
        const addSource = (source: GPUParticleLike) => {
          const delta = vec3(particle.position.sub(source.position));
          const distance = delta.length().max(Number.EPSILON);
          const sourceSize = max(source.scale.x.abs(), max(source.scale.y.abs(), source.scale.z.abs()));
          const preferredDistance = sourceSize.mul(rule.distance ?? 1).add(
            this.gpuParameters.number(
              `affectorDistance:${ruleIndex}`,
              () => this.affectorDistance,
              particle.time,
              0,
              particle.index,
            ),
          );
          // Number.EPSILON produces a ~2e31 force here. Squaring that vector
          // overflows float32 during normalize(), erasing the influence exactly
          // while the particle is inside its preferred-distance band.
          const surfaceDistance = distance.sub(preferredDistance).max(GPU_FALLOFF_MIN_DISTANCE);
          affector.addAssign(
            delta.div(distance)
              .mul(-(rule.weight ?? BoidAffector.Weight.Obstacle))
              .div(surfaceDistance.mul(surfaceDistance)),
          );
          sourceCount.addAssign(1);
        };
        grid.forEachParticleInRadius(particle.position, radius, (source) => {
          addSource(source);
        }, {
          excludeIndex: particle.index,
          tagMask: sourceMask,
        });
      };
      if (targetMask === undefined) collect();
      else If(particle.tagMask.bitAnd(uint(targetMask)).notEqual(uint(0)), collect);
    });

    this.addSceneAffectorInfluenceGPU(particle, context, affector);

    If(count.greaterThan(0), () => {
      alignment.assign(alignment.div(count).normalize());
      cohesion.assign(cohesion.div(count).sub(particle.position).normalize());
      separation.assign(separation.div(count).normalize());
    });

    const alignmentWeight = this.gpuParameters.number(
      'alignmentWeight', () => this.alignmentWeight, particle.time, 1, particle.index,
    );
    const cohesionWeight = this.gpuParameters.number(
      'cohesionWeight', () => this.cohesionWeight, particle.time, 1, particle.index,
    );
    const separationWeight = this.gpuParameters.number(
      'separationWeight', () => this.separationWeight, particle.time, 1.5, particle.index,
    );
    const desired = vec3(
      alignment.mul(alignmentWeight)
        .add(cohesion.mul(cohesionWeight))
        .add(separation.mul(separationWeight))
        .add(affector.mul(this.gpuParameters.number(
          'affectorWeight', () => this.affectorWeight, particle.time, 1, particle.index,
        ))),
    ).toVar('boidDesiredVelocity');

    If(desired.lengthSq().greaterThan(float(Number.EPSILON)), () => {
      const currentSpeed = particle.velocity.length();
      // particle.speed is applied again by integration, so preserve the velocity's
      // own magnitude here instead of multiplying the simulation speed twice.
      const targetSpeed = this.speed === undefined
        ? currentSpeed.greaterThan(float(Number.EPSILON)).select(currentSpeed, float(1))
        : this.gpuParameters.number(
          'speed', () => this.speed, particle.time, 1, particle.index,
        ).max(0);
      desired.assign(desired.normalize().mul(targetSpeed));
      const steering = this.gpuParameters.number(
        'steering', () => this.steering, particle.time, 0.5, particle.index,
      ).max(0);
      const alpha = deltaTime.mul(steering).clamp(0, 1);

      if (this.maintainSpeed) {
        const desiredDirection = vec3(desired.normalize());
        const currentDirection = vec3(
          currentSpeed.greaterThan(float(Number.EPSILON)).select(
            particle.velocity.div(currentSpeed),
            desiredDirection,
          ),
        );
        const directionDot = currentDirection.dot(desiredDirection).clamp(-1, 1);
        const crossAxis = vec3(currentDirection.cross(desiredDirection));
        const fallbackAxis = vec3(
          currentDirection.y.abs().lessThan(0.9).select(
            currentDirection.cross(vec3(0, 1, 0)),
            currentDirection.cross(vec3(1, 0, 0)),
          ),
        );
        const axis = vec3(
          crossAxis.lengthSq().greaterThan(float(Number.EPSILON))
            .select(crossAxis.normalize(), fallbackAxis.normalize()),
        );
        const angle = acos(directionDot).mul(alpha);
        const angleCos = cos(angle);
        const angleSin = sin(angle);
        const direction = vec3(
          currentDirection.mul(angleCos)
            .add(axis.cross(currentDirection).mul(angleSin))
            .add(axis.mul(axis.dot(currentDirection).mul(float(1).sub(angleCos)))),
        ).toVar('boidSteeredDirection');
        particle.velocity.assign(direction.normalize().mul(targetSpeed));
      } else {
        particle.velocity.assign(mix(particle.velocity, desired, alpha));
      }
    });
  }

  public override cleanup(): void {
    this.spatialGrid = undefined;
    super.cleanup();
  }

  private addSceneAffectorInfluenceGPU(
    particle: GPUParticleLike,
    context: GPUParticleUpdateContext,
    influence: Node<'vec3'>,
  ): void {
    const system = context.system;
    const worldPosition = transformPointGPU(particle.position, context.simulationToWorldNode);

    this.spatialEffects.forEach((effect) => {
      if (!(effect instanceof BoidAffector) || !effect.geometry) return;
      const tagMask = system.getGPURendererTagMask(effect.tags);
      const apply = () => {
        If(worldPosition.sub(effect.getGPUWorldPosition()).lengthSq().lessThanEqual(effect.range ** 2), () => {
          const sample = effect.samplePointGPU(worldPosition);
          const fromSurface = vec3(
            worldPosition.sub(sample.point),
          ).toVar('boidAffectorDirection');
          const distance = fromSurface.length().max(Number.EPSILON);
          const flip = effect.inverted ? sample.inside.not() : sample.inside;
          const oriented = vec3(
            flip.select(fromSurface.negate(), fromSurface),
          );
          const surfaceDistance = distance.sub(effect.distance).max(GPU_FALLOFF_MIN_DISTANCE);
          const worldInfluence = oriented.normalize().mul(
            float(-effect.weight).div(surfaceDistance.mul(surfaceDistance)),
          );
          influence.addAssign(
            transformDirectionGPU(worldInfluence, context.worldToSimulationNode),
          );
        });
      };

      if (tagMask === undefined) apply();
      else If(particle.tagMask.bitAnd(uint(tagMask)).notEqual(uint(0)), apply);
    });
  }

  private queryBoidInfluence(particle: Particle): BoidInfluence {
    this.alignment.set(0, 0, 0);
    this.cohesion.set(0, 0, 0);
    this.separation.set(0, 0, 0);
    this.affector.set(0, 0, 0);

    const octree = this.octree!;
    const node = octree.locate(particle.position);
    const nodes = [node, ...node.neighbors];
    const particleIndex = this.particleIndices.get(particle);
    let neighborCount = 0;
    let affectorTotalWeight = 0;

    const neighborRadius = Math.max(
      Number.EPSILON,
      evaluateDynamicNumber(this.neighborRadius, particle.time, particle.id),
    );
    const neighbors = octree.particlesInRadius(
      particle.position,
      neighborRadius,
      { excludeIndex: particleIndex, tags: this.tags },
    );
    neighbors.forEach((neighbor) => {
      const distanceSquared = neighbor.position.distanceToSquared(particle.position);
      this.alignment.add(neighbor.velocity);
      this.cohesion.add(neighbor.position);
      this.toNode.copy(particle.position).sub(neighbor.position);
      this.separation.addScaledVector(
        this.toNode,
        1 / Math.max(distanceSquared, Number.EPSILON),
      );
      neighborCount += 1;
    });

    nodes.forEach((sampleNode) => {
      const { aggregate } = sampleNode;

      // Particle affectors are stored by rule index and accepted per target particle.
      aggregate.particleAffectors.forEach((sourceAggregate, affectorIndex) => {
        const particleAffector = this.particleAffectors[affectorIndex];
        const targetTags = acceptMultiple(particleAffector?.tags);
        if (
          !particleAffector
          || (
            targetTags?.length
            && !tagsIntersect(targetTags, particle.tags ?? [])
          )
          || (
            particleAffector.condition
            && !particleAffector.condition(particle)
          )
        ) {
          return;
        }

        this.particleAffectorDirection
          .copy(particle.position)
          .sub(sourceAggregate.center);

        const distance = this.particleAffectorDirection.length();
        if (distance <= Number.EPSILON) return;

        const size = Math.max(
          Math.abs(sourceAggregate.averageScale.x),
          Math.abs(sourceAggregate.averageScale.y),
          Math.abs(sourceAggregate.averageScale.z),
          Number.EPSILON,
        );
        const localDistance = size * (particleAffector.distance ?? 1);
        const affectorDistance = evaluateDynamicNumber(
          this.affectorDistance,
          particle.time,
          particle.id,
        );
        const preferredDistance = localDistance + affectorDistance;
        const distanceFromSurface = Math.max(distance - preferredDistance, 0);
        const falloff = sourceAggregate.count / Math.max(
          distanceFromSurface ** 2,
          Number.EPSILON,
        );
        const weight = particleAffector.weight ?? BoidAffector.Weight.Obstacle;

        this.affector.addScaledVector(
          this.particleAffectorDirection.divideScalar(distance),
          -weight * falloff,
        );
        affectorTotalWeight += falloff;
      });
    });

    if (neighborCount > 0) {
      this.alignment.divideScalar(neighborCount);
      if (this.alignment.lengthSq() > 0) this.alignment.normalize();

      this.cohesion
        .divideScalar(neighborCount)
        .sub(particle.position);
      if (this.cohesion.lengthSq() > 0) this.cohesion.normalize();

      this.separation.divideScalar(neighborCount);
      if (this.separation.lengthSq() > 0) this.separation.normalize();
    }

    if (affectorTotalWeight > 0) {
      this.affector.divideScalar(affectorTotalWeight);
    }

    // Scene affectors keep their falloff magnitude so containers can overpower flocking.
    this.affector.add(this.sampleSceneAffectorInfluence(particle, this.currentParticleAffectorInfluence));

    this.alignment.multiplyScalar(
      evaluateDynamicNumber(this.alignmentWeight, particle.time, particle.id),
    );
    this.cohesion.multiplyScalar(
      evaluateDynamicNumber(this.cohesionWeight, particle.time, particle.id),
    );
    this.separation.multiplyScalar(
      evaluateDynamicNumber(this.separationWeight, particle.time, particle.id),
    );
    this.affector.multiplyScalar(
      evaluateDynamicNumber(this.affectorWeight, particle.time, particle.id),
    );

    return {
      alignment: this.alignment,
      cohesion: this.cohesion,
      separation: this.separation,
      affector: this.affector,
    };
  }

  private getTargetSpeed(particle: Particle): number {
    if (this.speed !== undefined) {
      return Math.max(0, evaluateDynamicNumber(this.speed, particle.time, particle.id));
    }

    const velocitySpeed = particle.velocity.length();
    return velocitySpeed > 0 ? velocitySpeed : 1;
  }

  private createAggregator(): OctreeAggregator<BoidAggregate> {
    return {
      "new": (particle?: Particle) => {
        const aggregate: BoidAggregate = {
          count: 0,
          positionSum: new THREE.Vector3(),
          velocitySum: new THREE.Vector3(),
          center: new THREE.Vector3(),
          averageVelocity: new THREE.Vector3(),
          averageDirection: new THREE.Vector3(),
          particleAffectors: new Map(),
        };

        if (!particle) return aggregate;

        // Flocking data only includes particles accepted by this module's tags.
        if (!this.tags?.length || tagsIntersect(this.tags, particle.tags ?? [])) {
          aggregate.count = 1;
          aggregate.positionSum.copy(particle.position);
          aggregate.velocitySum.copy(particle.velocity);
          aggregate.center.copy(particle.position);
          aggregate.averageVelocity.copy(particle.velocity);
          aggregate.averageDirection.copy(particle.velocity);
          if (aggregate.averageDirection.lengthSq() > 0) aggregate.averageDirection.normalize();
        }

        // Particle-affector data is split into channels matching particleAffectors indices.
        this.particleAffectors.forEach((particleAffector, affectorIndex) => {
          const sourceTags = acceptMultiple(particleAffector.sourceTags) ?? [];
          if (!tagsIntersect(sourceTags, particle.tags ?? [])) return;

          aggregate.particleAffectors.set(affectorIndex, {
            count: 1,
            positionSum: particle.position.clone(),
            scaleSum: particle.scale.clone(),
            center: particle.position.clone(),
            averageScale: particle.scale.clone(),
          });
        });

        return aggregate;
      },

      combine: (a, b) => {
        a.count += b.count;
        a.positionSum.add(b.positionSum);
        a.velocitySum.add(b.velocitySum);

        // Parent nodes store normalized flock summaries for cheap neighborhood sampling.
        if (a.count > 0) {
          a.center.copy(a.positionSum).divideScalar(a.count);
          a.averageVelocity.copy(a.velocitySum).divideScalar(a.count);
          a.averageDirection.copy(a.averageVelocity);
          if (a.averageDirection.lengthSq() > 0) a.averageDirection.normalize();
        }

        // Merge each particle-affector channel independently so target checks stay per rule.
        b.particleAffectors.forEach((source, affectorIndex) => {
          const target = a.particleAffectors.get(affectorIndex);

          if (!target) {
            a.particleAffectors.set(affectorIndex, {
              count: source.count,
              positionSum: source.positionSum.clone(),
              scaleSum: source.scaleSum.clone(),
              center: source.center.clone(),
              averageScale: source.averageScale.clone(),
            });
            return;
          }

          target.count += source.count;
          target.positionSum.add(source.positionSum);
          target.scaleSum.add(source.scaleSum);
          target.center.copy(target.positionSum).divideScalar(target.count);
          target.averageScale.copy(target.scaleSum).divideScalar(target.count);
        });

        return a;
      },
    };
  }

  private sampleSceneAffectorInfluence(
    particle: Particle,
    target: THREE.Vector3,
  ): THREE.Vector3 {
    target.set(0, 0, 0);

    const particleSystem = this.particleSystem;
    const useLocalSimulationSpace = particleSystem?.simulationSpace === 'local';

    if (useLocalSimulationSpace && particleSystem) {
      particleSystem.updateWorldMatrix(true, false);
      this.affectorSamplePosition.copy(particle.position);
      particleSystem.localToWorld(this.affectorSamplePosition);
      particleSystem.getWorldQuaternion(this.worldQuaternion);
      this.inverseWorldQuaternion.copy(this.worldQuaternion).invert();
    } else {
      this.affectorSamplePosition.copy(particle.position);
    }

    // Scene BoidAffectors may have custom tests, so they are sampled directly per particle.
    return this.spatialEffects.reduce((sum, affector) => {
      if (!(affector instanceof BoidAffector)) return sum;
      if (!particleSystem || !affector.test(particle, particleSystem)) return sum;

      affector.getInfluenceDirection(
        this.affectorSamplePosition,
        this.affectorDirection,
        false,
      );

      const distance = this.affectorDirection.length();
      if (distance <= Number.EPSILON) return sum;

      const distanceFromSurface = Math.max(distance - affector.distance, 0);
      const falloff = 1 / Math.max(distanceFromSurface ** 2, Number.EPSILON);

      this.affectorDirection.normalize();
      if (useLocalSimulationSpace) this.affectorDirection.applyQuaternion(this.inverseWorldQuaternion);

      return sum.addScaledVector(this.affectorDirection, -affector.weight * falloff);
    }, target);
  }
}

function transformPointGPU(point: Node<'vec3'>, matrix: Node<'mat4'>): Node<'vec3'> {
  return matrix.mul(vec4(point, 1)).xyz as Node<'vec3'>;
}

function transformDirectionGPU(vector: Node<'vec3'>, matrix: Node<'mat4'>): Node<'vec3'> {
  return matrix.mul(vec4(vector, 0)).xyz as Node<'vec3'>;
}

export default Boids;
