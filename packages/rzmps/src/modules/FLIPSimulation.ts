import * as THREE from 'three';
import Particle from '../Particle';
import ParticleSystem from '../ParticleSystem';
import FluidSimulation, { type FluidSimulationOptions } from './FluidSimulation';
import tagsIntersect from '../helpers/tagsIntersect';

export interface FLIPSimulationOptions extends FluidSimulationOptions {
  particles: Particle[];
  picRatio: number;
  advectParticles: boolean;
}

class FLIPSimulation extends FluidSimulation {
  particles: Particle[];
  picRatio: number;
  advectParticlesEnabled: boolean;
  mass: Float32Array;
  oldVelocity: Float32Array;

  private cellCoordinate = new THREE.Vector3();
  private picVelocity = new THREE.Vector3();
  private flipDelta = new THREE.Vector3();
  private flipVelocity = new THREE.Vector3();

  constructor(options: Partial<FLIPSimulationOptions> = {}) {
    super(options, (particle) => this.gridToParticle(particle));
    this.particles = options.particles ?? [];
    this.picRatio = THREE.MathUtils.clamp(options.picRatio ?? 0.05, 0, 1);
    this.advectParticlesEnabled = options.advectParticles ?? false;
    this.mass = new Float32Array(this.cellCount);
    this.oldVelocity = new Float32Array(this.cellCount * 3);
  }

  update(dt: number, particleSystem?: ParticleSystem): void {
    if (particleSystem) {
      this.particles = particleSystem.particles.filter((particle) => (
        (!this.tags || tagsIntersect(this.tags, particle.tags ?? []))
        && this.condition(particle)
      ));
    }

    this.particleToGrid();
    this.oldVelocity.set(this.velocity);
    this.applyExternalForces(dt);
    this.calculateDivergence();
    this.solvePressure();
    this.projectVelocity();

    if (this.advectParticlesEnabled) this.advectParticles(dt);
  }

  particleToGrid(): void {
    this.mass.fill(0);
    this.velocity.fill(0);

    this.particles.forEach((particle) => {
      this.worldToCell(particle.position, this.cellCoordinate);

      const index = this.index(this.cellCoordinate.x, this.cellCoordinate.y, this.cellCoordinate.z);
      const velocityIndex = index * 3;
      const mass = Math.max(particle.mass, 0);

      this.mass[index] += mass;
      this.velocity[velocityIndex] += particle.velocity.x * mass;
      this.velocity[velocityIndex + 1] += particle.velocity.y * mass;
      this.velocity[velocityIndex + 2] += particle.velocity.z * mass;
    });

    for (let index = 0; index < this.cellCount; index += 1) {
      if (this.mass[index] <= 0) continue;

      const velocityIndex = index * 3;

      this.velocity[velocityIndex] /= this.mass[index];
      this.velocity[velocityIndex + 1] /= this.mass[index];
      this.velocity[velocityIndex + 2] /= this.mass[index];
    }
  }

  gridToParticle(particle: Particle): void {
    this.sampleVelocity(particle.position, this.picVelocity);
    this.sampleVectorField(this.oldVelocity, particle.position, this.flipDelta);
    this.flipDelta.sub(this.picVelocity).multiplyScalar(-1);
    this.flipVelocity.copy(particle.velocity).add(this.flipDelta);
    particle.velocity.copy(this.flipVelocity.lerp(this.picVelocity, this.picRatio));
  }

  advectParticles(dt: number): void {
    this.particles.forEach((particle) => {
      this.sampleVelocity(particle.position, this.picVelocity);
      particle.position.addScaledVector(this.picVelocity, dt);
      particle.position.clamp(this.bounds.min, this.bounds.max);
    });
  }
}

export default FLIPSimulation;
