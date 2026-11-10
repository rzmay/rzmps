import type EmissionSource from '../../emission/EmissionSource';
import type { SubSystemSource } from '../../emission/EmissionSource';
import { eventNames, parameterEventHandler, subscribeParameterEvent, transformEventParameters,
  type ParameterEventSubscription, type ParameterEventSubscriptions } from '../../events/events.utils';
import rendererEventParticle from '../rendererEventParticle';
import type { Tag } from '../../types/tag.types';
import * as THREE from 'three';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';
import Renderer, { type RendererOptions } from '../../core/Renderer';
import Particle from '../../core/Particle';
import type ParticleSystem from '../../core/ParticleSystem';
import type { SimulationEvent } from '../../events/EventReceiver';
import type { DynamicValue } from '../../values/dynamicValue.types';
import type { ColorInput, Vector3Input } from '../../values/valueInput.types';
import type { CollisionHit } from '../../collision/collision.types';
import type { GPUParticleBufferState, GPUParticleRenderBufferState } from '../../simulation/gpu/Particle';
import type { GPUParticleReadbackField } from '../../simulation/gpu/SelectiveReadback';
import Collision from '../../modules/Collision';
import ThreeCollisionBackend from '../../collision/ThreeCollisionBackend';
import { isIgnoredCollisionObject } from '../../collision/isIgnoredCollisionObject';
import evaluateDynamicNumber from '../../values/evaluateDynamicNumber';
import evaluateDynamicColor from '../../values/evaluateDynamicColor';
import evaluateDynamicVector3 from '../../values/evaluateDynamicVector3';
import tagsIntersect from '../../core/tags/tagsIntersect';
import acceptMultiple from '../../utils/acceptMultiple';
import type { StrictMultiple } from '../../types/multiple.types';
import seedrandom from 'seedrandom';
import particleRatio from '../../core/particleRatio';
import { PARTICLE_RENDERER_OBJECT_KEY } from './LiveCubemap';
import { intersectionSurface, type SurfaceSample } from '../compositing/MaterialCopyRegistry';

export const DECAL_RENDERER_USER_DATA_KEY = '__rzmps_decalRenderer';

export interface DecalProjectionContext {
  /** Seconds covered by this sample; segment coordinates are in particle simulation space. */
  deltaTime: number;
  position: THREE.Vector3;
  previousPosition?: THREE.Vector3;
}
export type DecalDirection = THREE.Vector3 | THREE.Line3;
export type DecalDirectionSampler = (particle: Particle, context?: DecalProjectionContext) =>
  DecalDirection | readonly DecalDirection[];
export type DecalHitSelection = (
  hits: THREE.Intersection[], particle: Particle, maxHits?: number,
) => THREE.Intersection[];

export interface DecalRendererOptions extends Partial<RendererOptions> {
  /** Optional zero-based material selector; otherwise choose randomly once per mark. */
  materialIndex?: DynamicValue<number>;
  /** Registers each persistent decal as an emission source with these tags. */
  emissionTags?: Tag[];
  /** World-space search direction(s); defaults down. Collision searches use the opposite contact normal. */
  direction: THREE.Vector3 | DecalDirectionSampler;
  /** Defaults to Nearest. Receives all candidates and the optional maxHits unchanged. */
  hitSelection: DecalHitSelection;
  /** Optional selector count; negative is unlimited, zero disables creation. */
  maxHits?: number;
  /** Ordinary ray length, independent of clipping depth. Intersect uses actual traveled distance. Default 2. */
  maxDistance: number;
  /** Projector Z clipping thickness in world units. Default 0.1. */
  depth: number;
  /** World-space displacement of generated vertices along the outward normal. Default 0.001. */
  offset: number;
  /** Width/height from X/Y before particle-scale inheritance; a number sets both. Default 1. Z is ignored. */
  size: DynamicValue<Vector3Input>;
  /** Additional projector roll in radians, sampled independently for each mark. Default 0. */
  rotation: DynamicValue<number>;
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
  onSpawn: ParameterEventSubscription<DecalParameters>;
  onCollision: ParameterEventSubscription<DecalParameters, CollisionHit>;
  /** Minimum collision impulse magnitude required for collision placement. Default 0. */
  impulseThreshold: number;
  onDeath: ParameterEventSubscription<DecalParameters>;
  onEvent?: ParameterEventSubscriptions<DecalParameters>;
  impulseAffectsSize: number;
  impulseAffectsOpacity: number;
  impulseAffectsLifetime: number;
  /** Projections per second per live particle, starting after one interval. Zero disables continuous placement. */
  continuousRate: number;
  /** Fraction of particles that project decals, selected consistently by particle ID. Default 1. */
  ratio: number;
}

