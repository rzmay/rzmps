import * as THREE from 'three';
import { StorageBufferAttribute, type ComputeNode, type WebGPURenderer } from 'three/webgpu';
import { Fn, instanceIndex, storage, uint, vec4 } from 'three/tsl';
import type Particle from '../../core/Particle';
import type ParticleSystem from '../../core/ParticleSystem';
import type { GPUSurfaceQuery } from '../../spatial/surfaces/surfaceSample.types';
import { destroyGPUStorageAttribute } from '../../simulation/gpu/Particle';

/** A compact readback of existing reconstruction kernels; never computes another covariance/neighborhood. */
export default class LiquidDecalSamples {
  private readonly empty = new StorageBufferAttribute(new Float32Array(12), 4);
  private readonly kernels = storage(this.empty, 'vec4', 0).toReadOnly();
  private input?: StorageBufferAttribute;
  private output?: StorageBufferAttribute;
  private node?: ComputeNode;
  private capacity = 0;
  private revision = 0;
  private disposed = false;
  private renderer?: WebGPURenderer;
  private readonly samples = new WeakMap<Particle, { normal: THREE.Vector3; axes: THREE.Matrix3 }>();

  constructor(private readonly sample: GPUSurfaceQuery) {}

  bind(attribute?: StorageBufferAttribute): void {
    this.kernels.value = attribute ?? this.empty;
  }

  async prepare(particles: Particle[], system: ParticleSystem): Promise<void> {
    if (this.disposed || !particles.length || this.kernels.value === this.empty) return;
    const renderer = system.sceneRenderer as WebGPURenderer;
    if (particles.length > this.capacity) {
      this.disposeStorage();
      this.renderer = renderer;
      this.capacity = 2 ** Math.ceil(Math.log2(particles.length));
      this.input = new StorageBufferAttribute(new Float32Array(this.capacity * 4), 4);
      this.output = new StorageBufferAttribute(new Float32Array(this.capacity * 16), 4);
      const input = storage(this.input, 'vec4', this.capacity).toReadOnly();
      const output = storage(this.output, 'vec4', this.capacity * 4);
      this.node = Fn(() => {
        const query = input.element(instanceIndex);
        const surface = this.sample(query.xyz);
        output.element(instanceIndex.mul(4)).assign(vec4(surface.normal, surface.valid.select(1, 0)));
        for (let row = 0; row < 3; row++) {
          output.element(instanceIndex.mul(4).add(row + 1)).assign(this.kernels.element(uint(query.w).mul(3).add(row)));
        }
      })()
        .compute(particles.length)
        .setName('rzmps.liquid.decalSamples');
    }
    const revision = this.revision;
    const data = this.input!.array as Float32Array;
    particles.forEach((particle, index) => {
      const position = particle.position.clone().applyMatrix4(system.getSimulationToWorldMatrix());
      position.toArray(data, index * 4);
      const slot = Number(particle.id.split(':')[1]);
      data[index * 4 + 3] = Number.isFinite(slot) ? slot : 0;
    });
    this.input!.needsUpdate = true;
    this.node!.count = particles.length;
    renderer.compute(this.node!);
    let result: Float32Array;
    try {
      result = new Float32Array(await renderer.getArrayBufferAsync(this.output!, null, 0, particles.length * 64));
    } catch (error) {
      if (this.disposed || revision !== this.revision) return;
      throw error;
    }
    if (revision !== this.revision) return;
    particles.forEach((particle, index) => {
      const offset = index * 16;
      if (!result[offset + 3]) return;
      const rows = [0, 1, 2].map(row => new THREE.Vector3().fromArray(result, offset + (row + 1) * 4));
      // Stored rows are inverse principal axes: invert A^T*A to recover the ellipsoid covariance.
      const a = new THREE.Matrix3().set(
        ...(rows.flatMap(row => row.toArray()) as [
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
        ])
      );
      const covariance = a.clone().transpose().multiply(a).invert();
      const frame = new THREE.Matrix3().setFromMatrix4(system.getSimulationToWorldMatrix());
      covariance.premultiply(frame).multiply(frame.clone().transpose());
      this.samples.set(particle, { normal: new THREE.Vector3().fromArray(result, offset), axes: covariance });
    });
  }

  get(particle: Particle) {
    return this.samples.get(particle);
  }

  private disposeStorage(): void {
    this.revision++;
    this.node?.dispose();
    for (const attribute of [this.input, this.output])
      if (attribute) {
        destroyGPUStorageAttribute(this.renderer, attribute);
        attribute.dispose();
      }
  }

  dispose(): void {
    this.disposed = true;
    this.disposeStorage();
    this.empty.dispose();
    this.capacity = 0;
  }
}
