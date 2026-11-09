import * as THREE from 'three';
import { If, mat3, mat4, vec2, vec3, vec4, transpose, inverse, uniform } from 'three/tsl';
import type { Node } from 'three/webgpu';
import Module, { type ModuleOptions, type ModuleExecutionContext } from '../core/Module';
import Particle, { type ParticleInitializationContext, type GPUParticleInitializationContext } from '../core/Particle';
import type { GPUParticleLike } from '../simulation/gpu/Particle';
import type { SurfacePatch, MaterialTarget } from '../rendering/compositing/MaterialCopyRegistry';
import { bindSurface, MaterialCopySampleMode, targetMaterial } from '../rendering/compositing/MaterialCopyRegistry';
import { particleFrameGPU, matrixColumnGPU } from '../simulation/simulationFrame.utils';

export enum MaterialCopySource {
  Collision = 'collision',
  Event = 'event',
  Source = 'source',
}

/** Accessible material inputs and an optional surface chart; gradients are world-space. */
export interface MaterialCopyInput {
  material?: MaterialTarget;
  materialSourceId?: number;
  surface?: SurfacePatch;
  /** Contact position in the initialization source's simulation frame. */
  point?: THREE.Vector3;
}

export interface GPUMaterialCopyInput {
  /** Registered ID, raw impact U/V, sampling mode. */
  binding: Node<'vec4'>;
  u?: Node<'vec3'>;
  v?: Node<'vec3'>;
  /** World-space contact position. */
  point?: Node<'vec3'>;
}

export interface MaterialCopyOptions extends Partial<ModuleOptions> {
  source?: MaterialCopySource | MaterialTarget;
  sampleMode?: MaterialCopySampleMode;
  resolveSource?: (particle: Particle, context: ParticleInitializationContext) => MaterialCopyInput | undefined;
  resolveSourceGPU?: (particle: GPUParticleLike,
    context: GPUParticleInitializationContext) => GPUMaterialCopyInput | undefined;
}

/** Assigns source bindings at birth or from subscribed events. Shading belongs to the shared appearance pipeline. */
export default class MaterialCopy extends Module {
  readonly options: MaterialCopyOptions;
  private readonly targetID = uniform(0);
  private readonly modeNode = uniform(0);

  constructor(options: MaterialCopyOptions = {}) {
    super((particle, _delta, context) => {
      for (const event of context.events) {
        if (event.source?.id !== particle.id) continue;
        this.initializeParticle!(particle, { system: context.system, event, source: event.source,
          sourceToWorld: event.origin.getSimulationToWorldMatrix() });
      }
    }, { ...options, modifyGPU: (particle, _delta, context) => {
      for (const name of this.events) context.events.forEach(name, event => {
        If(event.origin.equal(context.system.id).and(event.slot.equal(particle.index))
          .and(event.generation.equal(particle.generation)), () => {
          this.initializeParticleGPU!(particle, { ...context, event, source: event.particle,
            sourceToWorld: context.simulationToWorldNode });
        });
      });
    } });
    this.options = options;

    this.initializeParticle = (particle, context) => this.bindCPU(particle, context);
    this.initializeParticleGPU = (particle, context) => this.bindGPU(particle, context);
  }

  override prepare(context: ModuleExecutionContext): void {
    super.prepare(context);

    // Prepare renderer resources before collision-driven births need their first material binding.
    this.enable(context);

    const source = this.options.source;
    if (source && typeof source !== 'string') {
      this.targetID.value = context.system.materialCopyRegistry.register(targetMaterial(source));
    }
    this.modeNode.value = this.options.sampleMode ?? MaterialCopySampleMode.UVPatch;
  }

  override get supportsGPU(): boolean {
    return super.supportsGPU && (!this.options.resolveSource || !!this.options.resolveSourceGPU);
  }

  private enable(context: Pick<ParticleInitializationContext, 'system'>): void {
    context.system.renderers.forEach(renderer => {
      renderer.enableMaterialCopy(context.system.materialCopyRegistry, context.system.sceneRenderer);
    });
  }

