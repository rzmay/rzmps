import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicVector from '../helpers/evaluateDynamicVector3';

export interface ForceOverLifetimeOptions extends Partial<ModuleOptions> {
  /** Force sampled by normalized age; velocity change is force times delta seconds divided by mass. */
  force: DynamicValue<THREE.Vector3>;
}

/** Adds force times delta seconds divided by valid positive particle mass; invalid mass falls back to one. */
class ForceOverLifetime extends Module {
  /** Creates the modifier with its built-in priority and optional filtering/LOD settings. */
  constructor(public options: Partial<ForceOverLifetimeOptions> = {}) {

    super((particle: Particle, deltaTime) => {
      const force = evaluateDynamicVector(
          this.options.force ?? new THREE.Vector3(0, 0, 0),
          particle.time,
          particle.id
        )
      const mass = Number.isFinite(particle.mass) && particle.mass > 0
        ? particle.mass
        : 1;

      particle.velocity.addScaledVector(
        force,
        deltaTime / mass,
      );
    }, {
      ...options,
      priority: Module.Priority.Permanent,
    });
  }
}

export default ForceOverLifetime;
