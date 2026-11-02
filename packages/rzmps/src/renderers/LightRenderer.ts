import * as THREE from 'three';
import Renderer, { type RendererOptions } from '../Renderer';
import ParticleSystem from '../ParticleSystem';
import Particle from '../Particle';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';
import maximumDynamicNumber from '../helpers/maximumDynamicNumber';
import type { GPUParticleBufferState, GPUParticleRenderBufferState } from '../gpu/Particle';
import type { GPUParticleReadbackField } from '../gpu/SelectiveReadback';

export interface PointLightOptions {
    color?: THREE.Color | string | number;
    intensity?: number;
    distance?: number;
    /** Light intensity falloff exponent; defaults to lightOptions.decay or 2. */
    decay?: number;
    power?: number;
}

export interface LightRendererAllocationOptions {
    /** Shrink when required capacity stays below this fraction of the pool. Default 0.75; zero disables shrinking. */
    shrinkThreshold?: number;
    /** Seconds continuously under the threshold before shrinking. Default 1; Infinity disables shrinking. */
    shrinkDelay?: number;
}

export interface LightRendererOptions extends RendererOptions {
    /** Predictive scene-light reservation and shrink hysteresis. */
    allocation: LightRendererAllocationOptions;
    brightness: DynamicValue<number>;
    rangeMultiplier: DynamicValue<number>;
    /** @deprecated Use groupingRadius in world units. */
    groupingRadiusRatio: number;
    decay: number;
    count: number;
    ratio: number;
    randomDistribution: boolean;
    inheritParticleColor: boolean;
    sizeAffectsRange: boolean;
    alphaAffectsIntensity: boolean;
    lightOptions: PointLightOptions;
}

/** Maps a capped selection of particles to scene lights; limit count to control illumination cost. */
class LightRenderer extends Renderer {
    lights: THREE.PointLight[] = [];

    /** @deprecated Alias for groupingRadius, now measured in world units. */
    get groupingRadiusRatio(): number { return this.groupingRadius; }
    set groupingRadiusRatio(value: number) { this.groupingRadius = value; }

    brightness: DynamicValue<number>;

    rangeMultiplier: DynamicValue<number>;

    decay: number;

    randomDistribution: boolean;

    inheritParticleColor: boolean;

    sizeAffectsRange: boolean;

    alphaAffectsIntensity: boolean;

    lightOptions: PointLightOptions;

    private lightContainer: THREE.Object3D = new THREE.Object3D();

    allocation: LightRendererAllocationOptions;
    private system?: ParticleSystem;
    private belowCapacitySince?: number;

    constructor(options: Partial<LightRendererOptions> = {}) {
      super({
        ...options,
        count: options.count ?? 50,
        groupingRadius: options.groupingRadius ?? options.groupingRadiusRatio ?? -1,
      });

      this.allocation = { shrinkThreshold: 0.75, shrinkDelay: 1, ...options.allocation };
      this.brightness = options.brightness ?? 1;
      this.rangeMultiplier = options.rangeMultiplier ?? 1;
      this.lightOptions = options.lightOptions ?? {};
      this.decay = options.decay ?? this.lightOptions.decay ?? 2;
      this.ratio = Math.min(Math.max(options.ratio ?? 1, 0), 1);
      this.randomDistribution = options.randomDistribution ?? true;
      this.inheritParticleColor = options.inheritParticleColor ?? true;
      this.sizeAffectsRange = options.sizeAffectsRange ?? false;
      this.alphaAffectsIntensity = options.alphaAffectsIntensity ?? false;
    }

    setup(system: ParticleSystem): void {
      this.system = system;
      this.resizeLightPool(this.predictLightCount(system));
      system.addRendererObject(this.lightContainer);
    }

    protected get updateGPUUsesCPUReadback(): boolean { return true; }

    protected _updateGPU(
      buffers: GPUParticleBufferState | GPUParticleRenderBufferState,
      system: ParticleSystem,
      deltaTime = 0,
    ): void {
      const sampleLimit = Number.isFinite(this.count) && this.count >= 0
        ? Math.ceil(Math.max(this.count, 1) / Math.max(this.ratio, 0.01)) * 2 : buffers.count;
      const fields: GPUParticleReadbackField[] = ['position', 'time'];
      if (this.inheritParticleColor) fields.push('color');
      if (this.alphaAffectsIntensity) fields.push('alpha');
      if (this.sizeAffectsRange) fields.push('scale');
      this.updateCPUFromGPU(buffers, system, deltaTime, sampleLimit, fields);
    }

