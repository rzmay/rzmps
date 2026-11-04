import type { ColorInput, Vector3Input } from '../types/ValueInput';
import * as THREE from 'three';
import type { DynamicValue } from '../types/DynamicValue';

export interface InitialParticleValues {
    // Particle members
    lifetime: DynamicValue<number>;
    speed: DynamicValue<number>;

    /** Offset from the emission shape's sampled position, in emitter-local space. */
    position: DynamicValue<THREE.Vector3>;
    /** Euler rotation in radians; a scalar applies to all axes (billboard sprites use X for roll). */
    rotation: DynamicValue<Vector3Input>;
    scale: DynamicValue<Vector3Input>;

    velocity: DynamicValue<THREE.Vector3>;
    angularVelocity: DynamicValue<Vector3Input>;
    scalarVelocity: DynamicValue<Vector3Input>;

    acceleration: DynamicValue<THREE.Vector3>;
    angularAcceleration: DynamicValue<Vector3Input>;
    scalarAcceleration: DynamicValue<Vector3Input>;

    color: DynamicValue<ColorInput>;
    alpha: DynamicValue<number>;
    mass: DynamicValue<number>;
    distortionStrength: DynamicValue<number>;
}
