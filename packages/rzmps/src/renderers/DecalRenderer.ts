import * as THREE from 'three';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';
import Renderer, { type RendererOptions } from '../Renderer';
import type Particle from '../Particle';
import type ParticleSystem from '../ParticleSystem';
import type { DynamicValue } from '../types/DynamicValue';
import type { ColorInput, Vector3Input } from '../types/ValueInput';
import type { CollisionHit } from '../interfaces/ICollisionBackend';
import type { GPUParticleBufferState, GPUParticleRenderBufferState } from '../gpu/Particle';
import type { GPUParticleReadbackField } from '../gpu/SelectiveReadback';
import Collision from '../modules/Collision';
import ThreeCollisionBackend from '../collision/ThreeCollisionBackend';
import { isIgnoredCollisionObject } from '../collision/CollisionSceneUtils';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';
import evaluateDynamicColor from '../helpers/evaluateDynamicColor';
import evaluateDynamicVector3 from '../helpers/evaluateDynamicVector3';
import tagsIntersect from '../helpers/tagsIntersect';
import particleRatio from '../helpers/particleRatio';
import { PARTICLE_RENDERER_OBJECT_KEY } from './LiveCubemap';

export const DECAL_RENDERER_USER_DATA_KEY = '__rzmps_decalRenderer';

export type DecalDirectionSampler = (particle: Particle) => THREE.Vector3 | readonly THREE.Vector3[];
export type DecalHitSelection = (
  hits: THREE.Intersection[], particle: Particle, maxHits?: number,
) => THREE.Intersection[];

export interface DecalRendererOptions extends Partial<RendererOptions> {
  /** World-space ray direction(s); defaults to downward. Particle state remains in simulation space. */
  direction: THREE.Vector3 | DecalDirectionSampler;
  /** Defaults to Nearest. Receives all candidates and the optional maxHits unchanged. */
  hitSelection: DecalHitSelection;
  /** Optional selector count; negative is unlimited, zero disables creation. */
  maxHits?: number;
  /** Maximum world-space ray length, independent of clipping depth. Default 2. */
  maxDistance: number;
  /** Projector Z clipping thickness in world units. Default 0.1. */
  depth: number;
  /** World-space displacement of generated vertices along the outward normal. Default 0.001. */
  offset: number;
  /** Width/height from X/Y before particle-scale inheritance; a number sets both. Default 1. Z is ignored. */
  size: DynamicValue<Vector3Input>;
  /** Tint multiplied with material color at creation. Default white. */
  color: DynamicValue<ColorInput>;
  /** Seconds, sampled at creation; nonpositive/nonfinite values produce no decal. Default 8. */
  lifetime: DynamicValue<number>;
  /** Evaluated at normalized decal age, independently of source lifetime. Default 1. */
  opacity: DynamicValue<number>;
  /** Multiplicative subsystem inheritance amounts. Defaults to 1. */
  inheritColor: number;
  inheritScale: number;
  inheritAlpha: number;
  /** Multiplies by lerp(1, 1 - distance / maxDistance, amount). Default 0. */
  distanceAffectsOpacity: number;
  distanceAffectsSize: number;
  /** Active capacity; oldest decals are evicted first. Default 256. */
  maxDecals: number;
  /** Defaults to true; collision and death default to false. */
  onSpawn: boolean;
  onCollision: boolean;
  onDeath: boolean;
  /** Projections per second per live particle, starting after one interval. Zero disables continuous placement. */
  continuousRate: number;
  /** Fraction of particles that project decals, selected consistently by particle ID. Default 1. */
  ratio: number;
}

type DecalMaterial = THREE.Material & { color?: THREE.Color };
interface DecalInstance {
  mesh: THREE.Mesh<THREE.BufferGeometry, DecalMaterial>;
  age: number;
  lifetime: number;
  alpha: number;
  opacity: DynamicValue<number>;
  seed: string;
}

/** Persistent CPU-clipped surface decals driven by lifecycle events or a per-particle projection rate. */
export default class DecalRenderer extends Renderer {
  static Nearest(hits: THREE.Intersection[], _particle: Particle, n = 1): THREE.Intersection[] {
    return hits.slice().sort((a, b) => a.distance - b.distance).slice(0, n < 0 ? undefined : n);
  }

  static Farthest(hits: THREE.Intersection[], _particle: Particle, n = 1): THREE.Intersection[] {
    return hits.slice().sort((a, b) => b.distance - a.distance).slice(0, n < 0 ? undefined : n);
  }

