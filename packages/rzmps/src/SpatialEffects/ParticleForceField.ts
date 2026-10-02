import * as THREE from 'three';
import Particle from '../Particle';
import type ParticleSystem from '../ParticleSystem';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';
import evaluateDynamicVector from '../helpers/evaluateDynamicVector3';
import type { StrictMultiple } from '../types/Multiple';
import type { Tag } from '../types/Tag';
import SpatialEffect, { type SpatialEffectOptions } from '../SpatialEffect';
import Priority from '../enums/Priority';

export interface ForceFieldOptions extends SpatialEffectOptions {
    direction: DynamicValue<THREE.Vector3>;
    gravity: DynamicValue<number>;
    rotationSpeed: DynamicValue<number>;
    rotationAttraction: DynamicValue<number>;
    drag: DynamicValue<number>;
    multiplier: DynamicValue<number>;
    tags: StrictMultiple<Tag>;
}

class ParticleForceField extends SpatialEffect {
  static Box(
    options?: Partial<ForceFieldOptions>,
    ...args: ConstructorParameters<typeof THREE.BoxGeometry>
  ): ParticleForceField {
    return new ParticleForceField({ ...options, geometry: new THREE.BoxGeometry(...args) });
  }

  static Sphere(
    options?: Partial<ForceFieldOptions>,
    ...args: ConstructorParameters<typeof THREE.SphereGeometry>
  ): ParticleForceField {
    return new ParticleForceField({ ...options, geometry: new THREE.SphereGeometry(...args) });
  }

  static Cone(
    options?: Partial<ForceFieldOptions>,
    ...args: ConstructorParameters<typeof THREE.ConeGeometry>
  ): ParticleForceField {
    return new ParticleForceField({ ...options, geometry: new THREE.ConeGeometry(...args) });
  }

  static Torus(
    options?: Partial<ForceFieldOptions>,
    ...args: ConstructorParameters<typeof THREE.TorusGeometry>
  ): ParticleForceField {
    return new ParticleForceField({ ...options, geometry: new THREE.TorusGeometry(...args) });
  }

  direction?: DynamicValue<THREE.Vector3>;
  gravity?: DynamicValue<number>;

  rotationSpeed?: DynamicValue<number>;
  rotationAttraction?: DynamicValue<number>;

  drag?: DynamicValue<number>;
  multiplier: DynamicValue<number> = 1;

  private readonly _particleWorldPosition = new THREE.Vector3();
  private readonly _particleWorldVelocity = new THREE.Vector3();
  private readonly _worldQuaternion = new THREE.Quaternion();
  private readonly _inverseWorldQuaternion = new THREE.Quaternion();

  override get geometry(): THREE.BufferGeometry {
    return super.geometry ?? new THREE.SphereGeometry();
  }

  override set geometry(value: THREE.BufferGeometry) {
    super.geometry = value;
  }

  constructor(options: Partial<ForceFieldOptions> = {}) {
    super(null, {
      ...options,
      geometry: options.geometry ?? new THREE.SphereGeometry(),
      priority: options.priority ?? Priority.Permanent,
    });

    this.direction = options.direction;
    this.gravity = options.gravity;
    this.rotationSpeed = options.rotationSpeed;
    this.rotationAttraction = options.rotationAttraction;
    this.drag = options.drag;
    this.multiplier = options.multiplier ?? this.multiplier;
  }

  override modify(
    particle: Particle,
    deltaTime: number,
    particleSystem: ParticleSystem,
  ): void {
    if (!this.test(particle, particleSystem)) return;

    const multiplier = evaluateDynamicNumber(this.multiplier, particle.time, particle.id);
    const force = this.getForce(particle, particleSystem);
    const mass = Number.isFinite(particle.mass) && particle.mass > 0
      ? particle.mass
      : 1;

    particle.velocity.addScaledVector(force, (multiplier * deltaTime) / mass);
  }

  getForce(particle: Particle, particleSystem?: ParticleSystem): THREE.Vector3 {
    this.updateWorldMatrix(true, false);

    const position = this.getWorldParticlePosition(particle, particleSystem);

    if (!this.containsWorldPosition(position)) return new THREE.Vector3();

    const { time } = particle;
    const force = new THREE.Vector3();
    const center = new THREE.Vector3();
    this.getWorldPosition(center);
    const toCenter = center.clone().sub(position);
    const distanceSq = toCenter.lengthSq();
    const velocity = this.getWorldParticleVelocity(particle, particleSystem);

    if (this.direction !== undefined) {
      const direction = evaluateDynamicVector(
        this.direction,
        time,
      ).clone();

      const rotation = this.getWorldQuaternion(
        new THREE.Quaternion(),
      );

      direction.applyQuaternion(rotation);

      force.add(direction);
    }

    if (this.gravity !== undefined && distanceSq > 0) {
      force.add(toCenter.clone().normalize().multiplyScalar(evaluateDynamicNumber(this.gravity, time)));
    }

    if (this.rotationSpeed !== undefined && distanceSq > 0) {
      const rotationAxis = new THREE.Vector3(0, 1, 0)
        .applyQuaternion(
          this.getWorldQuaternion(new THREE.Quaternion()),
        );

      const fromCenter = position.clone().sub(center);
      const tangent = rotationAxis.cross(fromCenter).normalize();

      force.add(tangent.multiplyScalar(evaluateDynamicNumber(this.rotationSpeed, time)));
    }

    if (this.rotationAttraction !== undefined && distanceSq > 0) {
      force.add(toCenter.clone().normalize().multiplyScalar(
        evaluateDynamicNumber(this.rotationAttraction, time),
      ));
    }

    if (this.drag !== undefined) {
      force.addScaledVector(velocity, -evaluateDynamicNumber(this.drag, time));
    }

    force.multiplyScalar(this.getFalloff(position));

    if (particleSystem?.simulationSpace === 'local') {
      force.applyQuaternion(this._inverseWorldQuaternion);
    }

    return force;
  }

  private getWorldParticlePosition(
    particle: Particle,
    particleSystem?: ParticleSystem,
  ): THREE.Vector3 {
    this._particleWorldPosition.copy(particle.position);

    if (particleSystem?.simulationSpace === 'local') {
      particleSystem.updateWorldMatrix(true, false);
      particleSystem.localToWorld(this._particleWorldPosition);
    }

    return this._particleWorldPosition;
  }

  private getWorldParticleVelocity(
    particle: Particle,
    particleSystem?: ParticleSystem,
  ): THREE.Vector3 {
    this._particleWorldVelocity.copy(particle.velocity);

    if (particleSystem?.simulationSpace === 'local') {
      particleSystem.getWorldQuaternion(this._worldQuaternion);
      this._inverseWorldQuaternion.copy(this._worldQuaternion).invert();
      this._particleWorldVelocity.applyQuaternion(this._worldQuaternion);
    }

    return this._particleWorldVelocity;
  }

  private getFalloff(position: THREE.Vector3): number {
    const localPosition = this.worldToLocal(position.clone());

    if (!this.geometry.boundingBox) {
      this.geometry.computeBoundingBox();
    }

    const size = new THREE.Vector3();

    this.geometry.boundingBox?.getSize(size);

    const radius = size.length() * 0.5;

    if (radius <= 0) return 0;

    const ratio = localPosition.length() / radius;

    if (this.inverted) {
      return Math.min(Math.max(ratio, 0), 1);
    }

    return 1 - Math.min(
      ratio,
      1,
    );
  }
}

export default ParticleForceField;
