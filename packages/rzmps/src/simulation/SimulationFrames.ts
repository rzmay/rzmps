import * as THREE from 'three';
import { abs, bitcast, determinant, float, Fn, If, inverse, mat4, min, uint, uniform, vec4 } from 'three/tsl';
import type { ComputeNode, Node, WebGPURenderer } from 'three/webgpu';
import Particle, { getParticleSourceBinding, setParticleSourceBinding } from '../core/Particle';
import type ParticleSystem from '../core/ParticleSystem';
import EmissionSource, { type SubSystemSource } from '../emission/EmissionSource';
import { SimulationSpace } from '../enums/simulationSpace';
import { isWebGPURenderer } from '../utils/gpu/isWebGPURenderer';
import type { GPUParticleUpdateContext } from './gpu/Particle';
import type { GPUSelectiveReadbackRequest, GPUSelectiveReadbackResult } from './gpu/SelectiveReadback';
import GPUSourceFrameBuffer from './gpu/SourceFrameBuffer';
import { matrixColumnGPU, particleFrameGPU, transformParticleFrameGPU } from './simulationFrame.utils';
export interface SimulationFrameExecution {
  worldToSimulation(): Node<'mat4'>;
  simulationToWorld(system: ParticleSystem): Node<'mat4'>;
  syncRenderers(): void;
  invalidateGPU(system: ParticleSystem): void;
  sourceIdentity(parent: ParticleSystem, id: string): { slot: number; generation: number };
  readback(parent: ParticleSystem, requests: GPUSelectiveReadbackRequest[]): Promise<GPUSelectiveReadbackResult[]>;
  lifecycle(): number;
  debug(message: string, data?: unknown): void;
}

/** Owns frame rebasing, source attachments and snapshot synchronization. */
export default class SimulationFrames {
  constructor(readonly system: ParticleSystem, readonly execution: SimulationFrameExecution) { }
  _sourceFrames?: GPUSourceFrameBuffer;

  _sourceReadbackPending = false;

  _sourceScaleInheritance(): number {
    return this.system.subSystemParent?.subSystems.get(this.system)?.inheritScale ?? 1;
  }

  getSourceEmissionFrame(source?: SubSystemSource): THREE.Matrix4 | undefined {
    if (this.simulationSpace !== SimulationSpace.Source || !this.system.subSystemParent || !source?.alive) return;
    const matrix = this.getParticleEmissionTransform(source, this._sourceScaleInheritance());
    return Math.abs(matrix.determinant()) > 1e-10 ? matrix : undefined;
  }

  readonly _sourceProducers = new WeakMap<SubSystemSource, ParticleSystem>();

  getSourceProducer(source: SubSystemSource): ParticleSystem {
    return source instanceof EmissionSource ? source.system
      : this._sourceProducers.get(source) ?? this.system.subSystemParent ?? this.system;
  }

  _sourceIsAlive(source: SubSystemSource): boolean {
    if (!source.alive || !this.system.subSystemParent) return false;
    const producer = this.getSourceProducer(source);
    if (source.id.startsWith('source:')) return producer.emissionRuntime._emissionSources.has(source.id);
    if (producer.isGPUProcessingActive) return source.alive;
    return producer.particles.some(particle => particle.id === source.id && particle.alive);
  }

  bindParticleSource(particle: Particle, source?: SubSystemSource): void {
    if (this.simulationSpace !== SimulationSpace.Source || !this.system.subSystemParent || !source?.alive) return;
    this._sourceFrames ??= new GPUSourceFrameBuffer(1);
    const record = this._sourceFrames.register(source);
    if (this._sourceFrames.records.length > this._sourceFrames.capacity) {
      this._sourceFrames = this._sourceFrames.grow(
        isWebGPURenderer(this.system.sceneRenderer) ? this.system.sceneRenderer : undefined,
        this._sourceFrames.records.length);
    }
    setParticleSourceBinding(particle, {
      source, previous: this.getParticleEmissionTransform(source, this._sourceScaleInheritance()),
      slot: record.slot, generation: record.generation,
    });
  }

  _updateCPUSourceFrames(): void {
    if (this.simulationSpace !== SimulationSpace.Source) return;
    for (const particle of this.system.particles) {
      const binding = getParticleSourceBinding(particle);
      if (!binding || !particle.alive) continue;
      const record = this._sourceFrames?.records[binding.slot];
      const source = record?.generation === binding.generation ? record.source : binding.source;
      const alive = this._sourceIsAlive(source);
      const current = this.getParticleEmissionTransform(source, this._sourceScaleInheritance());
      if (Math.abs(current.determinant()) > 1e-10) {
        const delta = current.clone().multiply(binding.previous.clone().invert());
        particle.transformSimulationFrame(delta);
        binding.previous.copy(current);
      }
      if (!alive) {
        if (this.system.sourceLoss === 'kill') particle.kill();
        setParticleSourceBinding(particle);
      }
    }
    this._refreshGPUSourceSnapshots();
  }