  static All(hits: THREE.Intersection[], _particle: Particle, n = -1): THREE.Intersection[] {
    return hits.slice(0, n < 0 ? undefined : n);
  }

  /** Deterministic Fibonacci sphere, with exactly subdivisions unit directions. */
  static Radial(subdivisions: number): DecalDirectionSampler {
    const sd = Math.max(1, Math.floor(Number.isFinite(subdivisions) ? subdivisions : 1));
    const directions = Array.from({ length: sd }, (_, i) => {
      const y = 1 - 2 * (i + 0.5) / sd;
      const radius = Math.sqrt(1 - y * y);
      const angle = i * Math.PI * (3 - Math.sqrt(5));
      return new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
    });
    return () => directions.map((direction) => direction.clone());
  }

  /** Samples world-space projection directions from the source particle. */
  direction: THREE.Vector3 | DecalDirectionSampler = new THREE.Vector3(0, -1, 0);
  hitSelection: DecalHitSelection = DecalRenderer.Nearest;
  maxHits?: number;
  maxDistance = 2;
  depth = 0.1;
  offset = 0.001;
  size: DynamicValue<Vector3Input> = 1;
  color: DynamicValue<ColorInput> = new THREE.Color(0xffffff);
  lifetime: DynamicValue<number> = 8;
  opacity: DynamicValue<number> = 1;
  inheritColor = 1;
  inheritScale = 1;
  inheritAlpha = 1;
  distanceAffectsOpacity = 0;
  distanceAffectsSize = 0;
  maxDecals = 256;
  onSpawn = true;
  onCollision = false;
  onDeath = false;
  continuousRate = 0;
  ratio = 1;

  /** Local +Y forward transformed by particle rotation, with an optional local XYZ offset in radians. */
  static Forward(rotation = new THREE.Vector3()): DecalDirectionSampler {
    const direction = new THREE.Vector3(0, 1, 0)
      .applyEuler(new THREE.Euler(rotation.x, rotation.y, rotation.z));
    return (particle) => direction.clone().applyEuler(new THREE.Euler(
      particle.rotation.x, particle.rotation.y, particle.rotation.z,
    ));
  }

