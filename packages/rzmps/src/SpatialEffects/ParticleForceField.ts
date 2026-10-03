import * as THREE from 'three';
import type { Node } from 'three/webgpu';
import Particle from '../Particle';
import type ParticleSystem from '../ParticleSystem';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';
import evaluateDynamicVector from '../helpers/evaluateDynamicVector3';
import getParticleWorldPosition from '../helpers/getParticleWorldPosition';
import type { StrictMultiple } from '../types/Multiple';
import type { Tag } from '../types/Tag';
import SpatialEffect, {
  type SpatialEffectModifier,
  type SpatialEffectOptions,
} from '../SpatialEffect';
import Priority from '../enums/Priority';
import { cross, float, vec3 } from 'three/tsl';
import {
  evaluateDynamicNumberGPU,
  evaluateDynamicVectorGPU,
} from '../helpers/evaluateDynamicGPU';
import type { GPUParticle, GPUParticleUpdateContext } from '../GPUParticle';

export interface ForceFieldOptions extends SpatialEffectOptions {
    direction: DynamicValue<THREE.Vector3>;
    gravity: DynamicValue<number>;
    rotationSpeed: DynamicValue<number>;
    rotationAttraction: DynamicValue<number>;
    drag: DynamicValue<number>;
    multiplier: DynamicValue<number>;
    tags: StrictMultiple<Tag>;
}

type BoxGeometryArgs = ConstructorParameters<typeof THREE.BoxGeometry>;
type SphereGeometryArgs = ConstructorParameters<typeof THREE.SphereGeometry>;
type ConeGeometryArgs = ConstructorParameters<typeof THREE.ConeGeometry>;
type TorusGeometryArgs = ConstructorParameters<typeof THREE.TorusGeometry>;

class ParticleForceField extends SpatialEffect {
  static Box(
    modify: SpatialEffectModifier | null,
    options: Partial<ForceFieldOptions> | null,
    ...args: BoxGeometryArgs
  ): ParticleForceField;
  static Box(
    options?: Partial<ForceFieldOptions>,
    ...args: BoxGeometryArgs
  ): ParticleForceField;
  static Box(
    ...args: BoxGeometryArgs
  ): ParticleForceField;
  static Box(
    first?: unknown,
    second?: unknown,
    ...args: unknown[]
  ): ParticleForceField {
    const { options, geometryArgs } = ParticleForceField.resolveFactoryArgs<BoxGeometryArgs>(
      first,
      second,
      args,
    );
    return new ParticleForceField({ ...options, geometry: new THREE.BoxGeometry(...geometryArgs) });
  }

  static Sphere(
    modify: SpatialEffectModifier | null,
    options: Partial<ForceFieldOptions> | null,
    ...args: SphereGeometryArgs
  ): ParticleForceField;
  static Sphere(
    options?: Partial<ForceFieldOptions>,
    ...args: SphereGeometryArgs
  ): ParticleForceField;
  static Sphere(
    ...args: SphereGeometryArgs
  ): ParticleForceField;
  static Sphere(
    first?: unknown,
    second?: unknown,
    ...args: unknown[]
  ): ParticleForceField {
    const { options, geometryArgs } = ParticleForceField.resolveFactoryArgs<SphereGeometryArgs>(
      first,
      second,
      args,
    );
    return new ParticleForceField({
      ...options,
      geometry: new THREE.SphereGeometry(...geometryArgs),
    });
  }

  static Cone(
    modify: SpatialEffectModifier | null,
    options: Partial<ForceFieldOptions> | null,
    ...args: ConeGeometryArgs
  ): ParticleForceField;
  static Cone(
    options?: Partial<ForceFieldOptions>,
    ...args: ConeGeometryArgs
  ): ParticleForceField;
  static Cone(
    ...args: ConeGeometryArgs
  ): ParticleForceField;
  static Cone(
    first?: unknown,
    second?: unknown,
    ...args: unknown[]
  ): ParticleForceField {
    const { options, geometryArgs } = ParticleForceField.resolveFactoryArgs<ConeGeometryArgs>(
      first,
      second,
      args,
    );
    return new ParticleForceField({ ...options, geometry: new THREE.ConeGeometry(...geometryArgs) });
  }

  static Torus(
    modify: SpatialEffectModifier | null,
    options: Partial<ForceFieldOptions> | null,
    ...args: TorusGeometryArgs
  ): ParticleForceField;
  static Torus(
    options?: Partial<ForceFieldOptions>,
    ...args: TorusGeometryArgs
  ): ParticleForceField;
  static Torus(
    ...args: TorusGeometryArgs
  ): ParticleForceField;
  static Torus(
    first?: unknown,
    second?: unknown,
    ...args: unknown[]
  ): ParticleForceField {
    const { options, geometryArgs } = ParticleForceField.resolveFactoryArgs<TorusGeometryArgs>(
      first,
      second,
      args,
    );
    return new ParticleForceField({ ...options, geometry: new THREE.TorusGeometry(...geometryArgs) });
  }