  _refreshGPUSourceSnapshots(requests = new Map<string, GPUSelectiveReadbackRequest>()): void {
    if (this.system.subSystemParent?.isGPUProcessingActive) {
      for (const record of this._sourceFrames?.records ?? []) {
        const gpuID = /^gpu:(\d+):(\d+)$/.exec(record.source.id);
        const parent = this.system.subSystemParent;
        const identity = this.execution.sourceIdentity(parent, record.source.id);
        const slot = gpuID ? Number(gpuID[1]) : identity.slot;
        const generation = gpuID ? Number(gpuID[2]) : identity.generation;
        if (record.active !== false && record.source.alive && slot >= 0 && generation > 0) {
          requests.set(record.source.id, { slot, generation });
        }
      }
    }
    if (requests.size && !this._sourceReadbackPending && this.system.subSystemParent) {
      this._sourceReadbackPending = true;
      const parent = this.system.subSystemParent;
      const lifecycle = this.execution.lifecycle();
      const requested = [...requests.entries()];
      void this.execution.readback(parent, requested.map(([, request]) => request)).then(results => {
        if (lifecycle !== this.execution.lifecycle()) return;
        results.forEach((result, index) => {
          const [id, request] = requested[index];
          const record = this._sourceFrames?.records.find(candidate => candidate.source.id === id);
          if (!record) return;
          if (result.valid && result.generation === request.generation) {
            result.particle.id = id;
            record.source = result.particle;
          } else record.source = { ...record.source, alive: false };
          this.system.emissionRuntime.updateSourceSnapshot(id, record.source);
        });
      }).catch(error => { this.execution.debug('source frame readback failed', { error }); })
        .finally(() => { if (lifecycle === this.execution.lifecycle()) this._sourceReadbackPending = false; });
    }
  }

  _simulationSpace: SimulationSpace = SimulationSpace.Local;

  _simulationSpaceExplicit = false;

  _simulationSpaceTransform: THREE.Object3D | THREE.Matrix4 | null = null;

  readonly _lastSimulationFrame = new THREE.Matrix4();

  _pendingFrameConversion?: THREE.Matrix4;

  get simulationSpaceTransform(): THREE.Object3D | THREE.Matrix4 | null { return this._simulationSpaceTransform; }

  set simulationSpaceTransform(value: THREE.Object3D | THREE.Matrix4 | null) {
    const previous = this.getSimulationToWorldMatrix();
    this._simulationSpaceTransform = value;
    if (this.simulationSpace === SimulationSpace.Transform) this._rebaseSimulationFrame(previous);
  }

