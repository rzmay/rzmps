import * as THREE from 'three';
import { StorageBufferAttribute } from 'three/webgpu';
import { float, If, storage, uint } from 'three/tsl';

import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';
import { evaluateDynamicNumberGPU } from '../helpers/evaluateDynamicGPU';
import type { ICollisionBackend, CollisionHit } from '../interfaces/ICollisionBackend';
import ThreeCollisionBackend from '../collision/ThreeCollisionBackend';
import ParticleSystem from '../ParticleSystem';

const ACTIVE_COLLISION_BACKEND_KEY = "__rzmps_activeCollisionBackend";
export type CollisionListener = (particle: Particle, collision: CollisionHit) => void;

export interface CollisionOptions extends Partial<ModuleOptions> {
  backend: ICollisionBackend;
  dampen: DynamicValue<number>;
  bounce: DynamicValue<number>;
  lifetimeLoss: DynamicValue<number>;
  applyImpulses: boolean;
  radiusScale: number;
  minKillSpeed: number;
  maxKillSpeed: number;

  onCollision?: CollisionListener;
}

class Collision extends Module {
  backend?: ICollisionBackend;

  dampen: DynamicValue<number> = 0;
  bounce: DynamicValue<number> = 1;
  lifetimeLoss: DynamicValue<number> = 0;

  applyImpulses: boolean = false;
  radiusScale: number = 1;
  minKillSpeed: number = 0;
  maxKillSpeed: number = Number.POSITIVE_INFINITY;

  private collisionListeners: CollisionListener[] = [];

  private _system?: ParticleSystem;
  private collisionHitSamples = new Uint32Array(1);
  private collisionPositionSamples = new Float32Array(3);
  private collisionNormalSamples = new Float32Array(3);
  private collisionHitAttribute = new StorageBufferAttribute(this.collisionHitSamples, 1);
  private collisionPositionAttribute = new StorageBufferAttribute(this.collisionPositionSamples, 3);
  private collisionNormalAttribute = new StorageBufferAttribute(this.collisionNormalSamples, 3);

  constructor(options: Partial<CollisionOptions> = {}) {
    // Collisions run immediately before movement so they can predict this frame's travel segment.
    super((particle, deltaTime) => this.collide(particle, deltaTime), {
      ...options,
      priority: -0.01,
      modifyGPU: (particle, _deltaTime, context) => {
        const capacity = Math.max(1, context.buffers.capacity);
        const hit = storage(this.collisionHitAttribute, 'uint', capacity).element(particle.index);
        const hitPosition = storage(this.collisionPositionAttribute, 'vec3', capacity).element(particle.index);
        const hitNormal = storage(this.collisionNormalAttribute, 'vec3', capacity).element(particle.index).normalize();

        If(hit.equal(uint(1)), () => {
          particle.position.assign(hitPosition);

          const bounce = evaluateDynamicNumberGPU(this.bounce ?? 1, particle.time, 1, particle.index).clamp(0, 1);
          const dampen = evaluateDynamicNumberGPU(this.dampen ?? 0, particle.time, 0, particle.index).clamp(0, 1);
          const normalSpeed = particle.velocity.dot(hitNormal);
          const normalVelocity = hitNormal.mul(normalSpeed);
          const tangentVelocity = particle.velocity.sub(normalVelocity);
          const resolvedVelocity = tangentVelocity
            .add(normalVelocity.mul(bounce.negate()))
            .mul(float(1).sub(dampen));

          particle.velocity.assign(
            normalSpeed.lessThan(float(0)).select(resolvedVelocity, particle.velocity),
          );

          const lifetimeLoss = evaluateDynamicNumberGPU(
            this.lifetimeLoss ?? 0,
            particle.time,
            0,
            particle.index,
          ).clamp(0, 1);

          particle.realtime.assign(
            particle.realtime.add(particle.lifetime.mul(lifetimeLoss).mul(1000)),
          );

          const speed = particle.velocity.length();
          if (this.minKillSpeed > 0) {
            If(speed.lessThan(this.minKillSpeed), () => {
              particle.realtime.assign(particle.lifetime.mul(1000).add(1));
            });
          }
          if (Number.isFinite(this.maxKillSpeed)) {
            If(speed.greaterThan(this.maxKillSpeed), () => {
              particle.realtime.assign(particle.lifetime.mul(1000).add(1));
            });
          }
        });
      },
    });

    this.dampen = options.dampen ?? this.dampen;
    this.bounce = options.bounce ?? this.bounce;
    this.lifetimeLoss = options.lifetimeLoss ?? this.lifetimeLoss;

    this.applyImpulses = options.applyImpulses ?? this.applyImpulses;
    this.radiusScale = options.radiusScale ?? this.radiusScale;
    this.minKillSpeed = options.minKillSpeed ?? this.minKillSpeed;
    this.maxKillSpeed = options.maxKillSpeed ?? this.maxKillSpeed;

    if (options.onCollision) this.collisionListeners.push(options.onCollision);
  }

