import * as THREE from 'three';
import { StorageBufferAttribute } from 'three/webgpu';
import { float, storage } from 'three/tsl';
import Module, { type ModuleOptions } from '../../Module';
import Particle from '../../Particle';
import type { DynamicValue } from '../../types/DynamicValue';
import evaluateDynamicNumber from '../../helpers/evaluateDynamicNumber';
import { evaluateDynamicNumberGPU } from '../../helpers/evaluateDynamicGPU';
import type { IParticleForceField } from '../../interfaces/IParticleForceField';
import ParticleForceField from './ParticleForceField';
import ParticleForceFieldHelper from './ParticleForceFieldHelper';
import ParticleSystem from '../../ParticleSystem';

export interface ExternalForcesOptions extends Partial<ModuleOptions> {
    multiplier: DynamicValue<number>;
    forceFieldFilter: (forceField: ParticleForceField) => boolean;
    forceFields: IParticleForceField[];
}

class ExternalForces extends Module {
  static readonly ParticleForceField = ParticleForceField;
  static readonly ParticleForceFieldHelper = ParticleForceFieldHelper;

  multiplier: DynamicValue<number> = 1;

  explicitForceFields?: IParticleForceField[];

  forceFieldFilter?: (forceField: ParticleForceField) => boolean;

  private forceFields: Set<IParticleForceField> = new Set();

  private particleSystem?: ParticleSystem;
  private forceSamples = new Float32Array(3);
  private forceSampleAttribute = new StorageBufferAttribute(this.forceSamples, 3);

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
      priority: Module.Priority.Permanent,
      modifyGPU: (particle, deltaTime, context) => {
        const force = storage(
          this.forceSampleAttribute,
          'vec3',
          Math.max(1, context.buffers.capacity),
        ).element(particle.index);
        const multiplier = evaluateDynamicNumberGPU(
          this.multiplier ?? 1,
          particle.time,
          1,
          particle.index,
        );
        const mass = particle.mass.greaterThan(float(0)).select(particle.mass, float(1));

        particle.velocity.assign(
          particle.velocity.add(force.mul(multiplier).mul(deltaTime).div(mass)),
        );
      },
    });

    this.explicitForceFields = options.forceFields;
    this.forceFieldFilter = options.forceFieldFilter ?? (() => true );
  }

  public prepare(particleSystem: ParticleSystem, deltaTime: number): void {
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

    if (particleSystem.isGPUProcessingActive) {
      this.sampleForces(particleSystem, deltaTime);
    }
  }

  private sampleForces(particleSystem: ParticleSystem, deltaTime: number): void {
    if (!Array.isArray(particleSystem.particles)) return;

    const capacity = Math.max(1, particleSystem.maxParticles, particleSystem.particles.length);

    if (this.forceSamples.length < capacity * 3) {
      this.forceSamples = new Float32Array(capacity * 3);
      this.forceSampleAttribute = new StorageBufferAttribute(this.forceSamples, 3);
    }

    particleSystem.particles.forEach((particle, index) => {
      const force = this.getSampledForce(particle, deltaTime);
      const offset = index * 3;

      this.forceSamples[offset] = force.x;
      this.forceSamples[offset + 1] = force.y;
      this.forceSamples[offset + 2] = force.z;
    });

    for (let index = particleSystem.particles.length * 3; index < this.forceSamples.length; index += 1) {
      this.forceSamples[index] = 0;
    }

    this.forceSampleAttribute.needsUpdate = true;
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