  getSimulationToWorldMatrix(target = new THREE.Matrix4()): THREE.Matrix4 {
    if (this.simulationSpace === SimulationSpace.World) {
      target.identity();
      this._lastSimulationFrame.copy(target);
      return target;
    }
    if (this.simulationSpace === SimulationSpace.Transform) {
      const reference = this.simulationSpaceTransform;
      if (!reference && !this._simulationSpaceExplicit && this.system.subSystemParent) {
        return this.system.subSystemParent.getSimulationToWorldMatrix(target);
      }
      if (reference instanceof THREE.Object3D) {
        reference.updateWorldMatrix(true, false);
        target.copy(reference.matrixWorld);
      } else target.copy(reference ?? new THREE.Matrix4());
    } else {
      this.system.updateWorldMatrix(true, false);
      target.copy(this.system.matrixWorld);
    }
    const determinant = target.determinant();
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10) {
      return target.copy(this._lastSimulationFrame);
    }
    this._lastSimulationFrame.copy(target);
    return target;
  }

  simulationToWorld(position: THREE.Vector3): THREE.Vector3 {
    return position.applyMatrix4(this.getSimulationToWorldMatrix());
  }

  worldToSimulation(position: THREE.Vector3): THREE.Vector3 {
    return position.applyMatrix4(this.getSimulationToWorldMatrix().invert());
  }

  getSimulationWorldQuaternion(target = new THREE.Quaternion()): THREE.Quaternion {
    return target.setFromRotationMatrix(new THREE.Matrix4().extractRotation(this.getSimulationToWorldMatrix()));
  }

  resolveSimulationFrame(particle?: Particle, target = new THREE.Matrix4()): THREE.Matrix4 {
    this.getSimulationToWorldMatrix(target);
    const binding = particle && getParticleSourceBinding(particle);
    if (this.simulationSpace === SimulationSpace.Source && binding) target.multiply(binding.previous);
    return target;
  }

  _rebaseSimulationFrame(previous: THREE.Matrix4): void {
    const conversion = this.getSimulationToWorldMatrix().invert().multiply(previous);
    this.system.particles.forEach(particle => {
      particle.transformSimulationFrame(conversion);
      setParticleSourceBinding(particle);
    });
    this.system.emissionRuntime._emissionSources.forEach(source => source.apply({
      transform: conversion.clone().multiply(source.transform),
      velocity: source.velocity.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(conversion)),
    }));
    if (this.system.isGPUProcessingActive) {
      this._pendingFrameConversion = this._pendingFrameConversion
        ? conversion.multiply(this._pendingFrameConversion) : conversion;
    }
    this.execution.syncRenderers();
  }

  get simulationSpace(): SimulationSpace { return this._simulationSpace; }

  set simulationSpace(value: SimulationSpace | `${SimulationSpace}`) {
    this._setSimulationSpace(value as SimulationSpace, true);
  }

  _setSimulationSpace(value: SimulationSpace, explicit: boolean, previous?: THREE.Matrix4): void {
    this._simulationSpaceExplicit = explicit;
    if (value === this._simulationSpace) return;
    const previousFrame = previous ?? this.getSimulationToWorldMatrix();
    // Capture inherited frames before changing the parent that resolves them.
    const inherited = new Map<ParticleSystem, THREE.Matrix4>();
    const capture = (system: ParticleSystem) => system.subSystems.forEach((_options, child) => {
      if (!child.frameRuntime._simulationSpaceExplicit) {
        inherited.set(child, child.getSimulationToWorldMatrix());
        capture(child);
      }
    });
    capture(this.system);
    this._simulationSpace = value;
    this._rebaseSimulationFrame(previousFrame);
    this.execution.invalidateGPU(this.system);
    inherited.forEach((_frame, child) => { child.frameRuntime._simulationSpace = value; });
    inherited.forEach((frame, child) => {
      child.frameRuntime._rebaseSimulationFrame(frame);
      this.execution.invalidateGPU(child);
    });
  }

  readonly _particleEmissionQuaternion = new THREE.Quaternion();

  readonly _particleEmissionEuler = new THREE.Euler();

  readonly _particleEmissionUnitY = new THREE.Vector3(0, 1, 0);

  readonly _particleEmissionAlignUp = new THREE.Vector3();

  readonly _particleEmissionUnitScale = new THREE.Vector3(1, 1, 1);

  readonly _particleEmissionScale = new THREE.Vector3(1, 1, 1);

  getParticleEmissionTransform(
    particle: SubSystemSource,
    inheritScale: number = 0,
    alignUpTo?: THREE.Vector3,
  ): THREE.Matrix4 {
    const quaternion = alignUpTo && alignUpTo.lengthSq() > 0
      ? this._particleEmissionQuaternion.setFromUnitVectors(
        this._particleEmissionUnitY,
        this._particleEmissionAlignUp.copy(alignUpTo).normalize(),
      )
      : this._particleEmissionQuaternion.setFromEuler(this._particleEmissionEuler.set(
        particle.rotation.x,
        particle.rotation.y,
        particle.rotation.z,
      ));

    const sourceFrame = new THREE.Matrix4().compose(
      particle.position,
      quaternion,
      inheritScale > 0
        ? this._particleEmissionScale.copy(this._particleEmissionUnitScale).lerp(particle.scale, inheritScale)
        : this._particleEmissionUnitScale,
    );
    sourceFrame.premultiply(this.getSimulationToWorldMatrix().invert()
      .multiply(this.getSourceProducer(particle).getSimulationToWorldMatrix()));
    return sourceFrame;
  }
  clear(renderer?: WebGPURenderer): void {
    this._sourceFrames?.dispose(renderer); this._sourceFrames = undefined;
    this._pendingFrameConversion = undefined; this._sourceReadbackPending = false;
  }
  _sourceFrameCompute?: { key: string; nodes: ComputeNode[] };
  _computeGPUFrameConversion(context: GPUParticleUpdateContext): void {
    const conversion = this._pendingFrameConversion;
    const renderer = this.system.sceneRenderer;
    if (!conversion || !isWebGPURenderer(renderer)) return;
    const matrix = uniform(conversion, 'mat4');
    const node = Fn(() => {
      const particle = context.buffers.storage.createParticle(undefined, true);
      If(particle.alive.notEqual(uint(0)), () => {
        transformParticleFrameGPU(particle, matrix);
        context.buffers.storage.storeParticle(particle);
      });
      context.buffers.storage.createSourceIdentityNode().assign(vec4(0));
    })().compute(context.buffers.count);
    renderer.compute(node);
    node.dispose();
    this._pendingFrameConversion = undefined;
  }
  _resolveGPUSourceFrames(context: GPUParticleUpdateContext): void {
    const renderer = this.system.sceneRenderer;
    if (this.system.simulationSpace !== SimulationSpace.Source || !this.system.subSystemParent
      || !isWebGPURenderer(renderer)) return;
    this._sourceFrames ??= new GPUSourceFrameBuffer(Math.max(this.system.maxParticles, context.buffers.capacity));
    this._sourceFrames = this._sourceFrames.grow(renderer,
      Math.max(context.buffers.capacity, this._sourceFrames.records.length));
    const frames = this._sourceFrames;
    this._refreshGPUSourceSnapshots();
    frames.refresh(source => this.system.getParticleEmissionTransform(source, this._sourceScaleInheritance()),
      source => this._sourceIsAlive(source));
    frames.initialize(renderer);
    const producers = new Set([this.system.subSystemParent,
    ...this.system.emitters.flatMap(emitter => emitter.visibleSystems(this.system))]);
    const sources = [
      { kind: 2, producer: undefined, buffers: undefined },
      ...[...producers].filter(producer => producer.gpuParticleBuffers).map(producer => ({
        kind: producer === this.system.subSystemParent ? 1 : producer.id + 3,
        producer, buffers: producer.gpuParticleBuffers,
      })),
    ];
    const key = `${context.buffers.version}:${context.buffers.capacity}:${frames.version}:${frames.capacity}:`
      + `${sources.map(source => `${source.kind}:${source.buffers?.version}:${source.buffers?.capacity}`)}:`
      + `${context.eventWriter?.version}:${this.system.sourceLoss}:${this._sourceScaleInheritance()}`;
    if (this._sourceFrameCompute?.key !== key) {
      this._sourceFrameCompute?.nodes.forEach(node => node.dispose());
      const nodes: ComputeNode[] = [];
      for (const { kind, producer, buffers: parent } of sources) {
        nodes.push(Fn(() => {
          const particle = context.buffers.storage.createParticle(undefined, true);
          const packed = context.buffers.storage.createSourceIdentityNode();
          const link = (bitcast(packed, 'uvec4') as unknown as Node<'uvec4'>).toVar('sourceLink');
          If(particle.alive.notEqual(uint(0)).and(link.z.equal(uint(kind))), () => {
            const ownerSlot = uint(min(float(link.x), float((parent?.capacity ?? 1) - 1)));
            const managedSlot = uint(min(float(link.x), float(frames.capacity - 1)));
            const owner = parent ? parent.storage.createParticle(ownerSlot) : null;
            const status = kind === 2 ? frames.states.element(managedSlot) : null;
            const current = producer
              ? this.execution.worldToSimulation().mul(this.execution.simulationToWorld(producer))
                .mul(particleFrameGPU(owner!, this._sourceScaleInheritance()))
              : frames.matrix(managedSlot);
            const generationMatches = owner ? owner.generation.equal(link.y) : status!.y.equal(link.y);
            const alive = owner ? owner.alive.notEqual(uint(0)) : status!.x.notEqual(uint(0));
            const sourceExists = generationMatches.and(alive);
            const pendingBirth = link.w.equal(uint(0)).toVar();
            const orphan = () => {
              if (this.system.sourceLoss === 'kill') {
                particle.kill();
              } else {
                // Pending births cannot attach to an already-reused source slot.
                If(pendingBirth, () => { particle.kill(); });
              }
              packed.assign(vec4(0));
            };
            If(generationMatches.and(abs(determinant(current)).greaterThan(1e-10)), () => {
              const change = mat4(new THREE.Matrix4()).toVar('sourceFrameChange');
              If(link.w.equal(uint(0)), () => {
                change.assign(current);
              }).ElseIf(link.w.equal(uint(1)), () => {
                change.assign(current.mul(inverse(frames.matrix(particle.index, true))));
              });
              transformParticleFrameGPU(particle, change);
              for (let column = 0; column < 4; column++) {
                frames.previous.element(particle.index.mul(4).add(column)).assign(matrixColumnGPU(current, column));
              }
              link.w.assign(uint(1));
              packed.assign(bitcast(link, 'vec4'));
              If(sourceExists.not(), orphan);
            }).Else(() => {
              If(sourceExists.not(), orphan).ElseIf(pendingBirth, () => { particle.kill(); packed.assign(vec4(0)); });
            });
            If(particle.alive.equal(uint(0)).and(pendingBirth.not()), () => {
              context.eventWriter?.emitDeath(particle);
            });
            context.buffers.storage.storeParticle(particle);
          });
        })().compute(context.buffers.capacity));
      }
      this._sourceFrameCompute = { key, nodes };
    }
    this._sourceFrameCompute.nodes.forEach(node => renderer.compute(node));
  }
  invalidateGPUCompute(): void {
    this._sourceFrameCompute?.nodes.forEach(node => node.dispose());
    this._sourceFrameCompute = undefined;
  }
}
