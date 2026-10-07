import * as THREE from 'three';
import FluidSimulation, { type FluidSimulationOptions } from './FluidSimulation';
import ParticleOctree, { type OctreeConfig } from '../helpers/ParticleOctree';
import ParticleSystem from '../ParticleSystem';
import tagsIntersect from '../helpers/tagsIntersect';
import Particle from '../Particle';
import type { OctreeAggregator, OctreeNode } from '../helpers/ParticleOctree';
import type { VolumeField } from '../interfaces/VolumeField';

interface FluidSourceAggregate {
  count: number;
  mass: number;
  momentum: THREE.Vector3;
  density: number;
  temperatureMass: number;
  color: THREE.Vector3;
  radius: number;
}

const FluidSourceAggregator: OctreeAggregator<FluidSourceAggregate> = {
  new: (
    particle?: Particle,
    _particleIndex?: number,
    _node?: OctreeNode<FluidSourceAggregate>,
  ) => {
    const alpha = particle?.alpha ?? 1;
    const mass = (particle?.mass ?? 0) * alpha;
    const density = typeof particle?.data?.density === 'number'
      ? particle.data.density * alpha
      : mass;
    const temperature = typeof particle?.data?.temperature === 'number'
      ? particle.data.temperature
      : 0;
    const radius = typeof particle?.data?.fluidRadius === 'number'
      ? particle.data.fluidRadius
      : Math.max(
        particle?.scale.x ?? 0,
        particle?.scale.y ?? 0,
        particle?.scale.z ?? 0,
      ) * 0.5;

    return {
      count: particle ? 1 : 0,
      mass,
      momentum: particle ? particle.velocity.clone().multiplyScalar(mass) : new THREE.Vector3(),
      density,
      temperatureMass: temperature * mass,
      color: particle
        ? new THREE.Vector3(particle.color.r, particle.color.g, particle.color.b)
        : new THREE.Vector3(),
      radius: particle ? Math.max(radius, 0) : 0,
    };
  },
  combine: (a, b) => {
    const currentWeight = Math.max(a.density, a.mass, 0);
    const nextWeight = Math.max(b.density, b.mass, 0);
    const totalWeight = currentWeight + nextWeight;

    if (totalWeight > 0) {
      a.color.multiplyScalar(currentWeight)
        .add(b.color.clone().multiplyScalar(nextWeight))
        .divideScalar(totalWeight);
      a.radius = (a.radius * currentWeight + b.radius * nextWeight) / totalWeight;
    }

    a.count += b.count;
    a.mass += b.mass;
    a.momentum.add(b.momentum);
    a.density += b.density;
    a.temperatureMass += b.temperatureMass;

    return a;
  },
};

export interface GasSimulationOptions extends FluidSimulationOptions {
  densityDissipation: number;
  temperatureDissipation: number;
  velocityDissipation: number;
  buoyancy: number;
  weight: number;
  sourceStrength: number;
  velocitySourceStrength: number;
  octreeOptions: Partial<OctreeConfig>;
}

class GasSimulation extends FluidSimulation {
  density: VolumeField;
  temperature: Float32Array;
  densityDissipation: number;
  temperatureDissipation: number;
  velocityDissipation: number;
  buoyancy: number;
  weight: number;
  sourceStrength: number;
  velocitySourceStrength: number;
  octreeOptions: Partial<OctreeConfig>;

  private sourceOctree: ParticleOctree<FluidSourceAggregate>;
  private cellCoordinate = new THREE.Vector3();
  private splatCenter = new THREE.Vector3();
  private densityData: Float32Array;
  private renderDensityData: Float32Array;
  private colorFieldData: Float32Array;
  autoBounds: boolean;
  private visualRefreshParticles: Particle[] = [];
  private visualBounds = new THREE.Box3();
  private visualBoundsMin = new THREE.Vector3();
  private visualBoundsMax = new THREE.Vector3();