type DecalMaterial = THREE.Material & { color?: THREE.Color };
export interface DecalInstance {
  /** Caller-owned template selected when this mark was created. */
  materialTemplate: THREE.Material;
  source?: EmissionSource;
  /** @internal Appearance snapshots remain stable while the decal fades. */
  appearanceParticle?: Particle;
  appearanceFrame?: THREE.Matrix4;
  /** Surface-local emission frame; +Y points out of the decal. */
  emissionTransform?: THREE.Matrix4;
  mesh: THREE.Mesh<THREE.BufferGeometry, DecalMaterial>;
  age: number;
  lifetime: number;
  alpha: number;
  opacity: DynamicValue<number>;
  seed: string;
}

/** Evaluated, independent parameters for one persistent decal; positions and normals are world-space. */
export interface DecalParameters {
  position: THREE.Vector3;
  normal: THREE.Vector3;
  size: THREE.Vector3;
  rotation: number;
  color: THREE.Color;
  opacity: number;
  lifetime: number;
  depth: number;
  offset: number;
}

interface DecalTrigger {
  name: string;
  data?: unknown;
  source: SubSystemSource;
}

/** Persistent CPU-clipped surface decals driven by lifecycle events or a per-particle projection rate. */
export default class DecalRenderer extends Renderer {
  protected get groupingRatio(): number { return 1; }
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

  /** Local +Y forward transformed by particle rotation, with an optional local XYZ offset in radians. */
  static Forward(rotation = new THREE.Vector3()): DecalDirectionSampler {
    const direction = new THREE.Vector3(0, 1, 0)
      .applyEuler(new THREE.Euler(rotation.x, rotation.y, rotation.z));
    return (particle) => direction.clone().applyEuler(new THREE.Euler(
      particle.rotation.x, particle.rotation.y, particle.rotation.z,
    ));
  }

  /** Samples the movement segment covered by the ordinary continuous projection interval. */
  static Intersect(): DecalDirectionSampler {
    return (particle, context) => {
      const current = context?.position.clone() ?? particle.position.clone();
      const previous = context?.previousPosition?.clone() ?? particle.position.clone().addScaledVector(
        particle.velocity, -particle.speed * (context?.deltaTime ?? 0),
      );

      return new THREE.Line3(previous, current);
    };
  }

  /** Samples world-space projection directions from the source particle. */
  direction: THREE.Vector3 | DecalDirectionSampler = new THREE.Vector3(0, -1, 0);
  hitSelection: DecalHitSelection = DecalRenderer.Nearest;
  maxHits?: number;
  maxDistance = 2;
  depth = 0.1;
  offset = 0.001;
  size: DynamicValue<Vector3Input> = 1;
  rotation: DynamicValue<number> = 0;
  color: DynamicValue<ColorInput> = new THREE.Color(0xffffff);
  lifetime: DynamicValue<number> = 8;
  opacity: DynamicValue<number> = 1;
  inheritColor = 1;
  inheritScale = 1;
  inheritAlpha = 1;
  distanceAffectsOpacity = 0;
  distanceAffectsSize = 0;
  maxDecals = 256;
  onSpawn: ParameterEventSubscription<DecalParameters> = true;
  onCollision: ParameterEventSubscription<DecalParameters, CollisionHit> = false;
  impulseThreshold = 0;
  onDeath: ParameterEventSubscription<DecalParameters> = false;
  impulseAffectsSize = 0;
  impulseAffectsOpacity = 0;
  impulseAffectsLifetime = 0;
  private _parameterEventHandlers: ParameterEventSubscriptions<DecalParameters> = [];
  continuousRate = 0;
  emissionTags?: Tag[];

  materialIndex?: DynamicValue<number>;

