import * as THREE from 'three';
import { DynamicValue } from '../types/DynamicValue';

export interface InitialParticleValues {
    // Particle members
    lifetime: DynamicValue<number>;
    speed: DynamicValue<number>;

    position: DynamicValue<THREE.Vector3>;
    rotation: DynamicValue<THREE.Vector3>;
    scale: DynamicValue<THREE.Vector3>;

    velocity: DynamicValue<THREE.Vector3>;
    angularVelocity: DynamicValue<THREE.Vector3>;
    scalarVelocity: DynamicValue<THREE.Vector3>;

    acceleration: DynamicValue<THREE.Vector3>;
    angularAcceleration: DynamicValue<THREE.Vector3>;
    scalarAcceleration: DynamicValue<THREE.Vector3>;

    color: DynamicValue<THREE.Color>
    alpha: DynamicValue<number>;
    mass: DynamicValue<number>;
}