  private bindCPU(particle: Particle, context: ParticleInitializationContext): void {
    const source = this.options.source ?? MaterialCopySource.Collision;
    let input = this.options.resolveSource?.(particle, context);
    if (!input && typeof source !== 'string') input = { material: source };
    if (!input && source === MaterialCopySource.Collision && context.event?.name === 'collision') {
      input = context.event.data as MaterialCopyInput;
    }
    if (!input && source === MaterialCopySource.Event) input = context.event?.data as MaterialCopyInput | undefined;
    if (!input && source === MaterialCopySource.Source) {
      input = (context.source as { metadata?: MaterialCopyInput } | undefined)?.metadata;
      if (context.source instanceof Particle && context.source.materialCopy.x > 0) {
        const sourceWorld = (context.sourceToWorld ?? new THREE.Matrix4()).clone().multiply(
          new THREE.Matrix4().compose(context.source.position,
            new THREE.Quaternion().setFromEuler(new THREE.Euler().setFromVector3(context.source.rotation)),
            context.source.scale));
        const normal = new THREE.Matrix3().getNormalMatrix(sourceWorld);
        input = { materialSourceId: context.source.materialCopy.x, point: context.source.position,
          surface: { uv: new THREE.Vector2(context.source.materialCopy.y, context.source.materialCopy.z),
            u: new THREE.Vector3().copy(context.source.materialCopyU).applyMatrix3(normal),
            v: new THREE.Vector3().copy(context.source.materialCopyV).applyMatrix3(normal) } };
      }
    }
    if (!input || typeof input !== 'object') return;

    const material = input.material ?? (input as { object?: THREE.Mesh }).object;
    const id = input.materialSourceId ?? context.system.materialCopyRegistry.register(targetMaterial(material));
    if (!id) return;
    this.enable(context);

    const mode = this.options.sampleMode ?? MaterialCopySampleMode.UVPatch;
    const surface = input.surface;
    if (!surface) {
      particle.materialCopy.set(id, 0.5, 0.5, mode === MaterialCopySampleMode.Color ? mode : 2);
      particle.materialCopyU.set(0, 0, 0, 0);
      particle.materialCopyV.set(0, 0, 0, 0);
      return;
    }

    const frame = context.birthToWorld ?? context.system.getSimulationToWorldMatrix();
    const world = frame.clone().multiply(new THREE.Matrix4().compose(
      particle.position, new THREE.Quaternion().setFromEuler(new THREE.Euler().setFromVector3(particle.rotation)),
      particle.scale));
    const origin = input.point?.clone().applyMatrix4(context.sourceToWorld ?? new THREE.Matrix4())
      ?? new THREE.Vector3().setFromMatrixPosition(world);
    bindSurface(particle, id, world, { surface, point: origin }, mode);
  }

  private bindGPU(particle: GPUParticleLike, context: GPUParticleInitializationContext): void {
    this.enable(context);
    const source = this.options.source ?? MaterialCopySource.Collision;
    const frame = context.sourceToWorld ?? mat4(new THREE.Matrix4());
    const event = context.event;
    let input = this.options.resolveSourceGPU?.(particle, context);
    if (!input && typeof source !== 'string') {
      const id = context.system.materialCopyRegistry.register(targetMaterial(source));
      this.targetID.value = id;
      input = { binding: vec4(this.targetID, 0.5, 0.5, 2) };
    }
    if (!input && event && (source === MaterialCopySource.Collision || source === MaterialCopySource.Event)) {
      input = { binding: event.materialCopy, u: event.materialCopyU.xyz, v: event.materialCopyV.xyz,
        point: frame.mul(vec4(event.collisionPoint, 1)).xyz };
    }
    if (!input && source === MaterialCopySource.Source && context.source?.materialCopy) {
      const parent = context.source;
      const normal = transpose(inverse(mat3(frame.mul(particleFrameGPU(parent)))));
      input = { binding: parent.materialCopy!,
        u: normal.mul(parent.materialCopyU?.xyz ?? vec3(0)),
        v: normal.mul(parent.materialCopyV?.xyz ?? vec3(0)),
        point: frame.mul(vec4(parent.position, 1)).xyz };
    }
    if (!input) return;

    const world = (context.birthToWorld ?? context.simulationToWorldNode).mul(particleFrameGPU(particle));
    const delta = matrixColumnGPU(world, 3).xyz.sub(input.point ?? matrixColumnGPU(world, 3).xyz);
    const u = input.u ?? vec3(0), v = input.v ?? vec3(0);
    const axes = [0, 1, 2].map(i => matrixColumnGPU(world, i).xyz);
    const mode = this.modeNode;
    const hasPatch = u.length().add(v.length()).greaterThan(0);
    const uvOffset = mode.equal(MaterialCopySampleMode.Color).select(vec2(0), vec2(u.dot(delta), v.dot(delta)));
    If(input.binding.x.greaterThan(0), () => {
      particle.materialCopy?.assign(vec4(input!.binding.x,
        input!.binding.yz.add(uvOffset), hasPatch.select(mode.equal(0).select(-1, mode),
          mode.equal(MaterialCopySampleMode.Color).select(mode, 2))));
      particle.materialCopyU?.assign(vec4(u.dot(axes[0]), u.dot(axes[1]), u.dot(axes[2]), 0));
      particle.materialCopyV?.assign(vec4(v.dot(axes[0]), v.dot(axes[1]), v.dot(axes[2]), 0));
    });
  }
}