  private system?: ParticleSystem;
  private readonly instances: DecalInstance[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly continuousTicks = new Map<string, {
    tick: number;
    age: number;
    position: THREE.Vector3;
  }>();
  private projectionSequence = 0;
  private readbackDeltaTime = 0;
  constructor(public material: StrictMultiple<THREE.Material>, options: Partial<DecalRendererOptions> = {}) {
    super(options);
    this.materialIndex = options.materialIndex;
    this._parameterEventHandlers = options.onEvent ?? [];
    this.events = [...new Set([
      ...this.events, ...eventNames(this._parameterEventHandlers),
    ])];
    this.impulseAffectsSize = Math.max(0, options.impulseAffectsSize ?? 0);
    this.impulseAffectsOpacity = Math.max(0, options.impulseAffectsOpacity ?? 0);
    this.impulseAffectsLifetime = Math.max(0, options.impulseAffectsLifetime ?? 0);
    this.emissionTags = options.emissionTags?.slice();
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
    this.rotation = options.rotation ?? this.rotation;
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
    this.impulseThreshold = Math.max(0,
      Number.isFinite(options.impulseThreshold) ? options.impulseThreshold! : 0);
    this.onDeath = options.onDeath ?? this.onDeath;
    this.continuousRate = Math.max(0,
      Number.isFinite(options.continuousRate) ? options.continuousRate! : this.continuousRate);
    this.ratio = Math.min(Math.max(options.ratio ?? this.ratio, 0), 1);
  }

  /** Subscribes through the existing event receiver and transforms each selected decal's evaluated parameters. */
  onEvent(name: 'collision', handler: ParameterEventSubscription<DecalParameters, CollisionHit>): this;
  onEvent(name: string, handler?: ParameterEventSubscription<DecalParameters>): this;
  onEvent(name: string, handler: ParameterEventSubscription<DecalParameters>
    | ParameterEventSubscription<DecalParameters, CollisionHit> = true): this {
    this._parameterEventHandlers = subscribeParameterEvent(this._parameterEventHandlers, name,
      handler as ParameterEventSubscription<DecalParameters>);
    this.events = [...new Set([...this.events, name])];
    return this;
  }

  get parameterEvents(): ParameterEventSubscriptions<DecalParameters> { return this._parameterEventHandlers; }

  override get selectedEventNames(): readonly string[] {
    return [...new Set([...this.events, ...eventNames(this._parameterEventHandlers),
      ...[['spawn', this.onSpawn], ['death', this.onDeath], ['collision', this.onCollision]]
        .filter(([, handler]) => handler).map(([name]) => name as string),
    ])].filter(name => this.eventHandler(name));
  }

  private eventHandler(name: string): ParameterEventSubscription<DecalParameters> {
    const defaults = name === 'spawn' ? this.onSpawn : name === 'death' ? this.onDeath
      : name === 'collision' ? this.onCollision : true;
    const handler = parameterEventHandler(this._parameterEventHandlers, name) ?? defaults;
    return handler as ParameterEventSubscription<DecalParameters>;
  }

  protected override receive(event: SimulationEvent): void {
    const system = this.system;

    if (!system || !this.eventHandler(event.name)) return;

    const particle = rendererEventParticle(event, system);
    const hit = event.name === 'collision' ? event.data as CollisionHit : undefined;
    let contact = hit;

    if (hit && event.origin !== system) {
      const frame = system.getSimulationToWorldMatrix().invert().multiply(event.origin.getSimulationToWorldMatrix());
      contact = { ...hit, point: hit.point.clone().applyMatrix4(frame),
        normal: hit.normal.clone().transformDirection(frame),
        impulse: hit.impulse.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(frame)) };
    }

    this.project(particle, contact, { name: event.name, data: event.data, source: event.source ?? particle });
  }

  /** Number of persistent decals, including those whose particles have died. */
  get count(): number { return this.instances.length; }

  /** Persistent instances remain accessible after their originating particles die. */
  get decals(): readonly DecalInstance[] { return this.instances; }

  protected override onMaterialCopyChange(): void {
    for (const decal of this.instances) {
      if (!decal.appearanceParticle || !decal.appearanceFrame || !this.appearance) continue;

      // A fresh owned clone avoids stacking shader injections when callbacks change.
      const old = decal.mesh.material;
      const material = this.createMaterial(decal.appearanceParticle, decal.materialTemplate);
      material.opacity = old.opacity;
      decal.mesh.material = material;
      decal.mesh.updateWorldMatrix(true, false);
      this.appearance.attach(material, decal.mesh.geometry, decal.appearanceParticle,
        decal.appearanceFrame, decal.mesh.matrixWorld);
      old.dispose();
    }
  }

