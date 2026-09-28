import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';
import type { IParticleForceField } from '../interfaces/IParticleForceField';
import ParticleForceField from '../ParticleForceField';
import ParticleSystem from '../ParticleSystem';

export interface ExternalForcesOptions extends Partial<ModuleOptions> {
    multiplier: DynamicValue<number>;
    forceFieldFilter: (forceField: ParticleForceField) => boolean;
    forceFields: IParticleForceField[];
}

class ExternalForces extends Module {
  multiplier: DynamicValue<number> = 1;

  explicitForceFields?: IParticleForceField[];

  forceFieldFilter?: (forceField: ParticleForceField) => boolean;

  private forceFields: Set<IParticleForceField> = new Set();

  private particleSystem?: ParticleSystem;

  constructor(options: Partial<ExternalForcesOptions> = {}) {
    super((particle: Particle, deltaTime: number) => {
      const multiplier = evaluateDynamicNumber(this.multiplier ?? 1, particle.time, particle.id);
      const force = this.getSampledForce(particle, deltaTime);
      const mass = Number.isFinite(particle.mass) && particle.mass > 0
        ? particle.mass
        : 1;

      particle.velocity.addScaledVector(force, (multiplier * deltaTime) / mass);
    }, {
      ...options,
    });

    this.explicitForceFields = options.forceFields;
    this.forceFieldFilter = options.forceFieldFilter ?? (() => true );
  }

  public prepare(particleSystem: ParticleSystem): void {
    this.particleSystem = particleSystem;

    // If explicit force fields are provided, just use those
    if (Array.isArray(this.explicitForceFields)) {
      this.forceFields = new Set(this.explicitForceFields);
    } else {
      this.forceFields.clear();

      // Otherwise, scan the scene for force fields
      particleSystem.scene?.traverse((object) => {
        if (
          object instanceof ParticleForceField
          && this.forceFieldFilter?.(object)
        ) this.forceFields.add(object);
      });
    }

  }

  private getSampledForce(particle: Particle, deltaTime: number): THREE.Vector3 {
    const particleSystem = this.particleSystem;
    const force = new THREE.Vector3();

    if (!particleSystem) return force;

    particleSystem.updateWorldMatrix(true, false);

    const particlePosition = particleSystem.simulationSpace === 'world'
      ? particle.position
      : particleSystem.localToWorld(particle.position.clone());

    const worldQuaternion = particleSystem.simulationSpace === 'local'
      ? particleSystem.getWorldQuaternion(new THREE.Quaternion())
      : new THREE.Quaternion();
    const inverseWorldQuaternion = worldQuaternion?.clone().invert();
    const forceParticle = particleSystem.simulationSpace === 'world'
      ? particle
      : Object.assign(
        Object.create(Object.getPrototypeOf(particle)),
        particle,
        {
          position: particlePosition,
          velocity: particle.velocity
            .clone()
            .applyQuaternion(worldQuaternion),
        },
      );

    this.forceFields.forEach((forceField) => {
      const fieldForce = forceField.getForce(forceParticle, deltaTime);

      if (inverseWorldQuaternion) {
        fieldForce.applyQuaternion(inverseWorldQuaternion);
      }

      force.add(fieldForce);
    });

    return force;
  }
}

export default ExternalForces;
export type { IParticleForceField };
