import * as THREE from 'three';
import type { DynamicValue } from '../types/DynamicValue';

export interface InitialParticleValues {
    // Particle members
    lifetime: DynamicValue<number>;
    speed: DynamicValue<number>;

    /** Offset from the emission shape's sampled position, in emitter-local space. */
    position: DynamicValue<THREE.Vector3>;
    rotation: DynamicValue<THREE.Vector3>;
    scale: DynamicValue<THREE.Vector3>;

    velocity: DynamicValue<THREE.Vector3>;
    angularVelocity: DynamicValue<THREE.Vector3>;
    scalarVelocity: DynamicValue<THREE.Vector3>;

    acceleration: DynamicValue<THREE.Vector3>;
    angularAcceleration: DynamicValue<THREE.Vector3>;
    scalarAcceleration: DynamicValue<THREE.Vector3>;

    color: DynamicValue<THREE.Color>;
    alpha: DynamicValue<number>;
    mass: DynamicValue<number>;
    distortionStrength: DynamicValue<number>;
}