  setup(system: ParticleSystem): void {
    if (this.system === system) return;

    this.detach();
    this.clear();
    this.system = system;
    this.synchronize(system);
  }

  // Persistent instances must age even when source particles are absent or renderer LOD skips them.
  override update(particles: Particle[], system: ParticleSystem, deltaTime = 0): void {
    if (system.paused) return;

    this.prepareMaterialTextures(system, acceptMultiple(this.material)!);
    this.prepareAppearance(system);
    this._update(particles, system, deltaTime);
  }

  protected get updateGPUUsesCPUReadback(): boolean { return true; }

  protected override _updateGPU(
    buffers: GPUParticleBufferState | GPUParticleRenderBufferState,
    system: ParticleSystem, deltaTime = 0,
  ): void {
    if (system.paused) return;

    this.prepareMaterialTextures(system, acceptMultiple(this.material)!);

    // TODO: GPU collision events lack target identity; use sampler fallback until identity is available.
    this.ageDecals(deltaTime);
    const rate = this.continuousRate;

    if (!Number.isFinite(rate) || rate <= 0) {
      this.continuousTicks.clear();
      return;
    }

    const fields: GPUParticleReadbackField[] = ['position', 'rotation', 'time', 'realtime'];

    if (this.appearance) fields.push('materialCopy', 'materialCopyU', 'materialCopyV');
    if (this.inheritScale > 0) fields.push('scale');
    if (this.inheritColor > 0) fields.push('color');
    if (this.inheritAlpha > 0) fields.push('alpha');

    // Age is advanced above. Snapshot callbacks use authoritative particle ages for projection cadence.
    // Custom samplers may inspect any field, as with AudioRenderer's custom particle predicates.
    this.readbackDeltaTime = deltaTime;
    this.updateCPUFromGPU(
      buffers, system, 0, buffers.count,
      typeof this.direction === 'function' ? undefined : fields,
    );
  }

  protected _update(particles: Particle[], _system: ParticleSystem, deltaTime: number): void {
    this.ageDecals(deltaTime);
    this.projectContinuous(particles, deltaTime || this.readbackDeltaTime);
  }

  private worldPosition(particle: Particle): THREE.Vector3 {
    const point = particle.position.clone();

    if (this.system && this.system.simulationSpace !== 'world') {
      point.applyMatrix4(this.system.getSimulationToWorldMatrix());
    }

    return point;
  }