  public onCollision(listener: CollisionListener) {
    this.collisionListeners.push(listener);
  }

  public removeCollisionListener(listener: CollisionListener) {
    this.collisionListeners = this.collisionListeners.filter(l => l !== listener);
  }

  public prepare(system: ParticleSystem, deltaTime: number) {
    this._system = system;

    if (system.scene) {
      // Check if backend exists or needs to be updated
      const cachedBackend = system.scene.userData[ACTIVE_COLLISION_BACKEND_KEY];

      if (!this.backend || this.backend != cachedBackend) {
        this.backend = cachedBackend
          ?? new ThreeCollisionBackend({ world: system.scene });

        system.scene.userData[ACTIVE_COLLISION_BACKEND_KEY] =
          this.backend;
      }
    }

    this.backend?.setGPUProcessingActive?.(system.isGPUProcessingActive);
    this.backend?.update?.(deltaTime);

    if (system.isGPUProcessingActive) {
      this.sampleCollisions(system, deltaTime);
    }
  }

  private collide(particle: Particle, deltaTime: number): void {
    if (!this.backend || !this._system) return;

    const startPosition = particle.position.clone();
    const endPosition = particle.position.clone()
      .addScaledVector(particle.velocity, deltaTime * particle.speed);

    if (startPosition.equals(endPosition)) return;

    this._system.updateWorldMatrix(true, false);

    const start = this._system.simulationSpace === 'world'
      ? startPosition.clone()
      : this._system.localToWorld(startPosition.clone());
    const end = this._system.simulationSpace === 'world'
      ? endPosition.clone()
      : this._system.localToWorld(endPosition.clone());
    const velocity = this._system.simulationSpace === 'world'
      ? particle.velocity.clone()
      : this.localDirectionToWorld(particle.velocity);

    const radius = this.getParticleRadius(particle);

    const hit = this.backend.collide({
      particle,
      start,
      end,
      velocity,
      radius,
    });

    if (!hit) return;

    const worldHit = this.cloneHit(hit);

    if (this._system.simulationSpace === 'local') {
      const inverseWorld = this._system.matrixWorld.clone().invert();
      const impulseLength = hit.impulse.length();

      hit.point = this._system.worldToLocal(hit.point.clone());

      if (hit.position) {
        hit.position = this._system.worldToLocal(hit.position.clone());
      }

      hit.normal = hit.normal
        .clone()
        .transformDirection(inverseWorld)
        .normalize();

      if (impulseLength > 0) {
        hit.impulse = hit.impulse
          .clone()
          .transformDirection(inverseWorld)
          .multiplyScalar(impulseLength);
      }
    }

    // Collision callbacks
    this.collisionListeners.forEach((listener) => listener(particle, hit));
    this._system.notifyCollision(particle, hit);

    this.resolvePosition(particle, hit, radius);

    // Store previous veolocity for impulses
    const incomingVelocity = particle.velocity.clone();
    this.resolveVelocity(particle, hit);

    this.resolveLifetime(particle);

    if (
      particle.mass > 0
      && this.applyImpulses
      && this.backend.applyImpulse
    ) {
      const impulse = particle.velocity
        .clone()
        .sub(incomingVelocity)
        .multiplyScalar(-particle.mass);

      const backendImpulse = this._system.simulationSpace === 'world'
        ? impulse
        : this.localDirectionToWorld(impulse);

      this.backend.applyImpulse(worldHit, backendImpulse);
    }

    const speed = particle.velocity.length();

    if (
      speed < this.minKillSpeed
      || speed > this.maxKillSpeed
    ) {
      this.killParticle(particle);
    }
  }

  private resolvePosition(
    particle: Particle,
    hit: CollisionHit,
    radius: number,
  ): void {
    if (hit.position) {
      particle.position.copy(hit.position);
      return;
    }

    particle.position
      .copy(hit.point)
      .addScaledVector(hit.normal, radius);
  }

  private resolveVelocity(
    particle: Particle,
    hit: CollisionHit,
  ): void {
    const normal = hit.normal.clone().normalize();

    const bounce = THREE.MathUtils.clamp(
      evaluateDynamicNumber(
        this.bounce ?? 1,
        particle.time,
        particle.id,
      ),
      0,
      1,
    );

    const dampen = THREE.MathUtils.clamp(
      evaluateDynamicNumber(
        this.dampen ?? 0,
        particle.time,
        particle.id,
      ),
      0,
      1,
    );

    const normalSpeed = particle.velocity.dot(normal);

    /*
     * Don't bounce if we're already travelling away
     * from the surface.
     */
    if (normalSpeed >= 0) return;

    const normalVelocity = normal
      .clone()
      .multiplyScalar(normalSpeed);

    const tangentVelocity = particle.velocity
      .clone()
      .sub(normalVelocity);

    particle.velocity
      .copy(tangentVelocity)
      .addScaledVector(normalVelocity, -bounce)
      .multiplyScalar(1 - dampen);
  }

