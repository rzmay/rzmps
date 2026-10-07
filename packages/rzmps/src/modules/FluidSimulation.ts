import * as THREE from 'three';
import Module, { type ModuleOptions, type ModuleUpdate } from '../Module';
import ParticleSystem from '../ParticleSystem';
import Particle from '../Particle';
import type { VolumeField } from '../interfaces/VolumeField';

export interface FluidSimulationOptions extends Partial<ModuleOptions> {
  bounds: THREE.Box3;
  resolution: number;
  pressureIterations: number;
  externalForce: THREE.Vector3;
  colorDissipation: number;
  maxVelocity: number;
}

abstract class FluidSimulation extends Module {
  bounds: THREE.Box3;
  resolution: number;
  cellSize: number;
  pressureIterations: number;
  externalForce: THREE.Vector3;
  velocity: Float32Array;
  pressure: Float32Array;
  divergence: Float32Array;
  color: Float32Array;
  colorField: VolumeField;
  colorDissipation: number;
  maxVelocity: number;

  protected cellCount: number;
  protected min = new THREE.Vector3();
  protected size = new THREE.Vector3();
  protected samplePosition = new THREE.Vector3();
  protected tempVelocity = new THREE.Vector3();
  protected pressureScratch: Float32Array;
  protected velocityScratch: Float32Array;

  constructor(
    options: Partial<FluidSimulationOptions> = {},
    modify: ModuleUpdate = () => {},
  ) {
    super(modify, {
      ...options,
      priority: options.priority ?? Module.Priority.Permanent,
    });

    this.bounds = options.bounds?.clone() ?? new THREE.Box3(
      new THREE.Vector3(-0.5, -0.5, -0.5),
      new THREE.Vector3(0.5, 0.5, 0.5),
    );
    this.resolution = Math.max(1, Math.floor(options.resolution ?? 16));
    this.pressureIterations = Math.max(0, Math.floor(options.pressureIterations ?? 12));
    this.externalForce = options.externalForce?.clone() ?? new THREE.Vector3(0, -9.81, 0);
    this.colorDissipation = options.colorDissipation ?? 0.99;
    this.maxVelocity = Math.max(0, options.maxVelocity ?? 20);
    this.bounds.getSize(this.size);
    this.min.copy(this.bounds.min);
    this.cellSize = Math.max(
      this.size.x,
      this.size.y,
      this.size.z,
      Number.EPSILON,
    ) / this.resolution;
    this.cellCount = this.resolution ** 3;
    this.velocity = new Float32Array(this.cellCount * 3);
    this.pressure = new Float32Array(this.cellCount);
    this.pressureScratch = new Float32Array(this.cellCount);
    this.divergence = new Float32Array(this.cellCount);
    this.color = new Float32Array(this.cellCount * 3);
    this.velocityScratch = new Float32Array(this.cellCount * 3);
    this.colorField = {
      data: this.color,
      resolution: new THREE.Vector3(this.resolution, this.resolution, this.resolution),
      bounds: this.bounds.clone(),
      version: 0,
      channels: 3,
    };

    this.dependents.push(new FluidVisualRefreshModule(this));
  }

  abstract update(dt: number, particleSystem?: ParticleSystem): void;

  public prepare(particleSystem: ParticleSystem, deltaTime: number): void {
    super.prepare(particleSystem, deltaTime);
    this.update(deltaTime, particleSystem);
  }

  index(x: number, y: number, z: number): number {
    const cx = this.clampCoordinate(x);
    const cy = this.clampCoordinate(y);
    const cz = this.clampCoordinate(z);

    return cx + cy * this.resolution + cz * this.resolution * this.resolution;
  }

  velocityIndex(x: number, y: number, z: number): number {
    return this.index(x, y, z) * 3;
  }

  sampleVelocity(position: THREE.Vector3, target = new THREE.Vector3()): THREE.Vector3 {
    return this.sampleVectorField(this.velocity, position, target);
  }

  sampleColor(position: THREE.Vector3, target = new THREE.Color()): THREE.Color {
    const coordinate = this.worldToCell(position);

    return this.getCellColor(coordinate.x, coordinate.y, coordinate.z, target);
  }

  getCellColor(x: number, y: number, z: number, target = new THREE.Color()): THREE.Color {
    const index = this.index(x, y, z);
    const colorIndex = index * 3;
    const density = this.getColorDensity(index);

    if (density <= 0) return target.setRGB(0, 0, 0);

    return target.setRGB(
      this.color[colorIndex] / density,
      this.color[colorIndex + 1] / density,
      this.color[colorIndex + 2] / density,
    );
  }

  protected getColorDensity(_index: number): number {
    return 1;
  }

  protected updateColorField(data: Float32Array | Uint8Array = this.color): void {
    this.colorField.data = data;
    this.colorField.bounds.copy(this.bounds);
    this.colorField.version += 1;
  }

  public refreshRenderFields(_particleSystem: ParticleSystem): void {}

