import Module, { type ModuleOptions } from '../core/Module';
import Particle from '../core/Particle';
import type { DynamicValue } from '../values/dynamicValue.types';
import evaluateDynamicNumber from '../values/evaluateDynamicNumber';

export interface SpeedOverLifetimeOptions extends Partial<ModuleOptions> {
    speed: DynamicValue<number>;
}

/**
 * Transiently multiplies the scalar integration speed before movement; does not permanently replace particle velocity.
 */
class SpeedOverLifetime extends Module {
  /** Creates the modifier with its built-in priority and optional filtering/LOD settings. */
  constructor(public options: Partial<SpeedOverLifetimeOptions> = {}) {

    super((particle: Particle) => {
      particle.speed *= evaluateDynamicNumber(
        this.options.speed ?? 1,
        particle.time,
        particle.id,
      );
    }, {
      ...options,
      priority: Module.Priority.PreMovementTransient,
      modifyGPU: (particle) => {
          particle.speed.assign(
            particle.speed.mul(this.evaluateDynamicGPU.number(
              'speed', () => this.options.speed, particle.time, 1, particle.index,
            )),
          );
        }
    });
  }
}

export default SpeedOverLifetime;
