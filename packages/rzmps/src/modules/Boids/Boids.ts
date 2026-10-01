import * as THREE from 'three';
import Module, { type ModuleOptions } from '../../Module';
import Particle from '../../Particle';
import ParticleSystem from '../../ParticleSystem';
import evaluateDynamicNumber from '../../helpers/evaluateDynamicNumber';
import acceptMultiple from '../../helpers/acceptMultiple';
import tagsIntersect from '../../helpers/tagsIntersect';
import ParticleOctree, {
  type OctreeAggregator,
  type OctreeConfig,
  type OctreeNode,
} from '../../helpers/ParticleOctree';
import type { DynamicValue } from '../../types/DynamicValue';
import type { Tag } from '../../types/Tag';
import BoidAffector from './BoidAffector';
import BoidAffectorHelper from './BoidAffectorHelper';
import type { BoidAffectorOptions } from './BoidAffector';

type BoidAggregate = {
  count: number;
  positionSum: THREE.Vector3;
  velocitySum: THREE.Vector3;
  center: THREE.Vector3;
  averageVelocity: THREE.Vector3;
  averageDirection: THREE.Vector3;
  affectorSum: THREE.Vector3;
  affectorAverage: THREE.Vector3;
};

type BoidInfluence = {
  alignment: THREE.Vector3;
  cohesion: THREE.Vector3;
  separation: THREE.Vector3;
  affector: THREE.Vector3;
};

export type BoidParticleAffectorOptions = Partial<
  Omit<BoidAffectorOptions, 'position' | 'geometry' | 'bvhOptions'>
>;

export type BoidParticleAffectorMap = Record<string, BoidParticleAffectorOptions>;