  protected setSimulationBounds(bounds: THREE.Box3): void {
    this.bounds.copy(bounds);
    this.bounds.getSize(this.size);
    this.min.copy(this.bounds.min);
    this.cellSize = Math.max(
      this.size.x,
      this.size.y,
      this.size.z,
      Number.EPSILON,
    ) / this.resolution;
    this.colorField.bounds.copy(this.bounds);
    this.colorField.version += 1;
  }

  protected clearSimulationState(): void {
    this.velocity.fill(0);
    this.velocityScratch.fill(0);
    this.pressure.fill(0);
    this.pressureScratch.fill(0);
    this.divergence.fill(0);
    this.color.fill(0);
    this.updateColorField();
  }

  protected applyExternalForces(dt: number): void {
    for (let index = 0; index < this.cellCount; index += 1) {
      const velocityIndex = index * 3;

      this.velocity[velocityIndex] += this.externalForce.x * dt;
      this.velocity[velocityIndex + 1] += this.externalForce.y * dt;
      this.velocity[velocityIndex + 2] += this.externalForce.z * dt;
    }

    this.clampVelocity();
  }

  protected calculateDivergence(): void {
    const scale = 0.5 / this.cellSize;

    for (let z = 0; z < this.resolution; z += 1) {
      for (let y = 0; y < this.resolution; y += 1) {
        for (let x = 0; x < this.resolution; x += 1) {
          const left = this.velocity[this.velocityIndex(x - 1, y, z)];
          const right = this.velocity[this.velocityIndex(x + 1, y, z)];
          const down = this.velocity[this.velocityIndex(x, y - 1, z) + 1];
          const up = this.velocity[this.velocityIndex(x, y + 1, z) + 1];
          const back = this.velocity[this.velocityIndex(x, y, z - 1) + 2];
          const front = this.velocity[this.velocityIndex(x, y, z + 1) + 2];

          this.divergence[this.index(x, y, z)] = (
            (right - left)
            + (up - down)
            + (front - back)
          ) * scale;
        }
      }
    }
  }

  protected solvePressure(): void {
    this.pressure.fill(0);

    for (let iteration = 0; iteration < this.pressureIterations; iteration += 1) {
      this.pressureScratch.fill(0);

      for (let z = 0; z < this.resolution; z += 1) {
        for (let y = 0; y < this.resolution; y += 1) {
          for (let x = 0; x < this.resolution; x += 1) {
            const index = this.index(x, y, z);
            const sum = this.pressure[this.index(x - 1, y, z)]
              + this.pressure[this.index(x + 1, y, z)]
              + this.pressure[this.index(x, y - 1, z)]
              + this.pressure[this.index(x, y + 1, z)]
              + this.pressure[this.index(x, y, z - 1)]
              + this.pressure[this.index(x, y, z + 1)];

            this.pressureScratch[index] = (sum - this.divergence[index] * this.cellSize * this.cellSize) / 6;
          }
        }
      }

      [this.pressure, this.pressureScratch] = [this.pressureScratch, this.pressure];
    }
  }

  protected projectVelocity(): void {
    const scale = 0.5 / this.cellSize;

    for (let z = 0; z < this.resolution; z += 1) {
      for (let y = 0; y < this.resolution; y += 1) {
        for (let x = 0; x < this.resolution; x += 1) {
          const velocityIndex = this.velocityIndex(x, y, z);

          this.velocity[velocityIndex] -= (
            this.pressure[this.index(x + 1, y, z)]
            - this.pressure[this.index(x - 1, y, z)]
          ) * scale;
          this.velocity[velocityIndex + 1] -= (
            this.pressure[this.index(x, y + 1, z)]
            - this.pressure[this.index(x, y - 1, z)]
          ) * scale;
          this.velocity[velocityIndex + 2] -= (
            this.pressure[this.index(x, y, z + 1)]
            - this.pressure[this.index(x, y, z - 1)]
          ) * scale;
        }
      }
    }

    this.clampVelocity();
  }

  protected advectScalar(
    source: Float32Array,
    target: Float32Array,
    dt: number,
    dissipation = 1,
  ): void {
    for (let z = 0; z < this.resolution; z += 1) {
      for (let y = 0; y < this.resolution; y += 1) {
        for (let x = 0; x < this.resolution; x += 1) {
          this.getCellCenter(x, y, z, this.samplePosition);
          this.tempVelocity.copy(this.sampleVelocityAtCell(x, y, z)).multiplyScalar(dt);
          this.samplePosition.sub(this.tempVelocity);
          target[this.index(x, y, z)] = this.sampleScalarField(source, this.samplePosition) * dissipation;
        }
      }
    }
  }

