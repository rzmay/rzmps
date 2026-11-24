import * as THREE from 'three';
import { bitcast, float, int, ivec2, textureLoad, uint, uniform } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type ParticleSystem from '../../core/ParticleSystem';
import type { GPUParticleBufferState, GPUParticleLike } from './Particle';

/** Shader view of a registered emission origin. Missing/reused sources are invalid and read as empty. */
export interface GPUGasSource {
  readonly valid: Node<'bool'>;
  readonly age: Node<'float'>;
  readonly lifetime: Node<'float'>;
  /** Numeric and boolean metadata by arbitrary key. Missing keys read as zero. */
  readonly metadata: Readonly<Record<string, Node<'float'>>>;
}

export interface GPUGasSourceParticle extends GPUParticleLike {
  readonly source: GPUGasSource;
}

/** Live registered-source data over the existing generation-checked source slots. @internal */
export default class GasSourceData {
  private readonly keys: string[] = [];
  private system?: ParticleSystem;
  private width = 2;
  private height = 1;
  private data = new Float32Array(8);
  private readonly count = uniform(0, 'uint');
  private readonly texture = new THREE.DataTexture(this.data, 2, 1, THREE.RGBAFormat, THREE.FloatType);

  constructor() {
    this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  /** Upload scalar source state once per simulation boundary, never per cell and never via readback. */
  update(system: ParticleSystem): void {
    this.system = system;
    const records = system.frameRuntime._sourceFrames?.records ?? [];
    const width = 2 ** Math.ceil(Math.log2(Math.max(2, this.keys.length + 2)));
    const height = 2 ** Math.ceil(Math.log2(Math.max(1, records.length)));
    if (width !== this.width || height !== this.height) {
      // Three allocates texture storage once. Recreate the backing image, keeping shader-node identity stable.
      this.texture.dispose();
      this.width = width; this.height = height;
      this.data = new Float32Array(width * height * 4);
      this.texture.image = { data: this.data, width, height };
    }
    this.data.fill(0);
    this.count.value = records.length;
    for (const record of records) {
      const source = record.source, offset = record.slot * width * 4;
      const age = Number.isFinite(source.age) ? source.age : 0;
      const lifetime = Number.isFinite(source.lifetime) ? source.lifetime : 1e30;
      this.data.set([age, lifetime,
        record.generation & 0xffff, record.generation >>> 16, source.alive ? 1 : 0], offset);
      const metadata = 'metadata' in source ? source.metadata as Record<string, unknown> | undefined : undefined;
      this.keys.forEach((key, column) => {
        const value = metadata?.[key];
        if (value !== undefined && typeof value !== 'number' && typeof value !== 'boolean') {
          throw new TypeError(`GPU gas source metadata '${key}' must be numeric or boolean.`);
        }
        if (typeof value === 'number' && !Number.isFinite(value)) {
          throw new RangeError(`GPU gas source metadata '${key}' must be finite.`);
        }
        this.data[offset + (column + 2) * 4] = Number(value ?? 0);
      });
    }
    this.texture.needsUpdate = true;
  }

  particle(particle: GPUParticleLike, buffers: GPUParticleBufferState): GPUGasSourceParticle {
    const link = bitcast(buffers.storage.createSourceIdentityNode(particle.index), 'uvec4') as unknown as Node<'uvec4'>;
    const state = textureLoad(this.texture, ivec2(0, int(link.x)));
    const alive = textureLoad(this.texture, ivec2(1, int(link.x))).x;
    const generation = uint(state.z).bitOr(uint(state.w).shiftLeft(16));
    const valid = link.z.equal(2).and(link.x.lessThan(this.count))
      .and(link.y.equal(generation)).and(alive.greaterThan(0));
    const metadata = new Proxy({} as Record<string, Node<'float'>>, { get: (_target, key) => {
      if (typeof key !== 'string') return undefined;
      let column = this.keys.indexOf(key);
      if (column < 0) {
        column = this.keys.length; this.keys.push(key);
        // Metadata paths are discovered while the shader graph is built, before bindings upload.
        if (this.system) this.update(this.system);
      }
      return valid.select(textureLoad(this.texture, ivec2(column + 2, int(link.x))).x, float(0));
    } });
    // The particle view itself remains the existing sparse-query view, with one lazy source accessor.
    return new Proxy(particle as GPUGasSourceParticle, { get: (target, key) => key === 'source'
      ? { valid, age: valid.select(state.x, float(0)), lifetime: valid.select(state.y, float(1)), metadata }
      : Reflect.get(target, key) });
  }

  dispose(): void { this.texture.dispose(); }
}
