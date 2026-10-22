import * as THREE from 'three';
import type { Node } from 'three/webgpu';
import {
  abs,
  float,
  If,
  max,
  sqrt,
  vec3,
} from 'three/tsl';

import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';
import type { ICollisionBackend, CollisionHit } from '../interfaces/ICollisionBackend';
import ThreeCollisionBackend from '../collision/ThreeCollisionBackend';
import ThreeGPUCollisionBackend from '../collision/ThreeGPUCollisionBackend';
import ParticleSystem from '../ParticleSystem';
import { SimulationSpace } from '../enums/SimulationSpace';
import type { GPUParticleLike, GPUParticleUpdateContext } from '../gpu/Particle';

export type CollisionListener = (particle: Particle, collision: CollisionHit) => void;

export interface CollisionOptions extends Partial<ModuleOptions> {
  /** Collision query provider; omission selects the active scene backend or built-in mesh backend. */
  backend: ICollisionBackend;
  /** Fraction of post-bounce velocity removed at contact, clamped from zero to one. */
  dampen: DynamicValue<number>;
  /** Normal rebound multiplier sampled by normalized age; defaults to 1. */
  bounce: DynamicValue<number>;
  /** Fraction of lifetime lost at contact; 1 removes the particle on collision. */
  lifetimeLoss: DynamicValue<number>;
  /** Transfers contact impulses to backends supporting dynamic bodies. Defaults to false. */
  applyImpulses: boolean;
  /** Multiplier on the collision radius derived from particle scale. Defaults to 1. */
  radiusScale: number;
  /** Removes particles below this contact speed; zero disables the lower threshold. */
  minKillSpeed: number;
  /** Removes particles above this contact speed; defaults to positive infinity. */
  maxKillSpeed: number;

  /** Synchronous callback invoked for a reported particle contact. */
  onCollision?: CollisionListener;
}

/** Predicts contacts before movement at priority -0.01; bounce, damping, impulses, and lifecycle callbacks use the selected backend. */
class Collision extends Module {
  private _backend?: ICollisionBackend;

  dampen: DynamicValue<number> = 0;
  bounce: DynamicValue<number> = 1;
  lifetimeLoss: DynamicValue<number> = 0;

  applyImpulses: boolean = false;
  radiusScale: number = 1;
  minKillSpeed: number = 0;
  maxKillSpeed: number = Number.POSITIVE_INFINITY;
  private collisionListeners: CollisionListener[] = [];

  private _system?: ParticleSystem;
  private _explicitBackend = false;
  private _ownsBackend = false;

  get backend(): ICollisionBackend | undefined {
    return this._backend;
  }

  set backend(backend: ICollisionBackend | undefined) {
    this.setBackend(backend);
  }

  /** Creates the modifier with its built-in priority and optional filtering/LOD settings. */
  constructor(options: Partial<CollisionOptions> = {}) {
    // Collisions run immediately before movement so they can predict this frame's travel segment.
    super((particle, deltaTime) => this.collide(particle, deltaTime), {
      ...options,
      priority: -0.01,
      modifyGPU: (particle, _deltaTime, context) => this.modifyGPUCollision(particle, context),
    });

    this.dampen = options.dampen ?? this.dampen;
    this.bounce = options.bounce ?? this.bounce;
    this.lifetimeLoss = options.lifetimeLoss ?? this.lifetimeLoss;

    this.applyImpulses = options.applyImpulses ?? this.applyImpulses;
    this.radiusScale = options.radiusScale ?? this.radiusScale;
    this.minKillSpeed = options.minKillSpeed ?? this.minKillSpeed;
    this.maxKillSpeed = options.maxKillSpeed ?? this.maxKillSpeed;
    this._backend = options.backend;
    this._explicitBackend = options.backend !== undefined;

    if (options.onCollision) this.collisionListeners.push(options.onCollision);
  }

  override get supportsGPU(): boolean {
    return !this.applyImpulses
      && (!this._explicitBackend || this._backend?.supportsGPU === true);
  }

  /** Select an explicit backend, or pass undefined to restore automatic selection. */
  public setBackend(backend?: ICollisionBackend): void {
    if (this._backend === backend && this._explicitBackend === (backend !== undefined)) return;

    if (this._ownsBackend) this._backend?.destroy?.();
    this._backend = backend;
    this._explicitBackend = backend !== undefined;
    this._ownsBackend = false;
  }

  public onCollision(listener: CollisionListener) {
    this.collisionListeners.push(listener);
  }