  private ageDecals(deltaTime: number): void {
    const step = Number.isFinite(deltaTime) ? Math.max(0, deltaTime) : 0;

    for (let i = this.instances.length - 1; i >= 0; i -= 1) {
      const decal = this.instances[i];
      decal.age += step;

      if (decal.age >= decal.lifetime) this.remove(i);
      else {
        this.fade(decal);
        this.updateEmissionSource(decal);
      }
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
      const previous = this.continuousTicks.get(particle.id) ?? {
        tick: Math.floor(Math.max(0, age - Math.max(0, deltaTime)) * rate + 1e-9),
        age: Math.max(0, age - Math.max(0, deltaTime)),
        position: particle.position.clone().addScaledVector(particle.velocity,
          -particle.speed * Math.min(age, Math.max(0, deltaTime))),
      };

      // Older missed marks would immediately be evicted, so only catch up to capacity.
      const attempts = Math.min(Math.max(0, tick - previous.tick), this.maxDecals);

      for (let i = 0; i < attempts; i += 1) this.project(particle, undefined, undefined, {
        deltaTime: (age - previous.age) / attempts,
        previousPosition: previous.position.clone().lerp(particle.position, i / attempts),
        position: previous.position.clone().lerp(particle.position, (i + 1) / attempts),
      });

      // Retain the last projection position so samplers cover skipped frames without their own state.
      if (attempts || !this.continuousTicks.has(particle.id)) {
        this.continuousTicks.set(particle.id, { tick, age, position: particle.position.clone() });
      }
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

  private project(particle: Particle, contact?: CollisionHit,
    trigger: DecalTrigger = { name: 'continuous', source: particle }, sample?: DecalProjectionContext): void {
    const system = this.system;

    if (!system || !this.canProject(particle) || !this.eventHandler(trigger.name)) return;

    // Reject weak collisions before doing any scene or geometry work.
    if (contact) {
      const impulse = (trigger.data as CollisionHit | undefined)?.impulse.length() ?? contact.impulse.length();

      if (!Number.isFinite(impulse) || impulse < this.impulseThreshold) return;
    }

    // Prefer the exact collision target; sample the scene only when target identity is unavailable.
    system.updateWorldMatrix(true, false);
    const origin = this.worldPosition(particle);
    const hit = contact && this.contactHit(contact, origin, system);
    const hits = hit ? [hit] : this.findHits(particle, origin, system, contact, sample);

    // Preserve the collision's UV chart in world space for material copying.
    let surface: SurfaceSample | undefined;

    if (hit && contact?.surface) {
      const point = contact.point.clone();

      if (system.simulationSpace !== 'world') point.applyMatrix4(system.getSimulationToWorldMatrix());

      surface = { material: contact.material, surface: contact.surface, point };
    }

    this.projectHits(particle, hits, trigger, surface);
  }

  private canProject(particle: Particle): boolean {
    return !!this.system && this.maxDecals > 0 && this.maxHits !== 0 && particleRatio(particle, this.ratio)
      && (!this.tags || tagsIntersect(this.tags, particle.tags ?? []));
  }

  private projectHits(particle: Particle, hits: THREE.Intersection[], trigger: DecalTrigger,
    surface?: SurfaceSample): void {
    if (!this.system || this.maxDecals <= 0 || this.maxHits === 0 || !particleRatio(particle, this.ratio)
      || (this.tags && !tagsIntersect(this.tags, particle.tags ?? []))) return;

    // Apply the configured selection policy before allocating persistent marks.
    const selected = this.hitSelection(hits, particle, this.maxHits);

    if (!Array.isArray(selected)) return;

    const limit = this.maxHits === undefined || this.maxHits < 0 ? undefined : this.maxHits;
    const valid = selected.filter(candidate => this.validHit(candidate)).slice(0, limit);

    for (const hit of valid) this.create(particle, hit, surface, trigger);
  }

  private contactHit(
    contact: CollisionHit, origin: THREE.Vector3, system: ParticleSystem,
  ): THREE.Intersection | undefined {
    const target = contact.object;

    if (!target || !this.supported(target) || !(contact.point instanceof THREE.Vector3)
      || !(contact.normal instanceof THREE.Vector3) || contact.normal.lengthSq() <= 0) return;

    const point = contact.point.clone();
    const normal = contact.normal.clone();

    if (system.simulationSpace !== 'world') {
      point.applyMatrix4(system.getSimulationToWorldMatrix());
      normal.transformDirection(system.getSimulationToWorldMatrix());
    }

    // Adapt collision world normals to the mesh-local convention used by raycast faces.
    target.updateWorldMatrix(true, false);
    normal.applyMatrix3(new THREE.Matrix3().getNormalMatrix(target.matrixWorld).invert()).normalize();
    const distance = origin.distanceTo(point);

    if (!Number.isFinite(distance) || !Number.isFinite(normal.lengthSq())) return;

    return { object: target, point, distance,
      face: { a: 0, b: 0, c: 0, materialIndex: 0, normal } };
  }

  private findHits(
    particle: Particle, origin: THREE.Vector3, system: ParticleSystem,
    contact?: CollisionHit, sample?: DecalProjectionContext,
  ): THREE.Intersection[] {
    // A collision without target identity still supplies a useful projection direction.
    let contactDirection: THREE.Vector3 | undefined;

    if (contact?.normal instanceof THREE.Vector3
      && Number.isFinite(contact.normal.lengthSq()) && contact.normal.lengthSq() > 0) {
      contactDirection = contact.normal.clone().negate();

      if (system.simulationSpace !== 'world') contactDirection.transformDirection(system.getSimulationToWorldMatrix());
    }

    // Ordinary samplers return world directions; segment samplers return bounded simulation-space paths.
    const sampled = contactDirection
      ?? (typeof this.direction === 'function' ? this.direction(particle, sample) : this.direction);
    const directions = Array.isArray(sampled) ? sampled : [sampled];
    const hits: THREE.Intersection[] = [];

    for (const direction of directions) {
      if (direction instanceof THREE.Line3) {
        // Work on a copy so sampler-owned segments remain unchanged.
        const segment = direction.clone();

        if (system.simulationSpace !== 'world') {
          const frame = system.getSimulationToWorldMatrix();
          segment.start.applyMatrix4(frame);
          segment.end.applyMatrix4(frame);
        }

        const delta = segment.delta(new THREE.Vector3());
        const distance = delta.length();

        if (Number.isFinite(distance) && distance > 1e-8) {
          hits.push(...this.queryHits(segment.start, [delta], system, distance, true));
        }
      } else {
        // Direction rays use the renderer's configured range.
        hits.push(...this.queryHits(origin, [direction], system, this.maxDistance));
      }
    }

    return hits;
  }

  private queryHits(origin: THREE.Vector3, directions: readonly THREE.Vector3[], system: ParticleSystem,
    distance: number, sweep = false): THREE.Intersection[] {
    const backend = system.modules.flatMap((module) => module.withDependents())
      .find((module) => module instanceof Collision)?.backend;

    // Reuse collision membership and filters; otherwise collect supported scene meshes once.
    const targets: THREE.Object3D[] = [];

    if (!(backend instanceof ThreeCollisionBackend)) {
      system.scene?.updateWorldMatrix(true, true);
      system.scene?.traverse((object) => { if (this.supported(object)) targets.push(object); });
    }

    const hits: THREE.Intersection[] = [];
    this.raycaster.near = sweep ? 1e-8 : 0;
    this.raycaster.far = distance;

    for (const direction of directions) {
      if (!(direction instanceof THREE.Vector3)) continue;

      const length = Math.hypot(direction.x, direction.y, direction.z);

      if (!Number.isFinite(length) || length === 0) continue;

      this.raycaster.set(origin, new THREE.Vector3(
        direction.x / length, direction.y / length, direction.z / length,
      ));
      const candidates = backend instanceof ThreeCollisionBackend
        ? backend.raycast(this.raycaster) : this.raycaster.intersectObjects(targets, false);

      if (sweep) {
        // Cast back from the endpoint as well to find outward-facing exit surfaces
        // without changing a target's material side or touching its shaders.
        this.raycaster.near = 0;
        this.raycaster.set(origin.clone().add(direction), this.raycaster.ray.direction.clone().negate());
        const exits = backend instanceof ThreeCollisionBackend
          ? backend.raycast(this.raycaster) : this.raycaster.intersectObjects(targets, false);

        for (const exit of exits) candidates.push({ ...exit, distance: distance - exit.distance });
        candidates.sort((a, b) => a.distance - b.distance);

        // Raycasters can report a triangle seam twice. Keep distinct entry/exit surfaces,
        // including multiple intersections with the same mesh, without duplicate marks.
        for (const candidate of candidates) {
          if (!this.validHit(candidate) || candidate.distance <= 1e-8
            || hits.some(hit => hit.object === candidate.object
              && hit.point.distanceToSquared(candidate.point) < 1e-12)) continue;
          hits.push(candidate);
        }
      } else {
        const hit = candidates.find((candidate) => this.validHit(candidate));

        if (hit) hits.push(hit);
      }
    }

    return hits;
  }

  private create(particle: Particle, hit: THREE.Intersection, surface: SurfaceSample | undefined,
    trigger: DecalTrigger): void {
    // Select a complete template once so all its maps remain correlated across the mark's lifetime.
    const seed = `${particle.id}:decal:${this.projectionSequence++}`;
    const materials = acceptMultiple(this.material)!;
    if (!materials.length) return;

    const index = this.materialIndex === undefined
      ? Math.floor(seedrandom.tychei(seed).quick() * materials.length)
      : evaluateDynamicNumber(this.materialIndex, particle.time, seed);
    if (!Number.isFinite(index)) return;

    const template = materials[THREE.MathUtils.clamp(Math.floor(index), 0, materials.length - 1)];
    const material = this.createMaterial(particle, template);

    // Evaluate inheritance and impulse effects before handing parameters to the callback.
    const impulse = trigger.name === 'collision' ? (trigger.data as CollisionHit).impulse.length() : 1;
    const effect = (exponent: number) => Math.pow(Math.max(0, impulse), exponent);
    const proximity = 1 - THREE.MathUtils.clamp(hit.distance / this.maxDistance, 0, 1);
    const size = evaluateDynamicVector3(this.size, particle.time, particle.id).clone()
      .multiplyScalar(THREE.MathUtils.lerp(1, proximity, this.distanceAffectsSize) * effect(this.impulseAffectsSize));

    if (this.inheritScale > 0) size.multiply(new THREE.Vector3(1, 1, 1).lerp(particle.scale, this.inheritScale));

    size.set(Math.abs(size.x), Math.abs(size.y), size.z);

    // Convert the sampled mesh normal to the world-space projector orientation.
    const normal = (hit.normal ?? hit.face!.normal).clone();

    if (hit.face?.normal instanceof THREE.Vector3 && normal.dot(hit.face.normal) < 0) normal.negate();

    normal.applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();

    // Each hit receives an independent parameter snapshot and rotation seed.
    const parameters = transformEventParameters(this.eventHandler(trigger.name),
      trigger.data ?? hit, trigger.source, {
        position: hit.point.clone(), normal, size,
        rotation: (Number.isFinite(particle.rotation.z) ? particle.rotation.z : 0)
          + evaluateDynamicNumber(this.rotation, particle.time, seed),
        color: material.color?.clone() ?? new THREE.Color(1, 1, 1),
        opacity: material.opacity
          * (this.inheritAlpha > 0 ? THREE.MathUtils.lerp(1, particle.alpha, this.inheritAlpha) : 1)
          * THREE.MathUtils.lerp(1, proximity, this.distanceAffectsOpacity) * effect(this.impulseAffectsOpacity),
        lifetime: evaluateDynamicNumber(this.lifetime, particle.time, particle.id)
          * effect(this.impulseAffectsLifetime),
        depth: this.depth, offset: this.offset,
      });

    // Cancellation and invalid dimensions must not leave owned material resources behind.
    if (!parameters || !Number.isFinite(parameters.lifetime) || parameters.lifetime <= 0
      || !Number.isFinite(parameters.rotation) || !Number.isFinite(parameters.depth) || parameters.depth <= 0
      || !Number.isFinite(parameters.offset) || !Number.isFinite(parameters.opacity)
      || !parameters.position.toArray().every(Number.isFinite) || !parameters.normal.toArray().every(Number.isFinite)
      || parameters.normal.lengthSq() === 0
      || ![parameters.size.x, parameters.size.y].every(value => Number.isFinite(value) && value > 0)) {
      material.dispose();
      return;
    }

    // Clip the projector volume against the selected surface.
    const geometry = this.createGeometry(hit, parameters);

    if (!geometry) {
      material.dispose();
      return;
    }

    if (this.system) this.prepareAppearance(this.system);

    material.color?.copy(parameters.color);
    const { lifetime, rotation } = parameters;
    const alpha = parameters.opacity;
    const mesh = new THREE.Mesh(geometry, material);

    // Match the contacted surface so decals receive the same scene shadows.
    mesh.receiveShadow = hit.object.receiveShadow;
    mesh.userData[DECAL_RENDERER_USER_DATA_KEY] = true;
    mesh.userData[PARTICLE_RENDERER_OBJECT_KEY] = true;

    // Evict oldest resources before attaching the new persistent mark to its surface.
    const decal: DecalInstance = {
      mesh, materialTemplate: template, age: 0, lifetime, alpha, opacity: this.opacity, seed: particle.id,
    };
    this.fade(decal);
    while (this.instances.length >= this.maxDecals) this.remove(0);
    this.instances.push(decal);
    hit.object.add(mesh);

    // Registered sources carry the original surface inputs, independently of decal shading.
    let sample = surface?.material ? surface
      : this.appearance || this.emissionTags ? intersectionSurface(hit) : undefined;

    if (sample && !sample.point.equals(parameters.position)) {
      const delta = parameters.position.clone().sub(sample.point);
      const chart = sample.surface;
      sample = { ...sample, point: parameters.position.clone(), surface: chart && { ...chart,
        uv: chart.uv.clone().add(new THREE.Vector2(chart.u.dot(delta), chart.v.dot(delta))) } };
    }

    if (this.system) {
      mesh.updateWorldMatrix(true, false);
      decal.appearanceFrame = this.system.getSimulationToWorldMatrix().clone().multiply(new THREE.Matrix4().compose(
        particle.position, new THREE.Quaternion().setFromEuler(new THREE.Euler().setFromVector3(particle.rotation)),
        particle.scale));
      const appearanceSource = !this.materialTarget && (this.materialComposite || this.materialCompositeGPU)
        ? sample : undefined;
      decal.appearanceParticle = this.appearance?.attach(material, geometry, particle,
        decal.appearanceFrame, mesh.matrixWorld, appearanceSource) ?? particle.clone();
      this.appearance?.sync(this.materialTarget, this.materialCopySampleMode, this.system.sceneRenderer);
    }

    // Optional registered sources follow the mark's surface frame and carry the original material.
    if (this.emissionTags && this.system) {
      const normal = parameters.normal.clone().normalize();
      const orientation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
      orientation.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotation));
      const transform = new THREE.Matrix4().compose(
        parameters.position.clone().addScaledVector(normal, parameters.offset),
        orientation, new THREE.Vector3(parameters.size.x, 1, parameters.size.y));
      decal.emissionTransform = hit.object.matrixWorld.clone().invert().multiply(transform);
      decal.source = this.system.registerEmissionSource({
        tags: this.emissionTags, transform: this.emissionMatrix(decal),
        color: material.color ?? new THREE.Color(1, 1, 1), alpha: material.opacity,
        metadata: sample && {
          material: sample.material,
          surface: sample.surface && { uv: sample.surface.uv.clone(),
            u: sample.surface.u.clone(), v: sample.surface.v.clone() },
          point: sample.point.clone().applyMatrix4(this.system.getSimulationToWorldMatrix().invert()),
        },
      });
    }
  }

