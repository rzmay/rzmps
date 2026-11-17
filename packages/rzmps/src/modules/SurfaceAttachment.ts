import * as THREE from 'three';
import type { Node } from 'three/webgpu';
import { If, float, uniform, vec3, uint } from 'three/tsl';
import Module, { type ModuleOptions, type ModuleExecutionContext } from '../core/Module';
import type Particle from '../core/Particle';
import type ParticleSystem from '../core/ParticleSystem';
import type { GPUParticleLike } from '../simulation/gpu/Particle';
import type { ParticleSpatialGridRenderer } from '../spatial/structures/ParticleSpatialGrid';
import type { SurfaceQuery, GPUSurfaceQuery, GPUSurfaceSample } from '../spatial/surfaces/surfaceSample.types';
import { createMeshSurfaceQuery } from '../spatial/surfaces/meshSurface.utils';
import ThreeGPUCollisionBackend from '../collision/ThreeGPUCollisionBackend';
import { transformDirectionGPU, transformPointGPU } from '../simulation/gpu/transforms.utils';

export interface SurfaceAttachmentOptions extends Partial<ModuleOptions> {
  /** Ordinary mesh/subtree, or the owner retained by custom sampling closures. */
  surface?: object;
  /** World-space CPU query; required for CPU use of a custom implicit surface. */
  sampler?: SurfaceQuery;
  /** World-space GPU query. Bound method references are supported; no CPU readback is performed. */
  samplerGPU?: GPUSurfaceQuery;
  /** Desired outward offset in world units. Defaults to 0. */
  offset?: number;
  /** Normal restoring rate in inverse seconds. Defaults to 60; zero disables restoration. */
  adhesion?: number;
  /** Surface-relative tangential drag in inverse seconds. Defaults to 2. Zero preserves sliding. */
  tangentialDrag?: number;
  /** Fraction of physical surface velocity followed. Defaults to 1. */
  inheritSurfaceVelocity?: number;
  /** Suspend attachment beyond this absolute offset error in world units. Defaults to Infinity. */
  detachDistance?: number;
  /** Kill instead of leaving particles ballistic when the sample is invalid or too far away. Defaults to false. */
  killOnDetach?: boolean;
}

/** Persistent post-integration surface constraint. It never owns emission, rendering, or liquid state. */
export default class SurfaceAttachment extends Module {
  surface?: object;
  sampler?: SurfaceQuery;
  samplerGPU?: GPUSurfaceQuery;
  offset: number;
  adhesion: number;
  tangentialDrag: number;
  inheritSurfaceVelocity: number;
  detachDistance: number;
  killOnDetach: boolean;
  private readonly mesh = createMeshSurfaceQuery();
  private backend?: ThreeGPUCollisionBackend;
  private backendVersion = '';
  private samplerIdentity?: GPUSurfaceQuery;
  private readonly toWorld = uniform(new THREE.Matrix4());
  private readonly toSimulation = uniform(new THREE.Matrix4());
  private readonly parameters = uniform(new THREE.Vector4());
  private readonly detach = uniform(3e38);
  private readonly kill = uniform(0);
  private readonly frameDt = uniform(0);

  constructor(options: SurfaceAttachmentOptions = {}) {
    super(() => {}, { ...options, priority: options.priority ?? Module.Priority.Permanent, modifyGPU: () => {} });
    this.surface = options.surface;
    this.sampler = options.sampler;
    this.samplerGPU = options.samplerGPU;
    this.offset = options.offset ?? 0;
    this.adhesion = options.adhesion ?? 60;
    this.tangentialDrag = options.tangentialDrag ?? 2;
    this.inheritSurfaceVelocity = options.inheritSurfaceVelocity ?? 1;
    this.detachDistance = options.detachDistance ?? Infinity;
    this.killOnDetach = options.killOnDetach ?? false;
  }

  override get modifiesParticles(): boolean { return false; }
  override get supportsGPU(): boolean { return super.supportsGPU && (!this.sampler || !!this.samplerGPU); }

  private prepareSurface(system: ParticleSystem, dt: number, gpu: boolean): void {
    if (![this.offset, this.adhesion, this.tangentialDrag, this.inheritSurfaceVelocity].every(Number.isFinite)
      || this.adhesion < 0 || this.tangentialDrag < 0 || this.inheritSurfaceVelocity < 0
      || this.detachDistance < 0 || Number.isNaN(this.detachDistance)) {
      throw new RangeError('SurfaceAttachment requires finite offset/rates and a nonnegative detach distance.');
    }
    this.toWorld.value.copy(system.getSimulationToWorldMatrix());
    this.toSimulation.value.copy(this.toWorld.value).invert();
    this.parameters.value.set(this.offset, this.adhesion, this.tangentialDrag, this.inheritSurfaceVelocity);
    this.detach.value = Math.min(this.detachDistance, 3e38);
    this.kill.value = this.killOnDetach ? 1 : 0;
    this.frameDt.value = dt;
    if (this.samplerIdentity !== this.samplerGPU) {
      this.samplerIdentity = this.samplerGPU;
      this.needsUpdate = true;
    }
    if (gpu && this.samplerGPU || !gpu && this.sampler) return;
    if (!(this.surface instanceof THREE.Object3D)) {
      throw new Error('SurfaceAttachment requires a mesh/subtree or a sampler for the active backend.');
    }
    if (!gpu) { this.mesh.update(this.surface, dt); return; }
    this.backend ??= new ThreeGPUCollisionBackend({ sweptMotion: true });
    this.backend.dynamicObjects = [this.surface];
    this.backend.staticObjects = [];
    this.backend.geometryDynamicObjects = [];
    this.surface.updateWorldMatrix(true, true);
    this.backend.update(dt);
    const version = `${this.backend.resourceVersion}:${this.backend.motionVersion}`;
    if (version !== this.backendVersion) { this.backendVersion = version; this.needsUpdate = true; }
  }