  public removeCollisionListener(listener: CollisionListener) {
    this.collisionListeners = this.collisionListeners.filter(l => l !== listener);
  }

  public notifyGPUCollision(particle: Particle, collision: CollisionHit): void {
    this.collisionListeners.forEach((listener) => listener(particle, collision));
  }

  public prepare(system: ParticleSystem, deltaTime: number) {
    this._system = system;
    if (!this._explicitBackend && system.scene) {
      const Backend = system.isGPUProcessingActive
        ? ThreeGPUCollisionBackend
        : ThreeCollisionBackend;
      if (!(this._backend instanceof Backend)) {
        if (this._ownsBackend) this._backend?.destroy?.();
        this._backend = new Backend({ world: system.scene });
        this._ownsBackend = true;
      }
    }

    this._backend?.setGPUProcessingActive?.(system.isGPUProcessingActive);
    this._backend?.update?.(deltaTime);
  }

  public hasGPUCollisionBackend(): boolean {
    return this.backend instanceof ThreeGPUCollisionBackend && this.backend.hasGeometry;
  }

  public modifyGPUCollision(
    particle: GPUParticleLike,
    context: GPUParticleUpdateContext,
  ): void {
    if (!(this.backend instanceof ThreeGPUCollisionBackend)) return;
    const radius = max(
      abs(particle.scale.x),
      max(abs(particle.scale.y), abs(particle.scale.z)),
    ).mul(float(0.5 * (this.radiusScale ?? 1)));
    const step = context.deltaTimeNode.mul(particle.speed);
    const localStart = particle.position;
    const localVelocity = particle.velocity;
    const localEnd = localStart.add(localVelocity.mul(step));
    const start = this.gpuPointToWorld(localStart, context.system);
    const end = this.gpuPointToWorld(localEnd, context.system);
    const hit = this.backend.queryCapsule(start, end, radius);
    const found = hit.get('found') as Node<'bool'>;
    const worldCapsulePoint = hit.get('capsulePoint') as Node<'vec3'>;
    const worldNormal = hit.get('normal') as Node<'vec3'>;
    const distance = sqrt(hit.get('distanceSq') as Node<'float'>);
    const correctedWorldPosition = worldCapsulePoint.add(
      worldNormal.mul(radius.sub(distance).max(0)),
    );
    this.applyGPUCollisionHit(
      particle,
      context,
      found,
      this.gpuPointToSimulationSpace(correctedWorldPosition, context.system),
      this.gpuDirectionToSimulationSpace(worldNormal, context.system),
    );
  }

  public detectGPUCollision(
    particle: GPUParticleLike,
    context: GPUParticleUpdateContext,
  ): void {
    if (!(this.backend instanceof ThreeGPUCollisionBackend) || !context.collisionEventWriter) return;
    const radius = max(
      abs(particle.scale.x),
      max(abs(particle.scale.y), abs(particle.scale.z)),
    ).mul(float(0.5 * (this.radiusScale ?? 1)));
    const step = context.deltaTimeNode.mul(particle.speed);
    const localStart = particle.position;
    const localVelocity = particle.velocity;
    const start = this.gpuPointToWorld(localStart, context.system);
    const end = this.gpuPointToWorld(
      localStart.add(localVelocity.mul(step)),
      context.system,
    );
    const velocity = this.gpuDirectionToWorld(localVelocity, context.system);
    const mass = particle.mass.greaterThan(float(0)).select(
      particle.mass,
      float(1),
    ) as Node<'float'>;
    const hit = this.backend.queryCapsule(start, end, radius);
    const found = hit.get('found') as Node<'bool'>;
    const worldPoint = hit.get('point') as Node<'vec3'>;
    const worldCapsulePoint = hit.get('capsulePoint') as Node<'vec3'>;
    const worldNormal = hit.get('normal') as Node<'vec3'>;
    const distance = sqrt(hit.get('distanceSq') as Node<'float'>);
    const correctedWorldPosition = worldCapsulePoint.add(
      worldNormal.mul(radius.sub(distance).max(0)),
    );
    const normalVelocity = float(velocity.dot(worldNormal));
    const impulse = worldNormal.mul(normalVelocity.min(0).abs().mul(mass));

    If(found, () => {
      context.collisionEventWriter!.emit(
        particle,
        this.gpuPointToSimulationSpace(worldPoint, context.system),
        this.gpuPointToSimulationSpace(correctedWorldPosition, context.system),
        this.gpuDirectionToSimulationSpace(worldNormal, context.system).normalize(),
        this.gpuDirectionToSimulationSpace(impulse, context.system),
      );
    });
  }

