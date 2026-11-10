import * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import Renderer, { type RendererOptions } from '../../core/Renderer';
import type ParticleSystem from '../../core/ParticleSystem';
import type Particle from '../../core/Particle';
import type { GPUParticleBufferState, GPUParticleRenderBufferState } from '../../simulation/gpu/Particle';
import type { ParticleSpatialGridOptions } from '../../spatial/structures/ParticleSpatialGrid';
import LiquidSurface from '../gpu/LiquidSurface';

export interface SurfaceRendererOptions extends RendererOptions {
  /** Cloned into a renderer-owned material. Defaults to a white MeshStandardMaterial. */
  material: THREE.Material;
  /** Reconstruction region in system coordinates. Defaults to [-4, 4] on each axis. */
  bounds: THREE.Box3;
  /** Independent world-space reconstruction cell size. Defaults to 0.0625. */
  voxelSize: number;
  /** Multiplies half the largest absolute particle scale to obtain kernel radius. Defaults to 2.4. */
  particleRadiusScale: number;
  /** Positive density threshold; larger values erode the surface. Defaults to 0.2. */
  isoLevel: number;
  /** Resident reconstruction-brick budget. Defaults to 512; each brick contains 8 cubed cells. */
  maxActiveBricks: number;
  /** Triangle budget; an odd final triangle is unused because faces are emitted in pairs. Defaults to 131072. */
  maxTriangles: number;
  /** Paired, shrinkage-reducing smoothing passes, from zero through sixteen. Defaults to 3. */
  smoothingIterations: number;
  /** Smoothing amount from zero through one; zero preserves reconstruction. Defaults to 1. */
  smoothingStrength: number;
  /** Options for the renderer-owned render-time particle query grid, not a grid instance. */
  spatialGridOptions: Partial<ParticleSpatialGridOptions>;
  /** Enables built-in material vertex colors, default true. Custom shaders must consume the color attribute. */
  particleColors: boolean;
  castShadow: boolean;
  receiveShadow: boolean;
}

/** GPU-only Surface Nets geometry reconstructed from render-time particles, independently of their simulation. */
export default class SurfaceRenderer extends Renderer {
  readonly mesh: THREE.Mesh;
  bounds: THREE.Box3;
  voxelSize: number;
  particleRadiusScale: number;
  isoLevel: number;
  maxActiveBricks: number;
  maxTriangles: number;
  smoothingIterations: number;
  smoothingStrength: number;
  spatialGridOptions: Partial<ParticleSpatialGridOptions>;
  particleColors: boolean;
  castShadow: boolean;
  receiveShadow: boolean;
  private surface?: LiquidSurface;
  private resourceKey = '';
  private gpuRenderer?: WebGPURenderer;

  constructor(options: Partial<SurfaceRendererOptions> = {}) {
    super(options);
    this.bounds = options.bounds?.clone() ?? new THREE.Box3(new THREE.Vector3(-4, -4, -4), new THREE.Vector3(4, 4, 4));
    this.voxelSize = options.voxelSize ?? 0.0625;
    this.particleRadiusScale = options.particleRadiusScale ?? 2.4;
    this.isoLevel = options.isoLevel ?? 0.2;
    this.maxActiveBricks = options.maxActiveBricks ?? 512;
    this.maxTriangles = options.maxTriangles ?? 131072;
    this.smoothingIterations = options.smoothingIterations ?? 3;
    this.smoothingStrength = options.smoothingStrength ?? 1;
    this.spatialGridOptions = { brickSubdivisions: 3, cellSubdivisions: 1, maxQuerySteps: 0,
      ...options.spatialGridOptions };
    this.particleColors = options.particleColors ?? true;
    this.castShadow = options.castShadow ?? true;
    this.receiveShadow = options.receiveShadow ?? true;
    const material = options.material?.clone() ?? new THREE.MeshStandardMaterial({ roughness: 0.2, metalness: 0 });
    material.vertexColors = this.particleColors;
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.name = 'Particle Surface';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.validate();
    this.syncMaterialColor();
  }

  /** Renderer-owned material; the supplied material is cloned and never disposed by this renderer. */
  get material(): THREE.Material { return this.mesh.material as THREE.Material; }

  set material(material: THREE.Material) {
    const previous = this.material;
    this.mesh.material = material.clone();
    this.syncMaterialColor();
    previous.dispose();
  }