  constructor(options: Partial<GasSimulationOptions> = {}) {
    const maxDepth = GasSimulation.getOctreeMaxDepth(options);

    super({
      ...options,
      resolution: 2 ** maxDepth,
    });
    this.autoBounds = !options.bounds;
    this.densityData = new Float32Array(this.cellCount);
    this.renderDensityData = new Float32Array(this.cellCount);
    this.colorFieldData = new Float32Array(this.cellCount * 4);
    this.colorField.channels = 4;
    this.density = {
      data: this.renderDensityData,
      resolution: new THREE.Vector3(this.resolution, this.resolution, this.resolution),
      bounds: this.bounds.clone(),
      version: 0,
      channels: 1,
    };
    this.temperature = new Float32Array(this.cellCount);
    this.densityDissipation = options.densityDissipation ?? 0.99;
    this.temperatureDissipation = options.temperatureDissipation ?? 0.98;
    this.colorDissipation = options.colorDissipation ?? this.densityDissipation;
    this.velocityDissipation = options.velocityDissipation ?? 0.99;
    this.buoyancy = options.buoyancy ?? 1;
    this.weight = options.weight ?? 0;
    this.sourceStrength = options.sourceStrength ?? 1;
    this.velocitySourceStrength = options.velocitySourceStrength ?? 0.12;
    this.octreeOptions = {
      bounds: options.bounds?.clone() ?? this.bounds.clone(),
      maxDepth,
      particlesPerLeaf: options.octreeOptions?.particlesPerLeaf ?? 4,
      quantizeBounds: options.octreeOptions?.quantizeBounds ?? (this.autoBounds ? 2 : 0),
      timeQuality: options.octreeOptions?.timeQuality ?? 1,
      brickLevel: options.octreeOptions?.brickLevel,
    };
    this.sourceOctree = new ParticleOctree(this.octreeOptions, FluidSourceAggregator);
  }

  private static getOctreeMaxDepth(options: Partial<GasSimulationOptions>): number {
    if (options.octreeOptions?.maxDepth !== undefined) {
      return Math.max(1, Math.floor(options.octreeOptions.maxDepth));
    }

    const requestedResolution = Math.max(1, Math.floor(options.resolution ?? 16));

    return Math.max(1, Math.ceil(Math.log2(requestedResolution)));
  }

  update(dt: number, particleSystem?: ParticleSystem): void {
    if (particleSystem) {
      const sourceParticles = particleSystem.particles.filter((particle) => (
        (!this.tags || tagsIntersect(this.tags, particle.tags ?? []))
        && this.condition(particle)
      ));

      this.sourceOctree.setBounds(particleSystem.boundingBox.isEmpty()
        ? this.bounds
        : particleSystem.boundingBox);
      this.sourceOctree.rebuild(sourceParticles);
      this.syncBoundsFromSourceOctree();
    }

    this.injectParticleSources();
    this.advectVelocity(dt, this.velocityDissipation);
    this.applyBuoyancy(dt);
    this.applyExternalForces(dt);
    this.calculateDivergence();
    this.solvePressure();
    this.projectVelocity();

    const nextDensity = new Float32Array(this.cellCount);
    const nextTemperature = new Float32Array(this.cellCount);
    const nextColor = new Float32Array(this.cellCount * 3);

    this.advectScalar(this.densityData, nextDensity, dt, this.densityDissipation);
    this.advectScalar(this.temperature, nextTemperature, dt, this.temperatureDissipation);
    this.advectColor(nextColor, dt);
    this.densityData = nextDensity;
    this.temperature = nextTemperature;
    this.color = nextColor;
    this.publishBaseRenderFields();
  }

  public refreshRenderFields(particleSystem?: ParticleSystem): void {
    this.renderDensityData.set(this.densityData);
    this.rebuildNormalizedColorField(this.densityData, this.color);

    if (particleSystem) {
      this.visualRefreshParticles = particleSystem.particles.filter((particle) => (
        (!this.tags || tagsIntersect(this.tags, particle.tags ?? []))
        && this.condition(particle)
      ));
      this.sourceOctree.setBounds(this.getParticleBounds(this.visualRefreshParticles));
      this.sourceOctree.rebuild(this.visualRefreshParticles);
      this.applyVisualParticleSources();
    }

    this.density.data = this.renderDensityData;
    this.density.bounds.copy(this.bounds);
    this.density.version += 1;
    this.updateColorField(this.colorFieldData);
  }

  private getParticleBounds(particles: Particle[]): THREE.Box3 {
    this.visualBounds.makeEmpty();

    particles.forEach((particle) => {
      const radius = Math.max(
        Math.abs(particle.scale.x),
        Math.abs(particle.scale.y),
        Math.abs(particle.scale.z),
        Number.EPSILON,
      );

      this.visualBounds.expandByPoint(this.visualBoundsMin.copy(particle.position).addScalar(-radius));
      this.visualBounds.expandByPoint(this.visualBoundsMax.copy(particle.position).addScalar(radius));
    });

    return this.visualBounds.isEmpty() ? this.bounds : this.visualBounds;
  }