  public resolveGPUCollision(
    particle: GPUParticleLike,
    context: GPUParticleUpdateContext,
    hitPosition: Node<'vec3'>,
    sampledNormal: Node<'vec3'>,
  ): void {
    const hitNormal = sampledNormal.normalize();

    particle.position.assign(hitPosition);

    const bounce = this.gpuParameters.number(
      'bounce', () => this.bounce, particle.time, 1, particle.index,
    ).clamp(0, 1);
    const dampen = this.gpuParameters.number(
      'dampen', () => this.dampen, particle.time, 0, particle.index,
    ).clamp(0, 1);
    const normalSpeed = particle.velocity.dot(hitNormal);
    const normalVelocity = hitNormal.mul(normalSpeed);
    const tangentVelocity = particle.velocity.sub(normalVelocity);
    const resolvedVelocity = tangentVelocity
      .add(normalVelocity.mul(bounce.negate()))
      .mul(float(1).sub(dampen));

    particle.velocity.assign(
      normalSpeed.lessThan(float(0)).select(resolvedVelocity, particle.velocity),
    );

    const lifetimeLoss = this.gpuParameters.number(
      'lifetimeLoss',
      () => this.lifetimeLoss,
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
  }

  public override cleanup(): void {
    if (this._ownsBackend) this._backend?.destroy?.();
    if (!this._explicitBackend) this._backend = undefined;
    this._ownsBackend = false;
    super.cleanup();
  }

  private applyGPUCollisionHit(
    particle: GPUParticleLike,
    context: GPUParticleUpdateContext,
    hit: Node<'bool'>,
    hitPosition: Node<'vec3'>,
    sampledNormal: Node<'vec3'>,
  ): void {
    If(hit, () => {
      this.resolveGPUCollision(particle, context, hitPosition, sampledNormal);
    });
  }

  private gpuPointToWorld(
    point: Node<'vec3'>,
    system: ParticleSystem,
  ): Node<'vec3'> {
    if (system.simulationSpace === SimulationSpace.World) return point;

    system.updateWorldMatrix(true, false);
    return transformPointGPU(point, system.matrixWorld);
  }

  private gpuPointToSimulationSpace(
    point: Node<'vec3'>,
    system: ParticleSystem,
  ): Node<'vec3'> {
    if (system.simulationSpace === SimulationSpace.World) return point;

    system.updateWorldMatrix(true, false);
    return transformPointGPU(point, system.matrixWorld.clone().invert());
  }

  private gpuDirectionToWorld(
    vector: Node<'vec3'>,
    system: ParticleSystem,
  ): Node<'vec3'> {
    if (system.simulationSpace === SimulationSpace.World) return vector;

    system.updateWorldMatrix(true, false);
    return transformDirectionGPU(vector, system.matrixWorld);
  }

  private gpuDirectionToSimulationSpace(
    vector: Node<'vec3'>,
    system: ParticleSystem,
  ): Node<'vec3'> {
    if (system.simulationSpace === SimulationSpace.World) return vector;

    system.updateWorldMatrix(true, false);
    return transformDirectionGPU(vector, system.matrixWorld.clone().invert());
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

}

function transformPointGPU(point: Node<'vec3'>, matrix: THREE.Matrix4): Node<'vec3'> {
  const e = matrix.elements;

  return vec3(
    point.x.mul(e[0]).add(point.y.mul(e[4])).add(point.z.mul(e[8])).add(e[12]),
    point.x.mul(e[1]).add(point.y.mul(e[5])).add(point.z.mul(e[9])).add(e[13]),
    point.x.mul(e[2]).add(point.y.mul(e[6])).add(point.z.mul(e[10])).add(e[14]),
  ) as Node<'vec3'>;
}

function transformDirectionGPU(vector: Node<'vec3'>, matrix: THREE.Matrix4): Node<'vec3'> {
  const e = matrix.elements;

  return vec3(
    vector.x.mul(e[0]).add(vector.y.mul(e[4])).add(vector.z.mul(e[8])),
    vector.x.mul(e[1]).add(vector.y.mul(e[5])).add(vector.z.mul(e[9])),
    vector.x.mul(e[2]).add(vector.y.mul(e[6])).add(vector.z.mul(e[10])),
  ) as Node<'vec3'>;
}

export default Collision;