  private static resolveFactoryArgs<T extends unknown[]>(
    first: unknown,
    second: unknown,
    rest: unknown[],
  ): { options: Partial<ForceFieldOptions>; geometryArgs: T } {
    if (typeof first === 'function' || first === null) {
      return {
        options: (second && typeof second === 'object' && !Array.isArray(second)
          ? second as Partial<ForceFieldOptions>
          : {}) ?? {},
        geometryArgs: rest as T,
      };
    }

    return {
      options: first && typeof first === 'object' && !Array.isArray(first)
        ? first as Partial<ForceFieldOptions>
        : {},
      geometryArgs: (
        first && typeof first === 'object' && !Array.isArray(first)
          ? (second === undefined ? rest : [second, ...rest])
          : [first, second, ...rest].filter((value) => value !== undefined)
      ) as T,
    };
  }

  direction?: DynamicValue<THREE.Vector3>;
  gravity?: DynamicValue<number>;

  rotationSpeed?: DynamicValue<number>;
  rotationAttraction?: DynamicValue<number>;

  drag?: DynamicValue<number>;
  multiplier: DynamicValue<number> = 1;

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
      modifyGPU: (particle, deltaTime, context, strength) => {
        const centerPosition = this.getWorldPosition(new THREE.Vector3());
        if (context.system.simulationSpace === 'local') {
          context.system.updateWorldMatrix(true, false);
          context.system.worldToLocal(centerPosition);
        }
        const center = vec3(centerPosition);
        const toCenter = center.sub(particle.position);
        const distance = toCenter.length();
        const safeToCenter = toCenter.div(distance.max(float(Number.EPSILON)));
        let force: Node<'vec3'> = vec3(0, 0, 0);

        if (this.direction !== undefined) {
          force = force.add(evaluateDynamicVectorGPU(
            this.direction,
            particle.time,
            new THREE.Vector3(),
            particle.index,
          ));
        }

        if (this.gravity !== undefined) {
          const gravityForce = safeToCenter.mul(evaluateDynamicNumberGPU(
            this.gravity,
            particle.time,
            0,
            particle.index,
          ));

          force = force.add(
            distance.greaterThan(float(Number.EPSILON)).select(gravityForce, vec3(0, 0, 0)),
          );
        }

        if (this.rotationSpeed !== undefined) {
          const fromCenter = particle.position.sub(center);
          const tangent = cross(vec3(0, 1, 0), fromCenter);
          const tangentLength = tangent.length();
          const safeTangent = tangent.div(tangentLength.max(float(Number.EPSILON)));
          const tangentForce = safeTangent.mul(evaluateDynamicNumberGPU(
            this.rotationSpeed,
            particle.time,
            0,
            particle.index,
          ));

          force = force.add(
            tangentLength.greaterThan(float(Number.EPSILON)).select(tangentForce, vec3(0, 0, 0)),
          );
        }

        if (this.rotationAttraction !== undefined) {
          const attractionForce = safeToCenter.mul(evaluateDynamicNumberGPU(
            this.rotationAttraction,
            particle.time,
            0,
            particle.index,
          ));

          force = force.add(
            distance.greaterThan(float(Number.EPSILON)).select(attractionForce, vec3(0, 0, 0)),
          );
        }

        if (this.drag !== undefined) {
          force = force.add(
            particle.velocity.mul(evaluateDynamicNumberGPU(
              this.drag,
              particle.time,
              0,
              particle.index,
            ).negate()),
          );
        }

        const multiplier = evaluateDynamicNumberGPU(
          this.multiplier,
          particle.time,
          1,
          particle.index,
        );
        const falloff = this.getFalloffGPU(particle, context);

        particle.velocity.assign(
          particle.velocity.add(
            force
              .mul(strength)
              .mul(falloff)
              .mul(multiplier)
              .mul(deltaTime)
              .div(particle.mass.max(float(Number.EPSILON))),
          ),
        );
      },
    });

    this.direction = options.direction;
    this.gravity = options.gravity;
    this.rotationSpeed = options.rotationSpeed;
    this.rotationAttraction = options.rotationAttraction;
    this.drag = options.drag;
    this.multiplier = options.multiplier ?? this.multiplier;
  }

  protected override _modifyParticle(
    particle: Particle,
    deltaTime: number,
    particleSystem: ParticleSystem,
  ): void {
    const multiplier = evaluateDynamicNumber(this.multiplier, particle.time, particle.id);
    const force = this.getForce(particle, particleSystem);
    const mass = Number.isFinite(particle.mass) && particle.mass > 0
      ? particle.mass
      : 1;

    particle.velocity.addScaledVector(force, (multiplier * deltaTime) / mass);
  }

  getForce(particle: Particle, particleSystem?: ParticleSystem): THREE.Vector3 {
    this.updateWorldMatrix(true, false);

    const position = getParticleWorldPosition(particle, particleSystem);

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

  private getFalloffGPU(
    particle: GPUParticle,
    context: GPUParticleUpdateContext,
  ): Node<'float'> {
    const bounds = this.getLocalBounds();
    const size = bounds.getSize(new THREE.Vector3());
    const radius = size.length() * 0.5;

    if (radius <= 0) return float(0);

    const localPosition = this.getGPUParticleLocalPosition(particle, context.system);
    const ratio = localPosition.length().div(float(radius)).clamp(0, 1);

    return this.inverted
      ? ratio as Node<'float'>
      : float(1).sub(ratio) as Node<'float'>;
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
