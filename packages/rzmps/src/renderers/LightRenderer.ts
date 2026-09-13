import * as THREE from 'three';
import Renderer, { RendererOptions } from '../Renderer';
import ParticleSystem from '../ParticleSystem';
import Particle from '../Particle';
import { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';
import particleRatio from '../helpers/particleRatio';

export interface PointLightOptions {
    color?: THREE.Color | string | number;
    intensity?: number;
    distance?: number;
    decay?: number;
    power?: number;
}

export interface LightRendererOptions extends RendererOptions {
    brightness: DynamicValue<number>;
    rangeMultiplier: DynamicValue<number>;
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

class LightRenderer extends Renderer {
    lights: THREE.PointLight[] = [];

    groupingRadiusRatio: number;

    brightness: DynamicValue<number>;

    rangeMultiplier: DynamicValue<number>;

    decay: number;

    ratio: number;

    randomDistribution: boolean;

    inheritParticleColor: boolean;

    sizeAffectsRange: boolean;

    alphaAffectsIntensity: boolean;

    lightOptions: PointLightOptions;

    private lightContainer: THREE.Object3D = new THREE.Object3D();

    private _count = 0;

    get count(): number {
      return this._count;
    }

    set count(value: number) {
      const next = Number.isFinite(value)
        ? Math.max(0, Math.floor(value))
        : 0;

      if (next === this._count) return;

      this._count = next;
      this._syncLightCount();
    }

    constructor(options: Partial<LightRendererOptions> = {}) {
      super(options);

      this.brightness = options.brightness ?? 1;
      this.rangeMultiplier = options.rangeMultiplier ?? 1;
      this.groupingRadiusRatio = options.groupingRadiusRatio ?? 0.25;
      this.lightOptions = options.lightOptions ?? {};
      this.decay = options.decay ?? this.lightOptions.decay ?? 2;
      this.count = options.count ?? 50;
      this.ratio = Math.min(Math.max(options.ratio ?? 1, 0), 1);
      this.randomDistribution = options.randomDistribution ?? true;
      this.inheritParticleColor = options.inheritParticleColor ?? true;
      this.sizeAffectsRange = options.sizeAffectsRange ?? false;
      this.alphaAffectsIntensity = options.alphaAffectsIntensity ?? false;
    }

    setup(system: ParticleSystem): void {
      system.addRendererObject(this.lightContainer);
    }

    _update(particles: Particle[]): void {
      const lightParticles = this._getLightParticles(particles);
      const groups = this._getParticleGroups(lightParticles).slice(0, this.count);

      if (groups.length < this.lights.length) {
        // To reduce initialization lag, just turn intensity to 0
        [...this.lights].splice(groups.length).forEach((light) => { light.intensity = 0; });
      }

      groups.forEach((group, index) => {
        const light = this.lights[index];
        if (!light) return;

        const position = group.reduce(
          (sum, value) => sum.add(value.position),
          new THREE.Vector3(0, 0, 0),
        ).divideScalar(group.length);
        light.position.set(position.x, position.y, position.z);

        const color = new THREE.Color(this.lightOptions.color ?? 0xffffff);
        if (this.inheritParticleColor) {
          color.multiply(group.reduce(
            (sum, value) => sum.add(value.color),
            new THREE.Color(0x000000),
          ).multiplyScalar(1 / group.length));
        }
        light.color = color;

        light.decay = this.lightOptions.decay ?? this.decay;
        light.distance = this._getDistance(group);

        light.intensity = group.reduce(
          (sum, value) => sum + this._getIntensity(value),
          0,
        ) / group.length;
      });
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

    private _getDistance(group: Particle[]): number {
      const distance = this.lightOptions.distance ?? 0;
      if (distance === 0) return 0;

      return group.reduce((sum, particle) => {
        let range = distance * evaluateDynamicNumber(this.rangeMultiplier, particle.time, particle.id);

        if (this.sizeAffectsRange) {
          range *= (particle.scale.x + particle.scale.y + particle.scale.z) / 3;
        }

        return sum + range;
      }, 0) / group.length;
    }

    private _getLightParticles(particles: Particle[]): Particle[] {
      if (this.ratio <= 0) return [];
      if (this.ratio >= 1) return particles;

      if (this.randomDistribution) {
        return particles.filter((particle) => particleRatio(particle, this.ratio));
      }

      const step = Math.max(1, Math.round(1 / this.ratio));
      return particles.filter((particle, index) => index % step === 0);
    }

    private _getParticleGroups(particles: Particle[]): Particle[][] {
      if (particles.length === 0) return [];

      // Group particle
      let particlesCopy = [...particles];
      const radius = this._getGroupingRadius(particles);
      const groups: Particle[][] = [[particlesCopy[0]]];
      particlesCopy.splice(0, 1);

      while (particlesCopy.length > 0) {
        // Get group
        const group = particlesCopy.filter(
          (p) => particlesCopy[0].position.distanceTo(p.position) <= radius,
        );

        // Remove group from particlesCopy
        particlesCopy = particlesCopy.filter(
          (p) => particlesCopy[0].position.distanceTo(p.position) > radius,
        );

        groups.push(group);
      }

      return groups;
    }

    private _getGroupingRadius(particles: Particle[]): number {
      const range = particles.reduce(
        (highest, next) => (highest > next.position.length() ? highest : next.position.length()),
        0,
      ) * 2;

      return this.groupingRadiusRatio * range;
    }

    private _syncLightCount(): void {
      while (this.lights.length < this._count) {
        const light = this._createLight();

        this.lights.push(light);
        this.lightContainer.add(light);
      }

      if (this.lights.length > this._count) {
        const removed = this.lights.splice(this._count);

        removed.forEach((light) => {
          light.removeFromParent();
        });
      }
    }

    destroy(): void {
      this.lightContainer.removeFromParent();
    }
}

export default LightRenderer;
