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
import type { GPUParticleLike, GPUParticleUpdateContext } from '../gpu/Particle';
import type { GPUSpatialEffectType } from '../gpu/SpatialEffectRegistry';

export interface ForceFieldOptions extends SpatialEffectOptions {
    direction: DynamicValue<THREE.Vector3>;
    gravity: DynamicValue<number>;
    rotationSpeed: DynamicValue<number>;
    rotationAttraction: DynamicValue<number>;
    drag: DynamicValue<number>;
    multiplier: DynamicValue<number>;
    radialFalloff: boolean;
    radialFalloffEasing: (falloff: number) => number;
    tags: StrictMultiple<Tag>;
}

type BoxGeometryArgs = ConstructorParameters<typeof THREE.BoxGeometry>;
type SphereGeometryArgs = ConstructorParameters<typeof THREE.SphereGeometry>;
type ConeGeometryArgs = ConstructorParameters<typeof THREE.ConeGeometry>;
type TorusGeometryArgs = ConstructorParameters<typeof THREE.TorusGeometry>;

class ParticleForceField extends SpatialEffect {
  static readonly GPU_SPATIAL_TYPE: GPUSpatialEffectType = {
    key: 'rzmps.particle-force-field.v1',
    parameterLayout: {
      id: 'rzmps.particle-force-field.params.v1',
      fields: [
        ...SpatialEffect.GPU_INFLUENCE_FIELDS,
        { name: 'center', type: 'vec3' },
        { name: 'direction', type: 'vec3' },
        { name: 'rotationAxis', type: 'vec3' },
        { name: 'gravity', type: 'float' },
        { name: 'rotationSpeed', type: 'float' },
        { name: 'rotationAttraction', type: 'float' },
        { name: 'drag', type: 'float' },
        { name: 'multiplier', type: 'float' },
      ],
    },
    testGPU: (particle, _context, params) => SpatialEffect.testGPUInfluence(particle, params),
    modifyGPU(particle, deltaTime, _context, params, strength) {
      const center = params.vec3('center');
      const toCenter = center.sub(particle.position);
      const distance = toCenter.length();
      const safeToCenter = toCenter.div(distance.max(float(Number.EPSILON)));
      let force: Node<'vec3'> = params.vec3('direction');

      const gravity = params.float('gravity');
      const gravityForce = safeToCenter.mul(gravity);
      force = force.add(
        distance.greaterThan(float(Number.EPSILON)).select(gravityForce, vec3(0, 0, 0)),
      );

      const fromCenter = particle.position.sub(center);
      const tangent = cross(params.vec3('rotationAxis'), fromCenter);
      const tangentLength = tangent.length();
      const safeTangent = tangent.div(tangentLength.max(float(Number.EPSILON)));
      const tangentForce = safeTangent.mul(params.float('rotationSpeed'));
      force = force.add(
        tangentLength.greaterThan(float(Number.EPSILON)).select(tangentForce, vec3(0, 0, 0)),
      );

      const attractionForce = safeToCenter.mul(params.float('rotationAttraction'));
      force = force.add(
        distance.greaterThan(float(Number.EPSILON)).select(attractionForce, vec3(0, 0, 0)),
      );

      force = force.add(particle.velocity.mul(params.float('drag').negate()));

      const mass = particle.mass.greaterThan(float(0)).select(
        particle.mass,
        float(1),
      ) as Node<'float'>;

      particle.velocity.assign(
        particle.velocity.add(
          force
            .mul(strength)
            .mul(params.float('multiplier'))
            .mul(deltaTime)
            .div(mass),
        ),
      );
    },
  };

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
  radialFalloff = false;
  radialFalloffEasing: (falloff: number) => number;

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
        this.updateWorldMatrix(true, false);
        const directionMatrix = new THREE.Matrix4().makeRotationFromQuaternion(
          this.getWorldQuaternion(new THREE.Quaternion()),
        );
        if (context.system.simulationSpace === 'local') {
          context.system.updateWorldMatrix(true, false);
          directionMatrix.premultiply(new THREE.Matrix4().makeRotationFromQuaternion(
            context.system.getWorldQuaternion(new THREE.Quaternion()).invert(),
          ));
        }
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
          force = force.add(transformDirectionGPU(
            evaluateDynamicVectorGPU(
              this.direction,
              particle.time,
              new THREE.Vector3(),
              particle.index,
            ),
            directionMatrix,
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
          const tangent = cross(
            transformDirectionGPU(vec3(0, 1, 0), directionMatrix),
            fromCenter,
          );
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
        const falloff = this.radialFalloff
          ? this.getFalloffGPU(particle, context)
          : float(1);
        const mass = particle.mass.greaterThan(float(0)).select(
          particle.mass,
          float(1),
        ) as Node<'float'>;

        particle.velocity.assign(
          particle.velocity.add(
            force
              .mul(strength)
              .mul(falloff)
              .mul(multiplier)
              .mul(deltaTime)
              .div(mass),
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
    this.radialFalloffEasing = options.radialFalloffEasing ?? ((falloff: number) => falloff);
    this.radialFalloff = options.radialFalloff ?? Boolean(options.radialFalloffEasing);
    if (
      this.supportsParameterizedGPUInfluence
      && this.canBatchGPUInfluence()
      && this.canUseStaticGPUSpatialType()
    ) {
      this.gpuSpatialType = ParticleForceField.GPU_SPATIAL_TYPE;
      this.writeGPUParameters = (target, offset, system) => {
        this.writeStaticGPUParameters(target, offset, system);
      };
    }
  }

  private canUseStaticGPUSpatialType(): boolean {
    return (this.direction === undefined || this.direction instanceof THREE.Vector3)
      && (this.gravity === undefined || typeof this.gravity === 'number')
      && (this.rotationSpeed === undefined || typeof this.rotationSpeed === 'number')
      && (this.rotationAttraction === undefined || typeof this.rotationAttraction === 'number')
      && (this.drag === undefined || typeof this.drag === 'number')
      && typeof this.multiplier === 'number'
      && !this.radialFalloff;
  }

  writeStaticGPUParameters(target: Float32Array, offset: number, system: ParticleSystem): void {
    this.writeGPUInfluenceParameters(target, offset, system);
    offset += SpatialEffect.GPU_INFLUENCE_ALIGNED_SIZE;
    const center = this.getWorldPosition(new THREE.Vector3());
    if (system.simulationSpace === 'local') {
      system.updateWorldMatrix(true, false);
      system.worldToLocal(center);
    }

    const direction = this.direction instanceof THREE.Vector3 ? this.direction : new THREE.Vector3();
    const effectRotation = this.getWorldQuaternion(new THREE.Quaternion());
    direction.applyQuaternion(effectRotation);
    const rotationAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(effectRotation);
    if (system.simulationSpace === 'local') {
      const inverseSystemRotation = system.getWorldQuaternion(new THREE.Quaternion()).invert();
      direction.applyQuaternion(inverseSystemRotation);
      rotationAxis.applyQuaternion(inverseSystemRotation);
    }
    target[offset] = center.x;
    target[offset + 1] = center.y;
    target[offset + 2] = center.z;
    target[offset + 3] = 0;
    target[offset + 4] = direction.x;
    target[offset + 5] = direction.y;
    target[offset + 6] = direction.z;
    target[offset + 7] = 0;
    target[offset + 8] = rotationAxis.x;
    target[offset + 9] = rotationAxis.y;
    target[offset + 10] = rotationAxis.z;
    target[offset + 11] = 0;
    target[offset + 12] = typeof this.gravity === 'number' ? this.gravity : 0;
    target[offset + 13] = typeof this.rotationSpeed === 'number' ? this.rotationSpeed : 0;
    target[offset + 14] = typeof this.rotationAttraction === 'number' ? this.rotationAttraction : 0;
    target[offset + 15] = typeof this.drag === 'number' ? this.drag : 0;
    target[offset + 16] = typeof this.multiplier === 'number' ? this.multiplier : 1;
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

    if (this.radialFalloff) force.multiplyScalar(this.getFalloff(position));

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
    particle: GPUParticleLike,
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

    const falloff = this.inverted
      ? Math.min(Math.max(ratio, 0), 1)
      : 1 - Math.min(ratio, 1);

    return this.radialFalloffEasing(falloff);
  }
}

export default ParticleForceField;

function transformDirectionGPU(vector: Node<'vec3'>, matrix: THREE.Matrix4): Node<'vec3'> {
  const elements = matrix.elements;
  return vec3(
    vector.x.mul(elements[0]).add(vector.y.mul(elements[4])).add(vector.z.mul(elements[8])),
    vector.x.mul(elements[1]).add(vector.y.mul(elements[5])).add(vector.z.mul(elements[9])),
    vector.x.mul(elements[2]).add(vector.y.mul(elements[6])).add(vector.z.mul(elements[10])),
  ) as Node<'vec3'>;
}
