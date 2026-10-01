import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';
import {
  evaluateDynamicNumberGPU,} from '../helpers/evaluateDynamicGPU';

export interface SpeedOverLifetimeOptions extends Partial<ModuleOptions> {
    speed: DynamicValue<number>;
}

class SpeedOverLifetime extends Module {
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
            particle.speed.mul(evaluateDynamicNumberGPU(this.options.speed ?? 1, particle.time, 1, particle.index)),
          );
        }
    });
  }
}

export default SpeedOverLifetime;