  override prepare(context: ModuleExecutionContext): void {
    super.prepare(context);
    this.prepareSurface(context.system, context.deltaTime, context.system.isGPUProcessingActive);
  }

  override async prepareResources(system: ParticleSystem, _renderer: ParticleSpatialGridRenderer): Promise<void> {
    void _renderer;
    this.prepareSurface(system, 0, true);
  }

  /** All sample distances/normals/velocities use world space, independently of particle simulation space. */
  sampleSurfaceGPU = (position: Node<'vec3'>): GPUSurfaceSample => {
    if (this.samplerGPU) return this.samplerGPU(position);
    if (!this.backend?.hasGeometry) return { distance: float(0), normal: vec3(0, 1, 0),
      velocity: vec3(0), valid: float(0).greaterThan(0) };
    return this.backend.sampleSurfaceGPU(position, this.frameDt);
  };

  override finalize(particle: Particle, dt: number): void {
    if (dt <= 0) return;
    const position = particle.position.clone().applyMatrix4(this.toWorld.value);
    const sample = this.sampler ? this.sampler(position) : this.mesh.sample(position);
    if (sample.valid === false || !Number.isFinite(sample.distance)
      || sample.normal.lengthSq() < 1e-16 || Math.abs(sample.distance - this.offset) > this.detachDistance) {
      if (this.killOnDetach) particle.alive = false;
      return;
    }
    const normal = sample.normal.clone().normalize(), strength = -Math.expm1(-this.adhesion * dt);
    position.addScaledVector(normal, -(sample.distance - this.offset) * strength);
    const inherited = sample.velocity.clone().multiplyScalar(this.inheritSurfaceVelocity);
    const velocity = particle.velocity.clone().multiplyScalar(particle.speed)
      .applyMatrix4(new THREE.Matrix4().copy(this.toWorld.value).setPosition(0, 0, 0)).sub(inherited);
    const normalVelocity = normal.clone().multiplyScalar(velocity.dot(normal));
    velocity.sub(normalVelocity).multiplyScalar(Math.exp(-this.tangentialDrag * dt))
      .addScaledVector(normalVelocity, 1 - strength).add(inherited);
    particle.position.copy(position.applyMatrix4(this.toSimulation.value));
    if (Math.abs(particle.speed) > 1e-8) {
      const linear = new THREE.Matrix4().copy(this.toSimulation.value).setPosition(0, 0, 0);
      particle.velocity.copy(velocity.applyMatrix4(linear).divideScalar(particle.speed));
    }
  }

  override finalizeGPU(particle: GPUParticleLike, dt: Node<'float'>): void {
    If(dt.greaterThan(0), () => {
      const position = transformPointGPU(particle.position, this.toWorld).toVar();
      const sample = this.sampleSurfaceGPU(position);
      const normal = sample.normal.div(sample.normal.length().max(1e-8));
      const valid = sample.valid.and(sample.normal.lengthSq().greaterThan(1e-16))
        .and(sample.distance.sub(this.parameters.x).abs().lessThanEqual(this.detach));
      If(valid, () => {
        const strength = float(1).sub(this.parameters.y.mul(dt).negate().exp());
        const inherited = sample.velocity.mul(this.parameters.w);
        const relative = transformDirectionGPU(particle.velocity.mul(particle.speed), this.toWorld).sub(inherited);
        const normalVelocity = normal.mul(relative.dot(normal));
        const velocity = relative.sub(normalVelocity).mul(this.parameters.z.mul(dt).negate().exp())
          .add(normalVelocity.mul(float(1).sub(strength))).add(inherited);
        particle.position.assign(transformPointGPU(
          position.sub(normal.mul(sample.distance.sub(this.parameters.x).mul(strength))), this.toSimulation,
        ));
        If(particle.speed.abs().greaterThan(1e-8), () => {
          particle.velocity.assign(transformDirectionGPU(velocity, this.toSimulation).div(particle.speed));
        });
      }).Else(() => {
        If(this.kill.greaterThan(0), () => particle.alive.assign(uint(0)));
      });
    });
  }

  override cleanup(): void {
    this.mesh.dispose(); this.backend?.destroy(); this.backend = undefined;
    this.backendVersion = ''; super.cleanup();
  }
}
