import Particle from '../Particle';
import SpatialEffect, {
  type SpatialEffectModifier,
  type SpatialEffectOptions,
} from '../SpatialEffect';
import * as THREE from 'three';
import Priority from '../enums/Priority';

export type KillZoneOptions = SpatialEffectOptions;
type BoxGeometryArgs = ConstructorParameters<typeof THREE.BoxGeometry>;
type SphereGeometryArgs = ConstructorParameters<typeof THREE.SphereGeometry>;
type ConeGeometryArgs = ConstructorParameters<typeof THREE.ConeGeometry>;
type TorusGeometryArgs = ConstructorParameters<typeof THREE.TorusGeometry>;

class KillZone extends SpatialEffect {
  static Box(
    _modify: SpatialEffectModifier | null,
    options: Partial<KillZoneOptions> | null,
    ...args: BoxGeometryArgs
  ): KillZone {
    return new KillZone({ ...(options ?? {}), geometry: new THREE.BoxGeometry(...args) });
  }

  static Sphere(
    _modify: SpatialEffectModifier | null,
    options: Partial<KillZoneOptions> | null,
    ...args: SphereGeometryArgs
  ): KillZone {
    return new KillZone({ ...(options ?? {}), geometry: new THREE.SphereGeometry(...args) });
  }

  static Cone(
    _modify: SpatialEffectModifier | null,
    options: Partial<KillZoneOptions> | null,
    ...args: ConeGeometryArgs
  ): KillZone {
    return new KillZone({ ...(options ?? {}), geometry: new THREE.ConeGeometry(...args) });
  }

  static Torus(
    _modify: SpatialEffectModifier | null,
    options: Partial<KillZoneOptions> | null,
    ...args: TorusGeometryArgs
  ): KillZone {
    return new KillZone({ ...(options ?? {}), geometry: new THREE.TorusGeometry(...args) });
  }

  constructor(options: Partial<KillZoneOptions> = {}) {
    super((particle: Particle) => {
      particle.kill();
    }, {
      priority: Priority.Permanent,
      ...options,
    });
  }
}

export default KillZone;
