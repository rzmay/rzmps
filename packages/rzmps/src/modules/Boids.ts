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
}

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
  private particleSystem?: ParticleSystem;
  private affectorDirection = new THREE.Vector3();
  private affectorSamplePosition = new THREE.Vector3();
  private particleAffectorDirection = new THREE.Vector3();
  private worldQuaternion = new THREE.Quaternion();
  private inverseWorldQuaternion = new THREE.Quaternion();
  private currentParticleAffectorInfluence = new THREE.Vector3();
  private particleIndices = new WeakMap<Particle, number>();

  constructor(options: Partial<BoidsOptions> = {}) {
    const affectorFilter = options.affectorFilter;

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
      this.currentDirection.lerp(this.desiredVelocity, steeringAlpha);

      if (this.currentDirection.lengthSq() === 0) {
        this.currentDirection.copy(this.desiredVelocity);
      }

      particle.velocity.copy(this.currentDirection.normalize().multiplyScalar(speed));
    }, {
      ...options,
      priority: options.priority ?? Module.Priority.Permanent,
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
  }

  public prepare(particleSystem: ParticleSystem): void {
    super.prepare(particleSystem, 0);
    this.particleSystem = particleSystem;

    // BoidAffectors are sampled per particle, so keep their matrices fresh once per frame.
    this.spatialEffects.forEach((effect) => effect.updateWorldMatrix(true, false));

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

  private queryBoidInfluence(particle: Particle): BoidInfluence {
    this.alignment.set(0, 0, 0);
    this.cohesion.set(0, 0, 0);
    this.separation.set(0, 0, 0);
    this.affector.set(0, 0, 0);

    const node = this.octree?.locate(particle.position);
    const nodes = node ? [node, ...node.neighbors] : [];
    const particleIndex = this.particleIndices.get(particle);
    let totalWeight = 0;
    let affectorTotalWeight = 0;

    nodes.forEach((sampleNode) => {
      const { aggregate } = sampleNode;

      // Remove the current particle from sampled flocking averages without cloning aggregates.
      const includesCurrentParticle = particleIndex !== undefined
        && sampleNode.particleIndices.includes(particleIndex);
      const sampleCount = includesCurrentParticle
        ? aggregate.count - 1
        : aggregate.count;

      if (sampleCount > 0) {
        this.sampleCenter.copy(aggregate.positionSum);
        this.sampleVelocity.copy(aggregate.velocitySum);

        if (includesCurrentParticle) {
          this.sampleCenter.sub(particle.position);
          this.sampleVelocity.sub(particle.velocity);
        }

        this.sampleCenter.divideScalar(sampleCount);
        this.sampleVelocity.divideScalar(sampleCount);
        this.sampleDirection.copy(this.sampleVelocity);
        if (this.sampleDirection.lengthSq() > 0) this.sampleDirection.normalize();

        this.toNode.copy(this.sampleCenter).sub(particle.position);
        const distance = Math.max(this.toNode.length(), Number.EPSILON);
        const weight = sampleCount / distance;

        this.alignment.addScaledVector(this.sampleDirection, weight);
        this.cohesion.addScaledVector(this.sampleCenter, weight);

        this.toNode.multiplyScalar(-1);
        if (this.toNode.lengthSq() > 0) {
          this.separation.addScaledVector(this.toNode.normalize(), weight);
        }

        totalWeight += weight;
      }

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

    if (totalWeight > 0) {
      this.alignment.divideScalar(totalWeight);
      if (this.alignment.lengthSq() > 0) this.alignment.normalize();

      this.cohesion
        .divideScalar(totalWeight)
        .sub(particle.position);
      if (this.cohesion.lengthSq() > 0) this.cohesion.normalize();

      this.separation.divideScalar(totalWeight);
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
    return velocitySpeed > 0 ? velocitySpeed : particle.speed;
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

export default Boids;
