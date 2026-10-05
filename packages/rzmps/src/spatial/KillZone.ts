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

// Super simple implementation -- just a spatial effect whose modifier calls particle.kill()
// Exists mainly as a shortcut rather than any sophisticated implementation
class KillZone extends SpatialEffect {
  static Box(
    modify: SpatialEffectModifier | null,
    options: Partial<KillZoneOptions> | null,
    ...args: BoxGeometryArgs
  ): KillZone;
  static Box(
    options?: Partial<KillZoneOptions>,
    ...args: BoxGeometryArgs
  ): KillZone;
  static Box(
    ...args: BoxGeometryArgs
  ): KillZone;
  static Box(
    first?: unknown,
    second?: unknown,
    ...args: unknown[]
  ): KillZone {
    const { options, geometryArgs } = KillZone.resolveFactoryArgs<BoxGeometryArgs>(
      first,
      second,
      args,
    );
    return new KillZone({ ...options, geometry: new THREE.BoxGeometry(...geometryArgs) });
  }

  static Sphere(
    modify: SpatialEffectModifier | null,
    options: Partial<KillZoneOptions> | null,
    ...args: SphereGeometryArgs
  ): KillZone;
  static Sphere(
    options?: Partial<KillZoneOptions>,
    ...args: SphereGeometryArgs
  ): KillZone;
  static Sphere(
    ...args: SphereGeometryArgs
  ): KillZone;
  static Sphere(
    first?: unknown,
    second?: unknown,
    ...args: unknown[]
  ): KillZone {
    const { options, geometryArgs } = KillZone.resolveFactoryArgs<SphereGeometryArgs>(
      first,
      second,
      args,
    );
    return new KillZone({ ...options, geometry: new THREE.SphereGeometry(...geometryArgs) });
  }

  static Cone(
    modify: SpatialEffectModifier | null,
    options: Partial<KillZoneOptions> | null,
    ...args: ConeGeometryArgs
  ): KillZone;
  static Cone(
    options?: Partial<KillZoneOptions>,
    ...args: ConeGeometryArgs
  ): KillZone;
  static Cone(
    ...args: ConeGeometryArgs
  ): KillZone;
  static Cone(
    first?: unknown,
    second?: unknown,
    ...args: unknown[]
  ): KillZone {
    const { options, geometryArgs } = KillZone.resolveFactoryArgs<ConeGeometryArgs>(
      first,
      second,
      args,
    );
    return new KillZone({ ...options, geometry: new THREE.ConeGeometry(...geometryArgs) });
  }

  static Torus(
    modify: SpatialEffectModifier | null,
    options: Partial<KillZoneOptions> | null,
    ...args: TorusGeometryArgs
  ): KillZone;
  static Torus(
    options?: Partial<KillZoneOptions>,
    ...args: TorusGeometryArgs
  ): KillZone;
  static Torus(
    ...args: TorusGeometryArgs
  ): KillZone;
  static Torus(
    first?: unknown,
    second?: unknown,
    ...args: unknown[]
  ): KillZone {
    const { options, geometryArgs } = KillZone.resolveFactoryArgs<TorusGeometryArgs>(
      first,
      second,
      args,
    );
    return new KillZone({ ...options, geometry: new THREE.TorusGeometry(...geometryArgs) });
  }

  private static resolveFactoryArgs<T extends unknown[]>(
    first: unknown,
    second: unknown,
    rest: unknown[],
  ): { options: Partial<KillZoneOptions>; geometryArgs: T } {
    if (typeof first === 'function' || first === null) {
      return {
        options: (second && typeof second === 'object' && !Array.isArray(second)
          ? second as Partial<KillZoneOptions>
          : {}) ?? {},
        geometryArgs: rest as T,
      };
    }

    return {
      options: first && typeof first === 'object' && !Array.isArray(first)
        ? first as Partial<KillZoneOptions>
        : {},
      geometryArgs: (
        first && typeof first === 'object' && !Array.isArray(first)
          ? (second === undefined ? rest : [second, ...rest])
          : [first, second, ...rest].filter((value) => value !== undefined)
      ) as T,
    };
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