  private system?: ParticleSystem;
  private readonly instances: DecalInstance[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly continuousTicks = new Map<string, number>();
  private readonly spawn = (particle: Particle) => {
    if (this.continuousRate > 0) this.continuousTicks.set(particle.id, 0);
    if (this.onSpawn) this.project(particle);
  };
  private readonly death = (particle: Particle) => {
    this.continuousTicks.delete(particle.id);
    if (this.onDeath) this.project(particle);
  };
  private readonly collision = (particle: Particle, contact: CollisionHit) => {
    if (this.onCollision) this.project(particle, contact);
  };

  constructor(public material: THREE.Material, options: Partial<DecalRendererOptions> = {}) {
    super(options);
    this.direction = options.direction ?? this.direction;
    this.hitSelection = options.hitSelection ?? this.hitSelection;
    this.maxHits = options.maxHits === undefined ? undefined
      : Number.isFinite(options.maxHits) ? Math.max(-1, Math.floor(options.maxHits)) : 0;
    this.maxDistance = Math.max(Number.EPSILON,
      Number.isFinite(options.maxDistance) ? options.maxDistance! : this.maxDistance);
    this.depth = Math.max(Number.EPSILON,
      Number.isFinite(options.depth) ? options.depth! : this.depth);
    this.offset = Number.isFinite(options.offset) ? options.offset! : this.offset;
    this.size = options.size ?? this.size;
    this.color = options.color ?? this.color;
    this.lifetime = options.lifetime ?? this.lifetime;
    this.opacity = options.opacity ?? this.opacity;
    this.inheritColor = options.inheritColor ?? this.inheritColor;
    this.inheritScale = options.inheritScale ?? this.inheritScale;
    this.inheritAlpha = options.inheritAlpha ?? this.inheritAlpha;
    this.distanceAffectsOpacity = options.distanceAffectsOpacity ?? this.distanceAffectsOpacity;
    this.distanceAffectsSize = options.distanceAffectsSize ?? this.distanceAffectsSize;
    this.maxDecals = Math.max(0, Math.floor(
      Number.isFinite(options.maxDecals) ? options.maxDecals! : this.maxDecals));
    this.onSpawn = options.onSpawn ?? this.onSpawn;
    this.onCollision = options.onCollision ?? this.onCollision;
    this.onDeath = options.onDeath ?? this.onDeath;
    this.continuousRate = Math.max(0,
      Number.isFinite(options.continuousRate) ? options.continuousRate! : this.continuousRate);
    this.ratio = Math.min(Math.max(options.ratio ?? this.ratio, 0), 1);
  }

  /** Number of persistent decals, including those whose particles have died. */
  get count(): number { return this.instances.length; }

  setup(system: ParticleSystem): void {
    if (this.system === system) return;
    this.detach();
    this.clear();
    this.system = system;
    system.onSpawn(this.spawn).onDeath(this.death).onCollision(this.collision);
  }

  // Persistent instances must age even when source particles are absent or renderer LOD skips them.
  override update(particles: Particle[], system: ParticleSystem, deltaTime = 0): void {
    if (system.paused) return;
    this._update(particles, system, deltaTime);
  }

  override updateGPU(
    buffers: GPUParticleBufferState | GPUParticleRenderBufferState,
    system: ParticleSystem, deltaTime = 0,
  ): void {
    if (system.paused) return;
    // GPU lifecycle listeners already supply event snapshots for event-only placement.
    // TODO: GPU collision events lack target identity; use sampler fallback until identity is available.
    this.ageDecals(deltaTime);
    const rate = this.continuousRate;
    if (!Number.isFinite(rate) || rate <= 0) {
      this.continuousTicks.clear();
      return;
    }
    const fields: GPUParticleReadbackField[] = ['position', 'rotation', 'time', 'realtime'];
    if (this.inheritScale > 0) fields.push('scale');
    if (this.inheritColor > 0) fields.push('color');
    if (this.inheritAlpha > 0) fields.push('alpha');
    // Age is advanced above. Snapshot callbacks use authoritative particle ages for projection cadence.
    // Custom samplers may inspect any field, as with AudioRenderer's custom particle predicates.
    this.updateCPUFromGPU(
      buffers, system, 0, buffers.count,
      typeof this.direction === 'function' ? undefined : fields,
    );
  }

  protected _update(particles: Particle[], _system: ParticleSystem, deltaTime: number): void {
    this.ageDecals(deltaTime);
    this.projectContinuous(particles, deltaTime);
  }

  private ageDecals(deltaTime: number): void {
    const step = Number.isFinite(deltaTime) ? Math.max(0, deltaTime) : 0;
    for (let i = this.instances.length - 1; i >= 0; i -= 1) {
      const decal = this.instances[i];
      decal.age += step;
      if (decal.age >= decal.lifetime) this.remove(i);
      else this.fade(decal);
    }
  }

  private projectContinuous(particles: Particle[], deltaTime: number): void {
    const rate = this.continuousRate;
    if (!Number.isFinite(rate) || rate <= 0) {
      this.continuousTicks.clear();
      return;
    }

    const live = new Set<string>();
    for (const particle of particles) {
      if (!particle.alive || (this.tags && !tagsIntersect(this.tags, particle.tags ?? []))) continue;

      const age = particle.realtime / 1000;
      if (!Number.isFinite(age) || age < 0) continue;
      live.add(particle.id);

      // Particle age makes repeated GPU snapshots harmless. New attachments start from now.
      const tick = Math.floor(age * rate + 1e-9);
      const previous = this.continuousTicks.get(particle.id)
        ?? Math.floor(Math.max(0, age - Math.max(0, deltaTime)) * rate + 1e-9);
      this.continuousTicks.set(particle.id, tick);

      // Older missed marks would immediately be evicted, so only catch up to capacity.
      const attempts = Math.min(Math.max(0, tick - previous), this.maxDecals);
      for (let i = 0; i < attempts; i += 1) this.project(particle);
    }

    // Keep only identities, never source particles, and discard clocks for departed particles.
    for (const id of this.continuousTicks.keys()) {
      if (!live.has(id)) this.continuousTicks.delete(id);
    }
  }

  private supported(object: THREE.Object3D): object is THREE.Mesh {
    if (!(object instanceof THREE.Mesh) || object instanceof THREE.SkinnedMesh
      || object instanceof THREE.InstancedMesh || !object.geometry.getAttribute('position')) return false;
    for (let ancestor: THREE.Object3D | null = object; ancestor; ancestor = ancestor.parent) {
      if (isIgnoredCollisionObject(ancestor)) return false;
    }
    return true;
  }

  private validHit(hit: THREE.Intersection): boolean {
    return Boolean(hit && this.supported(hit.object)
      && hit.point instanceof THREE.Vector3 && Number.isFinite(hit.distance) && hit.distance >= 0
      && (hit.normal instanceof THREE.Vector3 || hit.face?.normal instanceof THREE.Vector3));
  }

  private project(particle: Particle, contact?: CollisionHit): void {
    const system = this.system;
    if (!system || this.maxDecals <= 0 || this.maxHits === 0 || !particleRatio(particle, this.ratio)
      || (this.tags && !tagsIntersect(this.tags, particle.tags ?? []))) return;

    system.updateWorldMatrix(true, false);
    const origin = particle.position.clone();
    if (system.simulationSpace === 'local') origin.applyMatrix4(system.matrixWorld);

    // A known contact already identifies the surface; only search when it is unavailable.
    const hit = contact && this.contactHit(contact, origin, system);
    const hits = hit ? [hit] : this.findHits(particle, origin, system);

    // Custom selectors receive every candidate. Enforce an explicit cap after validation.
    const selected = this.hitSelection(hits, particle, this.maxHits);
    if (!Array.isArray(selected)) return;

    const limit = this.maxHits === undefined || this.maxHits < 0 ? undefined : this.maxHits;
    const valid = selected.filter((candidate) => this.validHit(candidate)).slice(0, limit);
    for (const selectedHit of valid) this.create(particle, selectedHit);
  }

  private contactHit(
    contact: CollisionHit, origin: THREE.Vector3, system: ParticleSystem,
  ): THREE.Intersection | undefined {
    const target = contact.object;
    if (!target || !this.supported(target) || !(contact.point instanceof THREE.Vector3)
      || !(contact.normal instanceof THREE.Vector3) || contact.normal.lengthSq() <= 0) return;

    const point = contact.point.clone();
    const normal = contact.normal.clone();
    if (system.simulationSpace === 'local') {
      point.applyMatrix4(system.matrixWorld);
      normal.transformDirection(system.matrixWorld);
    }

    // Adapt collision world normals to the mesh-local convention used by raycast faces.
    target.updateWorldMatrix(true, false);
    normal.applyMatrix3(new THREE.Matrix3().getNormalMatrix(target.matrixWorld).invert()).normalize();
    const distance = origin.distanceTo(point);
    if (!Number.isFinite(distance) || !Number.isFinite(normal.lengthSq())) return;

    return { object: target, point, distance,
      face: { a: 0, b: 0, c: 0, materialIndex: 0, normal } };
  }

  private findHits(particle: Particle, origin: THREE.Vector3, system: ParticleSystem): THREE.Intersection[] {
    const sampled = typeof this.direction === 'function' ? this.direction(particle) : this.direction;
    const directions = Array.isArray(sampled) ? sampled : [sampled];
    const backend = system.modules.flatMap((module) => module.withDependents())
      .find((module) => module instanceof Collision)?.backend;

    // Reuse collision membership and filters; otherwise collect supported scene meshes once.
    const targets: THREE.Object3D[] = [];
    if (!(backend instanceof ThreeCollisionBackend)) {
      system.scene?.updateWorldMatrix(true, true);
      system.scene?.traverse((object) => { if (this.supported(object)) targets.push(object); });
    }

    const hits: THREE.Intersection[] = [];
    this.raycaster.near = 0;
    this.raycaster.far = this.maxDistance;
    for (const direction of directions) {
      if (!(direction instanceof THREE.Vector3)) continue;
      const length = Math.hypot(direction.x, direction.y, direction.z);
      if (!Number.isFinite(length) || length === 0) continue;

      this.raycaster.set(origin, new THREE.Vector3(
        direction.x / length, direction.y / length, direction.z / length,
      ));
      const candidates = backend instanceof ThreeCollisionBackend
        ? backend.raycast(this.raycaster) : this.raycaster.intersectObjects(targets, false);
      const hit = candidates.find((candidate) => this.validHit(candidate));
      if (hit) hits.push(hit);
    }
    return hits;
  }

  private create(particle: Particle, hit: THREE.Intersection): void {
    // Sample creation-time properties before the source can be recycled.
    const lifetime = evaluateDynamicNumber(this.lifetime, particle.time, particle.id);
    const size = evaluateDynamicVector3(this.size, particle.time, particle.id).clone();
    if (!Number.isFinite(lifetime) || lifetime <= 0
      || ![size.x, size.y].every((value) => Number.isFinite(value) && value > 0)) return;

    const proximity = 1 - THREE.MathUtils.clamp(hit.distance / this.maxDistance, 0, 1);
    const geometry = this.createGeometry(particle, hit,
      size.multiplyScalar(THREE.MathUtils.lerp(1, proximity, this.distanceAffectsSize)));
    if (!geometry) return;

    // Each mark owns its material so color inheritance and fading remain independent.
    const material = this.createMaterial(particle);
    const alpha = material.opacity
      * (this.inheritAlpha > 0 ? THREE.MathUtils.lerp(1, particle.alpha, this.inheritAlpha) : 1)
      * THREE.MathUtils.lerp(1, proximity, this.distanceAffectsOpacity);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData[DECAL_RENDERER_USER_DATA_KEY] = true;
    mesh.userData[PARTICLE_RENDERER_OBJECT_KEY] = true;

    // Evict oldest resources before attaching the new persistent mark to its surface.
    const decal = { mesh, age: 0, lifetime, alpha, opacity: this.opacity, seed: particle.id };
    this.fade(decal);
    while (this.instances.length >= this.maxDecals) this.remove(0);
    this.instances.push(decal);
    hit.object.add(mesh);
  }

  private createGeometry(
    particle: Particle,
    hit: THREE.Intersection,
    size: THREE.Vector3
  ): THREE.BufferGeometry | undefined {
    const target = hit.object as THREE.Mesh;
    target.updateWorldMatrix(true, false);
    if (Math.abs(target.matrixWorld.determinant()) < Number.EPSILON) return;

    // Restore outward winding, then transform local surface normals with the normal matrix.
    const normal = (hit.normal ?? hit.face!.normal).clone();
    if (hit.face?.normal instanceof THREE.Vector3 && normal.dot(hit.face.normal) < 0) normal.negate();
    normal.applyMatrix3(new THREE.Matrix3().getNormalMatrix(target.matrixWorld)).normalize();
    const normalLength = normal.lengthSq();
    if (!Number.isFinite(normalLength) || normalLength === 0) return;

    const scale = new THREE.Vector3(1, 1, 1);
    if (this.inheritScale > 0) scale.lerp(particle.scale, this.inheritScale);
    scale.multiply(size);
    const dimensions = new THREE.Vector3(Math.abs(scale.x), Math.abs(scale.y), this.depth);
    if (![dimensions.x, dimensions.y].every((value) => Number.isFinite(value) && value > 0)) return;

    // DecalGeometry projects along local +Z; particle Z rotation supplies surface roll.
    const axis = new THREE.Vector3(0, 0, 1);
    const orientation = new THREE.Quaternion().setFromUnitVectors(axis, normal);
    const roll = Number.isFinite(particle.rotation.z) ? particle.rotation.z : 0;
    orientation.multiply(new THREE.Quaternion().setFromAxisAngle(axis, roll));
    const geometry = new DecalGeometry(target, hit.point, new THREE.Euler().setFromQuaternion(orientation), dimensions);
    const positions = geometry.getAttribute('position');
    const normals = geometry.getAttribute('normal');
    if (!positions.count || !positions.array.every(Number.isFinite)
      || (normals && !normals.array.every(Number.isFinite))) {
      geometry.dispose();
      return;
    }

    // Offset the clipped surface, then store it locally so rigid target motion carries the mark.
    geometry.translate(normal.x * this.offset, normal.y * this.offset, normal.z * this.offset);
    geometry.applyMatrix4(target.matrixWorld.clone().invert());
    return geometry;
  }

  private createMaterial(particle: Particle): DecalMaterial {
    const material = this.material.clone() as DecalMaterial;
    material.transparent = true;
    material.depthWrite = false;

    const color = evaluateDynamicColor(this.color, particle.time, particle.id);
    if (this.inheritColor > 0) {
      color.multiply(new THREE.Color(1, 1, 1).lerp(particle.color, this.inheritColor));
    }
    material.color?.multiply(color);
    return material;
  }

  private fade(decal: DecalInstance): void {
    const alpha = decal.alpha * evaluateDynamicNumber(decal.opacity, decal.age / decal.lifetime, decal.seed);
    decal.mesh.material.opacity = Number.isFinite(alpha) ? THREE.MathUtils.clamp(alpha, 0, 1) : 0;
  }

  private remove(index: number): void {
    const [decal] = this.instances.splice(index, 1);
    decal.mesh.removeFromParent();
    decal.mesh.geometry.dispose();
    decal.mesh.material.dispose();
  }

  clear(): void {
    this.cancelGPUSelectiveReadback();
    this.continuousTicks.clear();
    while (this.instances.length)
      this.remove(this.instances.length - 1);
  }

  override reset(): void { super.reset(); this.clear(); }

  private detach(): void {
    this.system
      ?.removeSpawnListener(this.spawn)
      ?.removeDeathListener(this.death)
      ?.removeCollisionListener(this.collision);
    this.system = undefined;
  }

  destroy(): void { this.detach(); this.clear(); super.reset(); }
}
