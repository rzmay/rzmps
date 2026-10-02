import Particle from '../Particle';
import ParticleSystem from '../ParticleSystem';
import SpatialEffect, { type SpatialEffectOptions } from '../SpatialEffect';
import * as THREE from 'three';
import Priority from '../enums/Priority';

export type KillZoneOptions = SpatialEffectOptions;

class KillZone extends SpatialEffect {
  static Box(
    options?: Partial<KillZoneOptions>,
    ...args: ConstructorParameters<typeof THREE.BoxGeometry>
  ): KillZone {
    return new KillZone({ ...options, geometry: new THREE.BoxGeometry(...args) });
  }

  static Sphere(
    options?: Partial<KillZoneOptions>,
    ...args: ConstructorParameters<typeof THREE.SphereGeometry>
  ): KillZone {
    return new KillZone({ ...options, geometry: new THREE.SphereGeometry(...args) });
  }

  static Cone(
    options?: Partial<KillZoneOptions>,
    ...args: ConstructorParameters<typeof THREE.ConeGeometry>
  ): KillZone {
    return new KillZone({ ...options, geometry: new THREE.ConeGeometry(...args) });
  }

  static Torus(
    options?: Partial<KillZoneOptions>,
    ...args: ConstructorParameters<typeof THREE.TorusGeometry>
  ): KillZone {
    return new KillZone({ ...options, geometry: new THREE.TorusGeometry(...args) });
  }

  constructor(options: Partial<KillZoneOptions> = {}) {
    super((particle: Particle, _deltaTime: number, _particleSystem: ParticleSystem) => {
      particle.kill();
    }, {
      priority: Priority.Permanent,
      ...options,
    });
  }
}

export default KillZone;
