import * as THREE from 'three';

import Module, { ModuleOptions } from '../Module';
import Particle from '../Particle';
import { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';
import { ICollisionBackend, CollisionHit } from '../interfaces/ICollisionBackend';
import ThreeCollisionBackend from '../collision/ThreeCollisionBackend';
import ParticleSystem from '../ParticleSystem';

const ACTIVE_COLLISION_BACKEND_KEY = "__rzmps_activeCollisionBackend";
const PREVIOUS_POSITION_KEY = "__rzmps_collision_prevPosition";

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

  constructor(options: Partial<CollisionOptions> = {}) {
    // Priority > 0, occurs after movement
    super((particle) => this.collide(particle), { ...options, priority: 1 });

    // Priority < 0, cache position before movement
    this.dependents = [
      new Module(
        (particle) => particle.data[PREVIOUS_POSITION_KEY] = particle.position.clone(),
        { ...options, priority: -1 }
      )
    ];

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

    this.backend?.update?.(deltaTime);
  }

  private collide(particle: Particle): void {
    if (!this.backend || !this._system) return;

    const startPosition = particle.data[PREVIOUS_POSITION_KEY] as THREE.Vector3;
    const endPosition = particle.position;

    if (startPosition.equals(endPosition)) return;

    this._system.updateWorldMatrix(true, false);

    const start = this._system.simulationSpace === 'world'
      ? startPosition.clone()
      : this._system.localToWorld(startPosition.clone());
    const end = this._system.simulationSpace === 'world'
      ? endPosition.clone()
      : this._system.localToWorld(endPosition.clone());

    const radius = this.getParticleRadius(particle);

    const hit = this.backend.collide({
      particle,
      start,
      end,
      radius,
    });

    if (!hit) return;

    // Collision callbacks
    this.collisionListeners.forEach((listener) => listener(particle, hit));
    this._system.notifyCollision(particle, hit);

    if (this._system.simulationSpace === 'local') {
      const inverseWorld = this._system.matrixWorld.clone().invert();

      hit.point = this._system.worldToLocal(hit.point.clone());

      if (hit.position) {
        hit.position = this._system.worldToLocal(hit.position.clone());
      }

      hit.normal = hit.normal
        .clone()
        .transformDirection(inverseWorld)
        .normalize();
    }

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

      this.backend.applyImpulse(hit, impulse);
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

    particle.lifetime -= particle.start.lifetime * loss;

    if (particle.lifetime <= (particle.realtime / 1000)) {
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
    particle.lifetime = 0;
  }
}

export default Collision;
