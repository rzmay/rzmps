import * as THREE from 'three';
import Particle from '../Particle';

export interface IParticleForceField {
    getForce(particle: Particle, deltaTime: number): THREE.Vector3;
}