  private publishBaseRenderFields(): void {
    this.renderDensityData.set(this.densityData);
    this.rebuildNormalizedColorField(this.densityData, this.color);
    this.density.data = this.renderDensityData;
    this.density.bounds.copy(this.bounds);
    this.density.version += 1;
    this.updateColorField(this.colorFieldData);
  }

  protected getColorDensity(index: number): number {
    return this.densityData[index];
  }

  private injectParticleSources(): void {
    this.sourceOctree.forEachGridCell((cell) => {
      const source = cell.aggregate;

      if (source.count === 0) return;

      this.splatSource(cell.center, source);
    }, {
      exact: true,
      occupiedOnly: true,
    });
  }

  private splatSource(position: THREE.Vector3, source: FluidSourceAggregate): void {
    this.worldToCell(position, this.cellCoordinate);

    const radius = Math.max(source.radius, this.cellSize * 0.5);
    const cellRadius = Math.max(0, Math.ceil(radius / this.cellSize));
    const strength = this.sourceStrength;
    let totalWeight = 0;

    for (let z = this.cellCoordinate.z - cellRadius; z <= this.cellCoordinate.z + cellRadius; z += 1) {
      for (let y = this.cellCoordinate.y - cellRadius; y <= this.cellCoordinate.y + cellRadius; y += 1) {
        for (let x = this.cellCoordinate.x - cellRadius; x <= this.cellCoordinate.x + cellRadius; x += 1) {
          if (!this.isCellInBounds(x, y, z)) continue;

          this.getCellCenter(x, y, z, this.splatCenter);
          const distance = this.splatCenter.distanceTo(position);

          if (distance > radius) continue;
          totalWeight += Math.max(0, 1 - distance / radius);
        }
      }
    }

    if (totalWeight <= 0) totalWeight = 1;

    for (let z = this.cellCoordinate.z - cellRadius; z <= this.cellCoordinate.z + cellRadius; z += 1) {
      for (let y = this.cellCoordinate.y - cellRadius; y <= this.cellCoordinate.y + cellRadius; y += 1) {
        for (let x = this.cellCoordinate.x - cellRadius; x <= this.cellCoordinate.x + cellRadius; x += 1) {
          if (!this.isCellInBounds(x, y, z)) continue;

          this.getCellCenter(x, y, z, this.splatCenter);
          const distance = this.splatCenter.distanceTo(position);

          if (distance > radius) continue;

          const weight = Math.max(0, 1 - distance / radius) / totalWeight;
          const index = this.index(x, y, z);
          const velocityIndex = index * 3;
          const colorIndex = index * 3;
          const density = source.density * strength * weight;

          this.densityData[index] += density;
          this.color[colorIndex] += source.color.x * density;
          this.color[colorIndex + 1] += source.color.y * density;
          this.color[colorIndex + 2] += source.color.z * density;

          if (source.mass > 0) {
            this.temperature[index] += (source.temperatureMass / source.mass) * strength * weight;
            const blend = THREE.MathUtils.clamp(
              density * this.velocitySourceStrength,
              0,
              1,
            );
            this.velocity[velocityIndex] = THREE.MathUtils.lerp(
              this.velocity[velocityIndex],
              source.momentum.x / source.mass,
              blend,
            );
            this.velocity[velocityIndex + 1] = THREE.MathUtils.lerp(
              this.velocity[velocityIndex + 1],
              source.momentum.y / source.mass,
              blend,
            );
            this.velocity[velocityIndex + 2] = THREE.MathUtils.lerp(
              this.velocity[velocityIndex + 2],
              source.momentum.z / source.mass,
              blend,
            );
          }
        }
      }
    }

    this.clampVelocity();
  }

  private applyBuoyancy(dt: number): void {
    for (let index = 0; index < this.cellCount; index += 1) {
      const lift = this.temperature[index] * this.buoyancy - this.densityData[index] * this.weight;

      this.velocity[index * 3 + 1] += lift * dt;
    }

    this.clampVelocity();
  }