  protected advectVelocity(dt: number, dissipation = 1): void {
    this.velocityScratch.set(this.velocity);

    for (let z = 0; z < this.resolution; z += 1) {
      for (let y = 0; y < this.resolution; y += 1) {
        for (let x = 0; x < this.resolution; x += 1) {
          this.getCellCenter(x, y, z, this.samplePosition);
          this.sampleVectorField(this.velocityScratch, this.samplePosition, this.tempVelocity).multiplyScalar(dt);
          this.samplePosition.sub(this.tempVelocity);

          const velocityIndex = this.velocityIndex(x, y, z);
          this.sampleVectorField(this.velocityScratch, this.samplePosition, this.tempVelocity).multiplyScalar(dissipation);
          this.velocity[velocityIndex] = this.tempVelocity.x;
          this.velocity[velocityIndex + 1] = this.tempVelocity.y;
          this.velocity[velocityIndex + 2] = this.tempVelocity.z;
        }
      }
    }

    this.clampVelocity();
  }

  protected advectColor(target: Float32Array, dt: number, dissipation = this.colorDissipation): void {
    const red = new Float32Array(this.cellCount);
    const green = new Float32Array(this.cellCount);
    const blue = new Float32Array(this.cellCount);
    const nextRed = new Float32Array(this.cellCount);
    const nextGreen = new Float32Array(this.cellCount);
    const nextBlue = new Float32Array(this.cellCount);

    for (let index = 0; index < this.cellCount; index += 1) {
      const colorIndex = index * 3;

      red[index] = this.color[colorIndex];
      green[index] = this.color[colorIndex + 1];
      blue[index] = this.color[colorIndex + 2];
    }

    this.advectScalar(red, nextRed, dt, dissipation);
    this.advectScalar(green, nextGreen, dt, dissipation);
    this.advectScalar(blue, nextBlue, dt, dissipation);

    for (let index = 0; index < this.cellCount; index += 1) {
      const colorIndex = index * 3;

      target[colorIndex] = nextRed[index];
      target[colorIndex + 1] = nextGreen[index];
      target[colorIndex + 2] = nextBlue[index];
    }
  }

  protected getCellCenter(x: number, y: number, z: number, target = new THREE.Vector3()): THREE.Vector3 {
    return target.set(
      this.min.x + (this.clampCoordinate(x) + 0.5) * this.cellSize,
      this.min.y + (this.clampCoordinate(y) + 0.5) * this.cellSize,
      this.min.z + (this.clampCoordinate(z) + 0.5) * this.cellSize,
    );
  }

  protected worldToCell(position: THREE.Vector3, target = new THREE.Vector3()): THREE.Vector3 {
    return target.set(
      this.clampCoordinate(Math.floor((position.x - this.min.x) / this.cellSize)),
      this.clampCoordinate(Math.floor((position.y - this.min.y) / this.cellSize)),
      this.clampCoordinate(Math.floor((position.z - this.min.z) / this.cellSize)),
    );
  }

  protected sampleVectorField(
    field: Float32Array,
    position: THREE.Vector3,
    target = new THREE.Vector3(),
  ): THREE.Vector3 {
    const coordinate = this.worldToCell(position);
    const velocityIndex = this.velocityIndex(coordinate.x, coordinate.y, coordinate.z);

    return target.set(
      field[velocityIndex],
      field[velocityIndex + 1],
      field[velocityIndex + 2],
    );
  }

  protected sampleScalarField(field: Float32Array, position: THREE.Vector3): number {
    const coordinate = this.worldToCell(position);

    return field[this.index(coordinate.x, coordinate.y, coordinate.z)];
  }

  protected sampleVelocityAtCell(x: number, y: number, z: number): THREE.Vector3 {
    const velocityIndex = this.velocityIndex(x, y, z);

    return this.tempVelocity.set(
      this.velocity[velocityIndex],
      this.velocity[velocityIndex + 1],
      this.velocity[velocityIndex + 2],
    );
  }

  protected clampCoordinate(value: number): number {
    return THREE.MathUtils.clamp(Math.floor(value), 0, this.resolution - 1);
  }

  protected isCellInBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && x < this.resolution
      && y >= 0 && y < this.resolution
      && z >= 0 && z < this.resolution;
  }

  protected clampVelocity(): void {
    if (this.maxVelocity <= 0) return;

    const maxVelocitySq = this.maxVelocity * this.maxVelocity;

    for (let index = 0; index < this.cellCount; index += 1) {
      const velocityIndex = index * 3;
      const x = this.velocity[velocityIndex];
      const y = this.velocity[velocityIndex + 1];
      const z = this.velocity[velocityIndex + 2];
      const lengthSq = x * x + y * y + z * z;

      if (lengthSq <= maxVelocitySq || lengthSq <= Number.EPSILON) continue;

      const scale = this.maxVelocity / Math.sqrt(lengthSq);

      this.velocity[velocityIndex] = x * scale;
      this.velocity[velocityIndex + 1] = y * scale;
      this.velocity[velocityIndex + 2] = z * scale;
    }
  }
}

class FluidVisualRefreshModule extends Module {
  constructor(private simulation: FluidSimulation) {
    super(() => {}, {
      priority: Number.MAX_SAFE_INTEGER,
    });
  }

  public modify(_particles: Particle[], _deltaTime: number, particleSystem?: ParticleSystem): void {
    if (particleSystem) this.simulation.refreshRenderFields(particleSystem);
  }
}

export default FluidSimulation;