    _update(particles: Particle[], system: ParticleSystem | undefined = this.system): void {
      this.resizeLightPool(Math.max(this.predictLightCount(system), particles.length));
      this.lights.forEach((light, index) => {
        const particle = particles[index];
        // Keep reserved light nodes registered so reuse does not rebuild lighting pipelines.
        light.visible = true;
        if (!particle) { light.intensity = 0; return; }
        light.position.copy(particle.position);
        light.color.set(this.lightOptions.color ?? 0xffffff);
        if (this.inheritParticleColor) light.color.multiply(particle.color);
        light.decay = this.lightOptions.decay ?? this.decay;
        light.distance = this._getDistance(particle);
        light.intensity = this._getIntensity(particle);
      });
    }

    private predictLightCount(system?: ParticleSystem): number {
      const cap = this.count < 0 ? Infinity : Math.max(0, this.count);
      const ratio = THREE.MathUtils.clamp(this.ratio, 0, 1);
      if (ratio === 0) return 0;
      // Manual populations and opaque emission can use an explicit finite cap as the fallback.
      const predicted = system?.emitters?.length ? system.estimateParticleCount(this.tags) * ratio : cap;
      const parents = Math.ceil(Math.min(cap, Number.isFinite(predicted) ? predicted : 0));
      const children = Math.floor(maximumDynamicNumber(this.children.count ?? 0,
        ParticleSystem.GPU_DYNAMIC_VALUE_RESOLUTION));
      const quality = system?.quality ?? 1;
      const lod = this.compensation === 'children' && quality > 0 && quality < 1 ? 1 / quality : 1;
      return Math.ceil(parents * (1 + children) * lod);
    }

    /** Monotonic seconds; a wall-time delay also works for asynchronous GPU light updates. */
    protected getAllocationTime(): number { return performance.now() / 1000; }

    private resizeLightPool(required: number): void {
      if (required > this.lights.length) {
        this._syncLightCount(required);
        this.belowCapacitySince = undefined;
        return;
      }
      const threshold = THREE.MathUtils.clamp(this.allocation.shrinkThreshold ?? 0.75, 0, 1);
      const delay = Math.max(0, this.allocation.shrinkDelay ?? 1);
      if (required < this.lights.length * threshold && Number.isFinite(delay)) {
        const now = this.getAllocationTime();
        this.belowCapacitySince ??= now;
        if (now - this.belowCapacitySince >= delay) {
          this._syncLightCount(required);
          this.belowCapacitySince = undefined;
        }
      } else this.belowCapacitySince = undefined;
    }

    private _createLight(): THREE.PointLight {
      const light = new THREE.PointLight(
        this.lightOptions.color ?? 0xffffff,
        0,
        this.lightOptions.distance ?? 0,
        this.decay,
      );

      if (this.lightOptions.power !== undefined) light.power = this.lightOptions.power;

      return light;
    }

    private _getIntensity(particle: Particle): number {
      let intensity = (this.lightOptions.intensity ?? 1)
        * evaluateDynamicNumber(this.brightness, particle.time, particle.id);

      if (this.alphaAffectsIntensity) {
        intensity *= particle.alpha;
      }

      return intensity;
    }

    private _getDistance(particle: Particle): number {
      const distance = this.lightOptions.distance ?? 0;
      if (distance === 0) return 0;
      let range = distance * evaluateDynamicNumber(this.rangeMultiplier, particle.time, particle.id);
      if (this.sizeAffectsRange) range *= (particle.scale.x + particle.scale.y + particle.scale.z) / 3;
      return range;
    }

    private _syncLightCount(capacity: number): void {
      while (this.lights.length < capacity) {
        const light = this._createLight();

        this.lights.push(light);
        this.lightContainer.add(light);
      }

      if (this.lights.length > capacity) {
        const removed = this.lights.splice(capacity);

        removed.forEach((light) => {
          light.removeFromParent();
        });
      }
    }

    destroy(): void {
      this.reset();
      this.system = undefined;
      this.lightContainer.removeFromParent();
    }

    clear(): void {
      this.cancelGPUSelectiveReadback();
      this._update([])
    }
}

export default LightRenderer;