  private rebuildNormalizedColorField(
    densityData: Float32Array,
    colorData: Float32Array,
  ): void {
    for (let index = 0; index < this.cellCount; index += 1) {
      const sourceColorIndex = index * 3;
      const colorIndex = index * 4;
      const density = densityData[index];

      const red = colorData[sourceColorIndex] / Math.max(density, Number.EPSILON);
      const green = colorData[sourceColorIndex + 1] / Math.max(density, Number.EPSILON);
      const blue = colorData[sourceColorIndex + 2] / Math.max(density, Number.EPSILON);
      if (density <= 0) {
        this.colorFieldData[colorIndex] = 0;
        this.colorFieldData[colorIndex + 1] = 0;
        this.colorFieldData[colorIndex + 2] = 0;
        this.colorFieldData[colorIndex + 3] = 0;
        continue;
      }

      this.colorFieldData[colorIndex] = THREE.MathUtils.clamp(red, 0, 1);
      this.colorFieldData[colorIndex + 1] = THREE.MathUtils.clamp(green, 0, 1);
      this.colorFieldData[colorIndex + 2] = THREE.MathUtils.clamp(blue, 0, 1);
      this.colorFieldData[colorIndex + 3] = 1;
    }
  }

  private applyVisualParticleSources(): void {
    this.sourceOctree.forEachGridCell((cell) => {
      const source = cell.aggregate;

      if (source.count === 0) return;

      this.splatVisualSource(cell.center, source);
    }, {
      exact: true,
      occupiedOnly: true,
    });
  }

  private splatVisualSource(position: THREE.Vector3, source: FluidSourceAggregate): void {
    this.worldToCell(position, this.cellCoordinate);

    const radius = Math.max(source.radius, this.cellSize * 0.5);
    const cellRadius = Math.max(0, Math.ceil(radius / this.cellSize));
    let totalWeight = 0;

    for (let z = this.cellCoordinate.z - cellRadius; z <= this.cellCoordinate.z + cellRadius; z += 1) {
      for (let y = this.cellCoordinate.y - cellRadius; y <= this.cellCoordinate.y + cellRadius; y += 1) {
        for (let x = this.cellCoordinate.x - cellRadius; x <= this.cellCoordinate.x + cellRadius; x += 1) {
          if (!this.isCellInBounds(x, y, z)) continue;

          this.getCellCenter(x, y, z, this.splatCenter);
          const distance = this.splatCenter.distanceTo(position);

          if (distance > radius) continue;
          totalWeight += Math.max(0, 1 - distance / radius);
        }
      }
    }

    if (totalWeight <= 0) totalWeight = 1;

    for (let z = this.cellCoordinate.z - cellRadius; z <= this.cellCoordinate.z + cellRadius; z += 1) {
      for (let y = this.cellCoordinate.y - cellRadius; y <= this.cellCoordinate.y + cellRadius; y += 1) {
        for (let x = this.cellCoordinate.x - cellRadius; x <= this.cellCoordinate.x + cellRadius; x += 1) {
          if (!this.isCellInBounds(x, y, z)) continue;

          this.getCellCenter(x, y, z, this.splatCenter);
          const distance = this.splatCenter.distanceTo(position);

          if (distance > radius) continue;

          const weight = Math.max(0, 1 - distance / radius) / totalWeight;
          const index = this.index(x, y, z);
          const colorIndex = index * 4;
          const density = source.density * this.sourceStrength * weight;
          const previousDensity = this.renderDensityData[index];
          const nextDensity = previousDensity + density;

          if (nextDensity <= 0) continue;

          this.colorFieldData[colorIndex] = (
            this.colorFieldData[colorIndex] * previousDensity + source.color.x * density
          ) / nextDensity;
          this.colorFieldData[colorIndex + 1] = (
            this.colorFieldData[colorIndex + 1] * previousDensity + source.color.y * density
          ) / nextDensity;
          this.colorFieldData[colorIndex + 2] = (
            this.colorFieldData[colorIndex + 2] * previousDensity + source.color.z * density
          ) / nextDensity;
          this.colorFieldData[colorIndex + 3] = Math.max(this.colorFieldData[colorIndex + 3], source.mass > 0 ? 1 : 0);
          this.renderDensityData[index] = nextDensity;
        }
      }
    }
  }

  private syncBoundsFromSourceOctree(): void {
    if (!this.autoBounds || this.sourceOctree.bounds.isEmpty()) return;
    if (
      this.bounds.containsPoint(this.sourceOctree.bounds.min)
      && this.bounds.containsPoint(this.sourceOctree.bounds.max)
    ) return;

    this.setSimulationBounds(this.sourceOctree.bounds);
    this.clearSimulationState();
    this.densityData.fill(0);
    this.renderDensityData.fill(0);
    this.temperature.fill(0);
    this.colorFieldData.fill(0);
    this.density.bounds.copy(this.bounds);
    this.density.version += 1;
  }
}

export default GasSimulation;