type ParsedBoidParticleAffector = {
  sourceTags: Tag[];
  options: BoidParticleAffectorOptions;
  targetTags?: Tag[];
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
  particleAffectors: BoidParticleAffectorMap;
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
  explicitAffectors?: BoidAffector[];
  affectorFilter?: (affector: BoidAffector) => boolean;
  particleAffectors?: BoidParticleAffectorMap;

  private alignment = new THREE.Vector3();
  private cohesion = new THREE.Vector3();
  private separation = new THREE.Vector3();
  private affector = new THREE.Vector3();
  private toNode = new THREE.Vector3();
  private desiredVelocity = new THREE.Vector3();
  private currentDirection = new THREE.Vector3();
  private affectors: Set<BoidAffector> = new Set();
  private particleSystem?: ParticleSystem;
  private affectorDirection = new THREE.Vector3();
  private affectorParticlePosition = new THREE.Vector3();
  private particleAffectorDirection = new THREE.Vector3();
  private worldQuaternion = new THREE.Quaternion();
  private inverseWorldQuaternion = new THREE.Quaternion();
  private parsedParticleAffectors: ParsedBoidParticleAffector[] = [];
  private particleIndices = new WeakMap<Particle, number>();
  private particleAffectorInfluences = new WeakMap<Particle, THREE.Vector3>();
  private adjustedAggregate?: BoidAggregate;
  private currentAffectorInfluence = new THREE.Vector3();
  private quantizedOctreeBounds = new THREE.Box3();
  private octreeBoundsCenter = new THREE.Vector3();
  private octreeBoundsSize = new THREE.Vector3();

  constructor(options: Partial<BoidsOptions> = {}) {
    super((particle, deltaTime) => {
      if (!this.octree) return;

      const influence = this.queryBoidInfluence(particle);
      const speed = this.getTargetSpeed(particle);

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
    });

    this.octreeOptions = {
      bounds: options.octreeOptions?.bounds?.clone() ?? new THREE.Box3(
        new THREE.Vector3(-0.5, -0.5, -0.5),
        new THREE.Vector3(0.5, 0.5, 0.5),
      ),
      maxDepth: options.octreeOptions?.maxDepth ?? 8,
      particlesPerLeaf: options.octreeOptions?.particlesPerLeaf ?? 4,
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
    this.explicitAffectors = options.affectors;
    this.affectorFilter = options.affectorFilter ?? (() => true);
    this.particleAffectors = options.particleAffectors;
    this.parsedParticleAffectors = this.parseParticleAffectors(options.particleAffectors);
  }

  public prepare(particleSystem: ParticleSystem): void {
    this.particleSystem = particleSystem;
    this.parsedParticleAffectors = this.parseParticleAffectors(this.particleAffectors);
    this.updateAffectors(particleSystem);
    if (particleSystem.boundingBox.isEmpty()) particleSystem.updateBoundingBox();
    this.updateOctreeBounds(particleSystem);

    if (!this.octree) {
      this.octree = new ParticleOctree(
        {
          bounds: this.octreeOptions.bounds?.clone(),
          maxDepth: this.octreeOptions.maxDepth,
          particlesPerLeaf: this.octreeOptions.particlesPerLeaf,
          timeQuality: this.octreeOptions.timeQuality,
        },
        this.createAggregator(),
      );
    }

    this.particleAffectorInfluences = new WeakMap();
    const rebuilt = this.octree.rebuild(particleSystem.particles, this.tags);

    if (rebuilt) {
      this.particleIndices = new WeakMap();
      particleSystem.particles.forEach((particle, index) => {
        this.particleIndices.set(particle, index);
      });
    }
  }

  private queryBoidInfluence(particle: Particle): BoidInfluence {
    this.alignment.set(0, 0, 0);
    this.cohesion.set(0, 0, 0);
    this.separation.set(0, 0, 0);
    this.affector.set(0, 0, 0);

    const node = this.octree?.locate(particle.position);
    const nodes = node ? [node, ...node.neighbors] : [];
    let totalWeight = 0;
    let affectorTotalWeight = 0;

    nodes.forEach((sampleNode) => {
      const aggregate = this.getAggregateForParticle(sampleNode, particle);
      if (aggregate.count > 0) {
        this.toNode.copy(aggregate.center).sub(particle.position);
        const distance = Math.max(this.toNode.length(), Number.EPSILON);
        const weight = aggregate.count / distance;

        this.alignment.addScaledVector(aggregate.averageDirection, weight);
        this.cohesion.addScaledVector(aggregate.center, weight);

        this.toNode.multiplyScalar(-1);
        if (this.toNode.lengthSq() > 0) {
          this.separation.addScaledVector(this.toNode.normalize(), weight);
        }

        totalWeight += weight;
      }

      if (sampleNode.aggregate.affectorAverage.lengthSq() > 0) {
        const affectorDistance = evaluateDynamicNumber(
          this.affectorDistance,
          particle.time,
          particle.id,
        );
        const distanceToNode = Math.max(
          particle.position.distanceTo(sampleNode.center),
          Number.EPSILON,
        );
        const responseFalloff = affectorDistance > 0
          ? 1 / Math.max((distanceToNode - affectorDistance) ** 2, Number.EPSILON)
          : 1;
        const affectorWeight = sampleNode.aggregate.count * responseFalloff;

        this.affector.addScaledVector(sampleNode.aggregate.affectorAverage, affectorWeight);
        affectorTotalWeight += affectorWeight;
      }
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
      if (this.affector.lengthSq() > 0) this.affector.normalize();
    }

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
        const aggregate = this.createEmptyAggregate();

        if (!particle) return aggregate;

        const direction = particle.velocity.clone();
        if (direction.lengthSq() > 0) direction.normalize();

        aggregate.count = 1;
        aggregate.positionSum.copy(particle.position);
        aggregate.velocitySum.copy(particle.velocity);
        aggregate.center.copy(particle.position);
        aggregate.averageVelocity.copy(particle.velocity);
        aggregate.averageDirection.copy(direction);
        this.sampleAffectorInfluence(particle, aggregate.affectorSum);
        aggregate.affectorAverage.copy(aggregate.affectorSum);
        this.particleAffectorInfluences.set(particle, aggregate.affectorSum.clone());

        return aggregate;
      },

      combine: (a, b) => {
        a.count += b.count;
        a.positionSum.add(b.positionSum);
        a.velocitySum.add(b.velocitySum);
        a.affectorSum.add(b.affectorSum);

        if (a.count > 0) {
          a.center.copy(a.positionSum).divideScalar(a.count);
          a.averageVelocity.copy(a.velocitySum).divideScalar(a.count);
          a.averageDirection.copy(a.averageVelocity);
          if (a.averageDirection.lengthSq() > 0) a.averageDirection.normalize();
          a.affectorAverage.copy(a.affectorSum).divideScalar(a.count);
        }

        return a;
      },
    };
  }

  private createEmptyAggregate(): BoidAggregate {
    return {
      count: 0,
      positionSum: new THREE.Vector3(),
      velocitySum: new THREE.Vector3(),
      center: new THREE.Vector3(),
      averageVelocity: new THREE.Vector3(),
      averageDirection: new THREE.Vector3(),
      affectorSum: new THREE.Vector3(),
      affectorAverage: new THREE.Vector3(),
    };
  }

  private getAggregateForParticle(
    node: OctreeNode<BoidAggregate>,
    particle: Particle,
  ): BoidAggregate {
    const particleIndex = this.particleIndices.get(particle);
    if (
      particleIndex === undefined
      || !node.particleIndices.includes(particleIndex)
    ) return node.aggregate;

    if (node.aggregate.count <= 1) return this.getEmptyAdjustedAggregate();

    this.adjustedAggregate = this.adjustedAggregate ?? this.createEmptyAggregate();
    this.adjustedAggregate.count = node.aggregate.count - 1;
    this.adjustedAggregate.positionSum
      .copy(node.aggregate.positionSum)
      .sub(particle.position);
    this.adjustedAggregate.velocitySum
      .copy(node.aggregate.velocitySum)
      .sub(particle.velocity);
    this.adjustedAggregate.affectorSum
      .copy(node.aggregate.affectorSum)
      .sub(this.getCurrentAffectorInfluence(particle));

    this.finalizeAdjustedAggregate(this.adjustedAggregate);

    return this.adjustedAggregate;
  }

  private getEmptyAdjustedAggregate(): BoidAggregate {
    this.adjustedAggregate = this.adjustedAggregate ?? this.createEmptyAggregate();
    this.adjustedAggregate.count = 0;
    this.adjustedAggregate.positionSum.set(0, 0, 0);
    this.adjustedAggregate.velocitySum.set(0, 0, 0);
    this.adjustedAggregate.center.set(0, 0, 0);
    this.adjustedAggregate.averageVelocity.set(0, 0, 0);
    this.adjustedAggregate.averageDirection.set(0, 0, 0);
    this.adjustedAggregate.affectorSum.set(0, 0, 0);
    this.adjustedAggregate.affectorAverage.set(0, 0, 0);

    return this.adjustedAggregate;
  }

  private finalizeAdjustedAggregate(aggregate: BoidAggregate): void {
    aggregate.center.copy(aggregate.positionSum).divideScalar(aggregate.count);
    aggregate.averageVelocity.copy(aggregate.velocitySum).divideScalar(aggregate.count);
    aggregate.averageDirection.copy(aggregate.averageVelocity);
    if (aggregate.averageDirection.lengthSq() > 0) aggregate.averageDirection.normalize();
    aggregate.affectorAverage.copy(aggregate.affectorSum).divideScalar(aggregate.count);
  }

  private getCurrentAffectorInfluence(particle: Particle): THREE.Vector3 {
    const aggregateAffectorInfluence = this.particleAffectorInfluences.get(particle);
    if (aggregateAffectorInfluence) return aggregateAffectorInfluence;

    return this.sampleAffectorInfluence(particle, this.currentAffectorInfluence);
  }

  private updateOctreeBounds(particleSystem: ParticleSystem): void {
    this.octreeOptions.bounds = this.getQuantizedOctreeBounds(particleSystem.boundingBox).clone();

    if (this.octree) this.octree.setBounds(this.octreeOptions.bounds);
  }

  private getQuantizedOctreeBounds(bounds: THREE.Box3): THREE.Box3 {
    bounds.getCenter(this.octreeBoundsCenter);
    bounds.getSize(this.octreeBoundsSize);

    const rawSize = Math.max(
      this.octreeBoundsSize.x,
      this.octreeBoundsSize.y,
      this.octreeBoundsSize.z,
      Number.EPSILON,
    );
    const size = 2 ** Math.ceil(Math.log2(rawSize));
    const halfSize = size * 0.5;

    this.octreeBoundsCenter.set(
      Math.round(this.octreeBoundsCenter.x / halfSize) * halfSize,
      Math.round(this.octreeBoundsCenter.y / halfSize) * halfSize,
      Math.round(this.octreeBoundsCenter.z / halfSize) * halfSize,
    );

    return this.quantizedOctreeBounds.setFromCenterAndSize(
      this.octreeBoundsCenter,
      this.octreeBoundsSize.set(size, size, size),
    );
  }

  private updateAffectors(particleSystem: ParticleSystem): void {
    if (Array.isArray(this.explicitAffectors)) {
      this.affectors = new Set(this.explicitAffectors);
      return;
    }

    this.affectors.clear();

    particleSystem.scene?.traverse((object) => {
      if (
        object instanceof BoidAffector
        && this.affectorFilter?.(object)
      ) this.affectors.add(object);
    });
  }

  private sampleAffectorInfluence(particle: Particle, target: THREE.Vector3): THREE.Vector3 {
    target.set(0, 0, 0);

    const particleSystem = this.particleSystem;
    const useLocalSimulationSpace = particleSystem?.simulationSpace === 'local';

    if (useLocalSimulationSpace && particleSystem) {
      particleSystem.updateWorldMatrix(true, false);
      this.affectorParticlePosition.copy(particle.position);
      particleSystem.localToWorld(this.affectorParticlePosition);
      particleSystem.getWorldQuaternion(this.worldQuaternion);
      this.inverseWorldQuaternion.copy(this.worldQuaternion).invert();
    } else {
      this.affectorParticlePosition.copy(particle.position);
    }

    this.affectors.forEach((affector) => {
      if (!affector.matchesTags(particle.tags)) return;

      affector.getInfluenceDirection(this.affectorParticlePosition, this.affectorDirection);

      const distance = this.affectorDirection.length();
      if (distance <= Number.EPSILON) return;

      const distanceFromSurface = Math.max(distance - affector.distance, 0);
      const falloff = 1 / Math.max(distanceFromSurface ** 2, Number.EPSILON);

      this.affectorDirection.normalize();
      if (useLocalSimulationSpace) this.affectorDirection.applyQuaternion(this.inverseWorldQuaternion);

      target.addScaledVector(this.affectorDirection, -affector.weight * falloff);
    });

    this.sampleParticleAffectorInfluence(particle, target);

    return target;
  }

  private sampleParticleAffectorInfluence(particle: Particle, target: THREE.Vector3): void {
    if (!this.particleSystem || this.parsedParticleAffectors.length === 0) return;

    this.parsedParticleAffectors.forEach((particleAffector) => {
      if (
        particleAffector.targetTags?.length
        && !tagsIntersect(particleAffector.targetTags, particle.tags ?? [])
      ) return;

      this.particleSystem?.particles.forEach((sourceParticle) => {
        if (
          sourceParticle.id === particle.id
          || !tagsIntersect(particleAffector.sourceTags, sourceParticle.tags ?? [])
        ) return;

        this.particleAffectorDirection.copy(particle.position).sub(sourceParticle.position);

        const distance = this.particleAffectorDirection.length();
        if (distance <= Number.EPSILON) return;

        const size = Math.max(
          Math.abs(sourceParticle.scale.x),
          Math.abs(sourceParticle.scale.y),
          Math.abs(sourceParticle.scale.z),
          Number.EPSILON,
        );
        const preferredDistance = size * (particleAffector.options.distance ?? 1);
        const distanceFromSurface = Math.max(distance - preferredDistance, 0);
        const falloff = 1 / Math.max(distanceFromSurface ** 2, Number.EPSILON);
        const weight = particleAffector.options.weight ?? BoidAffector.Weight.Obstacle;

        target.addScaledVector(
          this.particleAffectorDirection.divideScalar(distance),
          -weight * falloff,
        );
      });
    });
  }

  private parseParticleAffectors(
    particleAffectors?: BoidParticleAffectorMap,
  ): ParsedBoidParticleAffector[] {
    if (!particleAffectors) return [];

    return Object.entries(particleAffectors)
      .map(([sourceTagSelector, options]) => ({
        sourceTags: sourceTagSelector
          .split(/[|,]/)
          .map((tag) => tag.trim())
          .filter(Boolean),
        options,
        targetTags: acceptMultiple(options.tags),
      }))
      .filter((particleAffector) => particleAffector.sourceTags.length > 0);
  }
}

export default Boids;