  setup(system: ParticleSystem): void { system.addRendererObject(this.mesh); }

  protected _update(particles: Particle[]): void {
    // System clearing intentionally visits renderers after disposing GPU particle storage.
    if (particles.length === 0) { this.clear(); return; }
    throw new Error('SurfaceRenderer requires native WebGPU particle processing.');
  }

  protected override _updateGPU(
    buffers: GPUParticleBufferState | GPUParticleRenderBufferState,
    system: ParticleSystem,
  ): void {
    const renderer = system.sceneRenderer as WebGPURenderer | undefined;
    if (!renderer || !(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend) {
      throw new Error('SurfaceRenderer requires native WebGPU particle processing.');
    }
    this.validate();
    const key = JSON.stringify([this.bounds.min.toArray(), this.bounds.max.toArray(), this.voxelSize,
      this.maxActiveBricks, this.maxTriangles, this.spatialGridOptions]);
    if (this.resourceKey !== key || this.gpuRenderer !== renderer || !this.surface) {
      if (this.surface) this.surface.dispose();
      else this.mesh.geometry.dispose();
      this.surface = undefined;
      this.mesh.visible = false;
      this.surface = new LiquidSurface(this, renderer);
      this.mesh.geometry = this.surface.geometry;
      this.gpuRenderer = renderer;
      this.resourceKey = key;
    }
    this.syncMaterialColor();
    this.surface.update(buffers, this.particleRadiusScale, this.isoLevel,
      system.getGPURendererTagMask(this.tags), system.quality,
      this.compensation === 'size' && system.quality > 0 ? 1 / Math.sqrt(system.quality) : 1,
      this.smoothingIterations, this.smoothingStrength);
    this.mesh.visible = true;
    this.mesh.castShadow = this.castShadow;
    this.mesh.receiveShadow = this.receiveShadow;
  }

  private syncMaterialColor(): void {
    if (this.material.vertexColors !== this.particleColors) {
      this.material.vertexColors = this.particleColors;
      this.material.needsUpdate = true;
    }
  }

  private validate(): void {
    if (!Number.isFinite(this.voxelSize) || this.voxelSize <= 0
      || !Number.isFinite(this.particleRadiusScale) || this.particleRadiusScale <= 0
      || !Number.isFinite(this.isoLevel) || this.isoLevel <= 0
      || !Number.isInteger(this.maxActiveBricks) || this.maxActiveBricks < 1
      || !Number.isInteger(this.maxTriangles) || this.maxTriangles < 2
      || this.bounds.isEmpty() || this.bounds.getSize(new THREE.Vector3()).toArray().some(value => value <= 0)
      || [...this.bounds.min.toArray(), ...this.bounds.max.toArray()].some(value => !Number.isFinite(value))) {
      throw new RangeError('SurfaceRenderer requires finite positive bounds, voxelSize, radius, isoLevel and budgets.');
    }
    if (!Number.isInteger(this.smoothingIterations) || this.smoothingIterations < 0 || this.smoothingIterations > 16
      || !Number.isFinite(this.smoothingStrength) || this.smoothingStrength < 0 || this.smoothingStrength > 1) {
      throw new RangeError('SurfaceRenderer smoothing requires integer iterations 0..16 and strength 0..1.');
    }
  }

  /** Explicit asynchronous diagnostics; mesh counts and vertices are never read back during ordinary updates. */
  async readSurfaceDiagnostics(): Promise<{
    triangles: number; vertices: number; overflowedTriangles: number; clippedParticles: number;
    activeBricks: number; overflowedBricks: number; bounds: THREE.Box3;
  }> {
    return this.surface?.readDiagnostics() ?? { triangles: 0, vertices: 0, overflowedTriangles: 0,
      clippedParticles: 0, activeBricks: 0, overflowedBricks: 0, bounds: this.bounds.clone() };
  }

  clear(): void {
    this.mesh.visible = false;
    this.surface?.clear();
  }

  override reset(): void { super.reset(); this.clear(); }

  destroy(): void {
    super.reset();
    this.mesh.removeFromParent();
    this.surface?.dispose();
    if (!this.surface) this.mesh.geometry.dispose();
    this.surface = undefined;
    this.material.dispose();
  }
}