  private createGeometry(
    hit: THREE.Intersection,
    parameters: DecalParameters,
  ): THREE.BufferGeometry | undefined {
    const target = hit.object as THREE.Mesh;
    target.updateWorldMatrix(true, false);

    if (Math.abs(target.matrixWorld.determinant()) < Number.EPSILON) return;

    const { size, rotation, depth, offset } = parameters;
    const normal = parameters.normal.clone().normalize();
    const dimensions = new THREE.Vector3(size.x, size.y, depth);

    // DecalGeometry projects along local +Z; particle Z rotation supplies surface roll.
    const axis = new THREE.Vector3(0, 0, 1);
    const orientation = new THREE.Quaternion().setFromUnitVectors(axis, normal);
    orientation.multiply(new THREE.Quaternion().setFromAxisAngle(axis, rotation));
    const geometry = new DecalGeometry(target, parameters.position,
      new THREE.Euler().setFromQuaternion(orientation), dimensions);
    const positions = geometry.getAttribute('position');
    const normals = geometry.getAttribute('normal');

    if (!positions.count || !positions.array.every(Number.isFinite)
      || (normals && !normals.array.every(Number.isFinite))) {
      geometry.dispose();
      return;
    }

    // Offset the clipped surface, then store it locally so rigid target motion carries the mark.
    geometry.translate(normal.x * offset, normal.y * offset, normal.z * offset);
    geometry.applyMatrix4(target.matrixWorld.clone().invert());
    return geometry;
  }

