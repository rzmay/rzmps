import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';

export interface SpeedOverLifetimeOptions extends Partial<ModuleOptions> {
    speed: DynamicValue<number>;
}

class SpeedOverLifetime extends Module {
  constructor(public options: Partial<SpeedOverLifetimeOptions> = {}) {
    super((particle: Particle) => {
      particle.speed = particle.start.speed * evaluateDynamicNumber(
        this.options.speed ?? 1,
        particle.time,
        particle.id,
      );
    }, { priority: 1, ...options });
  }
}

export default SpeedOverLifetime;