  private resolveLifetime(
    particle: Particle,
  ): void {
    const loss = THREE.MathUtils.clamp(
      evaluateDynamicNumber(
        this.lifetimeLoss ?? 0,
        particle.time,
        particle.id,
      ),
      0,
      1,
    );

    if (loss === 0) return;

    particle.realtime += particle.lifetime * loss * 1000;

    if (particle.realtime >= particle.lifetime * 1000) {
      this.killParticle(particle);
    }
  }

  private getParticleRadius(particle: Particle): number {
    const size = Math.max(
      Math.abs(particle.scale.x),
      Math.abs(particle.scale.y),
      Math.abs(particle.scale.z),
    );

    return size * 0.5 * (this.radiusScale ?? 1);
  }

  private killParticle(particle: Particle): void {
    particle.realtime = Math.max(particle.realtime, particle.lifetime * 1000 + 1);
  }

  private cloneHit(hit: CollisionHit): CollisionHit {
    return {
      ...hit,
      point: hit.point.clone(),
      normal: hit.normal.clone(),
      impulse: hit.impulse.clone(),
      position: hit.position?.clone(),
    };
  }

  private localDirectionToWorld(vector: THREE.Vector3): THREE.Vector3 {
    const length = vector.length();

    if (length === 0 || !this._system) return vector.clone();

    return vector
      .clone()
      .transformDirection(this._system.matrixWorld)
      .multiplyScalar(length);
  }

  private sampleCollisions(system: ParticleSystem, deltaTime: number): void {
    const capacity = Math.max(1, system.maxParticles, system.particles.length);

    if (this.collisionHitSamples.length < capacity) {
      this.collisionHitSamples = new Uint32Array(capacity);
      this.collisionPositionSamples = new Float32Array(capacity * 3);
      this.collisionNormalSamples = new Float32Array(capacity * 3);
      this.collisionHitAttribute = new StorageBufferAttribute(this.collisionHitSamples, 1);
      this.collisionPositionAttribute = new StorageBufferAttribute(this.collisionPositionSamples, 3);
      this.collisionNormalAttribute = new StorageBufferAttribute(this.collisionNormalSamples, 3);
    }

    this.collisionHitSamples.fill(0);
    this.collisionPositionSamples.fill(0);
    this.collisionNormalSamples.fill(0);

    system.particles.forEach((particle, index) => {
      const sample = this.sampleCollision(particle, deltaTime);
      if (!sample) return;

      const { hit, position } = sample;
      const offset = index * 3;

      this.collisionHitSamples[index] = 1;
      this.collisionPositionSamples[offset] = position.x;
      this.collisionPositionSamples[offset + 1] = position.y;
      this.collisionPositionSamples[offset + 2] = position.z;
      this.collisionNormalSamples[offset] = hit.normal.x;
      this.collisionNormalSamples[offset + 1] = hit.normal.y;
      this.collisionNormalSamples[offset + 2] = hit.normal.z;

      this.collisionListeners.forEach((listener) => listener(particle, hit));
      system.notifyCollision(particle, hit);
    });

    this.collisionHitAttribute.needsUpdate = true;
    this.collisionPositionAttribute.needsUpdate = true;
    this.collisionNormalAttribute.needsUpdate = true;
  }

  private sampleCollision(
    particle: Particle,
    deltaTime: number,
  ): { hit: CollisionHit; position: THREE.Vector3 } | null {
    if (!this.backend || !this._system) return null;

    this._system.updateWorldMatrix(true, false);

    const localStart = particle.position.clone();
    const localEnd = particle.position.clone()
      .addScaledVector(particle.velocity, deltaTime * particle.speed);

    if (localStart.equals(localEnd)) return null;

    const start = this._system.simulationSpace === 'world'
      ? localStart.clone()
      : this._system.localToWorld(localStart.clone());
    const end = this._system.simulationSpace === 'world'
      ? localEnd.clone()
      : this._system.localToWorld(localEnd.clone());
    const velocity = this._system.simulationSpace === 'world'
      ? particle.velocity.clone()
      : this.localDirectionToWorld(particle.velocity);

    const radius = this.getParticleRadius(particle);

    const hit = this.backend.collide({
      particle,
      start,
      end,
      velocity,
      radius,
    });

    if (!hit) return null;

    if (this._system.simulationSpace === 'local') {
      const inverseWorld = this._system.matrixWorld.clone().invert();
      const impulseLength = hit.impulse.length();

      hit.point = this._system.worldToLocal(hit.point.clone());

      if (hit.position) {
        hit.position = this._system.worldToLocal(hit.position.clone());
      }

      hit.normal = hit.normal
        .clone()
        .transformDirection(inverseWorld)
        .normalize();

      if (impulseLength > 0) {
        hit.impulse = hit.impulse
          .clone()
          .transformDirection(inverseWorld)
          .multiplyScalar(impulseLength);
      }
    }

    const position = hit.position
      ? hit.position.clone()
      : hit.point.clone().addScaledVector(hit.normal, radius);

    return { hit, position };
  }
}

export default Collision;