  private createMaterial(particle: Particle, template: THREE.Material): DecalMaterial {
    const material = template.clone() as DecalMaterial;
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

  private emissionMatrix(decal: DecalInstance): THREE.Matrix4 {
    decal.mesh.updateWorldMatrix(true, false);
    const transform = decal.mesh.matrixWorld.clone().multiply(decal.emissionTransform!);

    if (this.system && this.system.simulationSpace !== 'world') {
      this.system.updateWorldMatrix(true, false);
      transform.premultiply(this.system.getSimulationToWorldMatrix().clone().invert());
    }

    return transform;
  }

  private updateEmissionSource(decal: DecalInstance): void {
    decal.source?.update({ transform: this.emissionMatrix(decal),
      color: decal.mesh.material.color, alpha: decal.mesh.material.opacity });
  }

  private remove(index: number): void {
    const [decal] = this.instances.splice(index, 1);
    decal.source?.dispose();
    decal.mesh.removeFromParent();
    decal.mesh.geometry.dispose();
    decal.mesh.material.dispose();
  }

  clear(): void {
    this.cancelGPUSelectiveReadback();
    this.continuousTicks.clear();
    this.projectionSequence = 0;
    this.readbackDeltaTime = 0;
    while (this.instances.length) this.remove(this.instances.length - 1);
  }

  override reset(): void {
    super.reset();
    this.clear();
  }

  private detach(): void {
    this.dispose();
    this.system = undefined;
  }

  destroy(): void {
    this.detach();
    this.clear();
    super.reset();
  }
}
