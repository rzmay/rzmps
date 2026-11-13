import * as THREE from 'three';
import StagedGPUAllocation from '../../utils/gpu/StagedGPUAllocation';
import LiquidMaterial from '../materials/LiquidMaterial';
import type { WebGPURenderer } from 'three/webgpu';
import Renderer, { type RendererOptions } from '../../core/Renderer';
import type ParticleSystem from '../../core/ParticleSystem';
import type Particle from '../../core/Particle';
import type { GPUParticleBufferState, GPUParticleRenderBufferState } from '../../simulation/gpu/Particle';
import type { ParticleSpatialGridOptions } from '../../spatial/structures/ParticleSpatialGrid';
import LiquidSurface from '../gpu/LiquidSurface';
import type { SurfaceExtractor } from '../gpu/LiquidSurface';
import { SurfaceExtraction } from '../../enums/SurfaceExtraction';
import { applySurfaceMaterial } from '../compositing/applySurfaceMaterial';

export interface SurfaceRendererOptions extends RendererOptions {
  /** Mesh extractor; changing it rebuilds reconstruction resources. Defaults to SurfaceNets. */
  extraction: SurfaceExtraction | `${SurfaceExtraction}` | SurfaceExtractor;
  /** Cloned into a renderer-owned material. Defaults to LiquidMaterial. */
  material: THREE.Material;
  /** Reconstruction region in system coordinates. Defaults to [-4, 4] on each axis. */
  bounds: THREE.Box3;
  /** Independent world-space reconstruction cell size. Defaults to 0.0625. */
  voxelSize: number;
  /** Intended isolated radius, multiplying half the largest particle scale. Defaults to 1.55. */
  particleRadius: number;
  /** Compact support relative to particleRadius; bulk kernel mass is normalized. Defaults to 2.2. */
  influenceRadius: number;
  /** Bounded covariance anisotropy from zero through one. Zero disables it (default). */
  anisotropy: number;
  /** Minimum actual neighbors before anisotropy is allowed. Defaults to six. */
  anisotropyMinNeighbors: number;
  /** Maximum principal-axis stretch and reciprocal compression. Defaults to two. */
  anisotropyMaxStretch: number;
  /** Neighborhood radius relative to kernel support. Defaults to two. */
  anisotropyRadius: number;
  /** Weighted neighbor support where isolated-droplet blending begins. Defaults to one. */
  dropletSupportMin: number;
  /** Weighted neighbor support where bulk reconstruction is fully active. Defaults to four. */
  dropletSupportMax: number;
  /** Scalar-field smoothing/compensation pairs, zero through four. Defaults to one. */
  fieldSmoothingIterations: number;
  /** Scalar-field smoothing strength, zero through 0.5. Defaults to 0.2. */
  fieldSmoothing: number;
  /** Optional six-neighbor closing strength, zero through one. Defaults to zero. */
  fieldClosing: number;
  /** Reduction of field smoothing in active flow, zero through one. Defaults to 0.8. */
  flowSmoothing: number;
  /** Speeds at which flow detail preservation begins and reaches its maximum. Defaults to [0.5, 3]. */
  velocityDetailRange: [number, number];
  /** Curl magnitudes for flow detail preservation. Defaults to [1, 8]. */
  vorticityDetailRange: [number, number];
  /** Bulk density threshold; isolated droplets retain their calibrated radius. Defaults to 0.2. */
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
  /** Configurable built-in physical water material used when no material is supplied. */
  static readonly LiquidMaterial = LiquidMaterial;

  readonly mesh: THREE.Mesh;
  bounds: THREE.Box3;
  voxelSize: number;
  particleRadius: number;
  influenceRadius: number;
  anisotropy: number;
  anisotropyMinNeighbors: number;
  anisotropyMaxStretch: number;
  anisotropyRadius: number;
  dropletSupportMin: number;
  dropletSupportMax: number;
  fieldSmoothingIterations: number;
  fieldSmoothing: number;
  fieldClosing: number;
  flowSmoothing: number;
  velocityDetailRange: [number, number];
  vorticityDetailRange: [number, number];
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
  private allocation?: StagedGPUAllocation<LiquidSurface>;
  private requiredTier = 0;
  private surfaceLimits = { bricks: 0, triangles: 0 };
  private resourceFailure?: Error;
  private maximumTier = 1;
  private readonly initialBricks: number;
  private readonly initialTriangles: number;
  private resourceExtraction?: SurfaceExtractor;
  private resourceKey = '';
  // Retained only for controlled comparisons with the original radial field.
  private reconstructionVersion = 2;
  extraction: SurfaceExtraction | `${SurfaceExtraction}` | SurfaceExtractor;
  private materialCallback?: SurfaceRenderer['materialCompositeGPU'];
  private materialCallbackCPU?: SurfaceRenderer['materialComposite'];
  private materialStateKey = '';
  private diagnosticsPending = false;
  private gpuRenderer?: WebGPURenderer;

  constructor(options: Partial<SurfaceRendererOptions> = {}) {
    super(options);
    this.bounds = options.bounds?.clone() ?? new THREE.Box3(new THREE.Vector3(-4, -4, -4), new THREE.Vector3(4, 4, 4));
    this.voxelSize = options.voxelSize ?? 0.0625;
    this.extraction = options.extraction ?? SurfaceExtraction.SurfaceNets;
    this.particleRadius = options.particleRadius ?? 1.55;
    this.influenceRadius = options.influenceRadius ?? 2.2;
    this.anisotropy = options.anisotropy ?? 0;
    this.anisotropyMinNeighbors = options.anisotropyMinNeighbors ?? 6;
    this.anisotropyMaxStretch = options.anisotropyMaxStretch ?? 2;
    this.anisotropyRadius = options.anisotropyRadius ?? 2;
    this.dropletSupportMin = options.dropletSupportMin ?? 1;
    this.dropletSupportMax = options.dropletSupportMax ?? 4;
    this.fieldSmoothingIterations = options.fieldSmoothingIterations ?? 1;
    this.fieldSmoothing = options.fieldSmoothing ?? 0.2;
    this.fieldClosing = options.fieldClosing ?? 0;
    this.flowSmoothing = options.flowSmoothing ?? 0.8;
    this.velocityDetailRange = [...(options.velocityDetailRange ?? [0.5, 3])];
    this.vorticityDetailRange = [...(options.vorticityDetailRange ?? [1, 8])];
    this.isoLevel = options.isoLevel ?? 0.2;
    this.maxActiveBricks = options.maxActiveBricks ?? Number.MAX_SAFE_INTEGER;
    this.initialBricks = options.maxActiveBricks ?? 128;
    this.initialTriangles = options.maxTriangles ?? 32768;
    this.maxTriangles = options.maxTriangles ?? Number.MAX_SAFE_INTEGER;
    this.smoothingIterations = options.smoothingIterations ?? 3;
    this.smoothingStrength = options.smoothingStrength ?? 1;
    this.spatialGridOptions = {
      brickSubdivisions: 3,
      cellSubdivisions: 1,
      maxQuerySteps: 0,
      ...options.spatialGridOptions,
    };
    this.particleColors = options.particleColors ?? true;
    this.castShadow = options.castShadow ?? true;
    this.receiveShadow = options.receiveShadow ?? true;
    const material = options.material?.clone() ?? new LiquidMaterial();
    material.vertexColors = this.particleColors;
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.name = 'Particle Surface';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.validate();
    this.syncMaterialColor();
  }

  /** Renderer-owned material; the supplied material is cloned and never disposed by this renderer. */
  get material(): THREE.Material {
    return this.mesh.material as THREE.Material;
  }

  set material(material: THREE.Material) {
    const previous = this.material;
    this.mesh.material = material.clone();
    this.syncMaterialColor();
    previous.dispose();
  }

  setup(system: ParticleSystem): void {
    system.addRendererObject(this.mesh);
  }

  protected _update(particles: Particle[]): void {
    // System clearing intentionally visits renderers after disposing GPU particle storage.
    if (particles.length === 0) {
      this.clear();
      return;
    }
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
    const gpu = renderer.backend as unknown as { device: {
      limits: { maxStorageBufferBindingSize: number }; queue: { onSubmittedWorkDone(): Promise<void> };
    } };
    const key = JSON.stringify([
      this.bounds.min.toArray(),
      this.bounds.max.toArray(),
      this.voxelSize,
      this.maxActiveBricks,
      this.maxTriangles,
      this.spatialGridOptions,
      this.reconstructionVersion,
      this.extraction,
    ]);
    if (
      this.resourceKey !== key ||
      this.resourceExtraction !== (typeof this.extraction === 'function' ? this.extraction : undefined) ||
      this.gpuRenderer !== renderer ||
      !this.surface
    ) {
      this.allocation?.cancelPending();
      this.allocation = undefined;
      if (this.surface) {
        const previous = this.surface;
        void gpu.device.queue.onSubmittedWorkDone().then(() => previous.dispose());
      } else this.mesh.geometry.dispose();
      this.surface = undefined;
      this.mesh.visible = false;
      const limits = gpu.device.limits;
      const extent = this.bounds.getSize(new THREE.Vector3()).divideScalar(this.voxelSize);
      const cells = 2 ** Math.max(3, Math.ceil(Math.log2(Math.max(extent.x, extent.y, extent.z))));
      const maximumBricks = Math.min(this.maxActiveBricks, (cells / 8) ** 3,
        Math.floor((limits.maxStorageBufferBindingSize - 48) / (512 * 48)));
      const maximumTriangles = Math.min(this.maxTriangles, Math.floor(limits.maxStorageBufferBindingSize / 48));
      this.surfaceLimits = { bricks: maximumBricks, triangles: maximumTriangles };
      this.resourceFailure = undefined;
      const baseBricks = Math.min(this.initialBricks, maximumBricks);
      const baseTriangles = Math.min(this.initialTriangles, maximumTriangles);
      const create = (tier: number) => {
        const options = Object.create(this) as ConstructorParameters<typeof LiquidSurface>[0];
        Object.defineProperties(options, {
          maxActiveBricks: { value: Math.min(maximumBricks, baseBricks * tier) },
          maxTriangles: { value: Math.min(maximumTriangles, baseTriangles * tier) },
        });
        return new LiquidSurface(options, renderer, this.reconstructionVersion === 1, this.extraction);
      };
      this.maximumTier = 2 ** Math.ceil(Math.log2(Math.max(maximumBricks / baseBricks,
        maximumTriangles / baseTriangles)));
      this.surface = create(1);
      this.requiredTier = 0;
      this.allocation = new StagedGPUAllocation(this.surface, 1, {
        maximumCapacity: this.maximumTier,
        create,
        prepare: surface => surface.prepare(() => this.updateSurface(surface, buffers, system)),
        // Surface fields are ephemeral: rebuild from authoritative render particles before first drawing.
        migrate: () => {},
        swap: surface => { this.surface = surface; this.mesh.geometry = surface.geometry; },
        fence: () => gpu.device.queue.onSubmittedWorkDone(),
        dispose: surface => surface.dispose(),
      });
      this.mesh.geometry = this.surface.geometry;
      this.gpuRenderer = renderer;
      this.resourceKey = key;
      this.resourceExtraction = typeof this.extraction === 'function' ? this.extraction : undefined;
    }
    this.allocation!.commit();
    this.allocation!.request(this.requiredTier);
    this.requiredTier = 0;
    this.syncMaterialColor();
    const composite =
      this.materialCompositeGPU ?? (this.material instanceof LiquidMaterial ? this.material.compositeGPU : undefined);
    const materialKey = `${this.material.uuid}:${this.particleColors}`;
    if (
      this.materialCallback !== composite ||
      this.materialCallbackCPU !== this.materialComposite ||
      this.materialStateKey !== materialKey
    ) {
      this.materialCallback = composite;
      this.materialCallbackCPU = this.materialComposite;
      this.materialStateKey = materialKey;
      applySurfaceMaterial(this.material, this.particleColors, composite, this.materialComposite);
    }
    this.updateSurface(this.surface, buffers, system);
    if (!this.diagnosticsPending) {
      this.diagnosticsPending = true;
      const observed = this.surface;
      void observed.readDiagnostics()
        .then(stats => {
          if (observed !== this.surface) return;
          if (stats.activeBricks + stats.overflowedBricks > this.surfaceLimits.bricks
            || stats.triangles + stats.overflowedTriangles > this.surfaceLimits.triangles) {
            if (!this.resourceFailure) {
              console.warn('Surface reconstruction exceeds device/configured resource limits.', stats);
            }
            this.resourceFailure = new Error('Surface reconstruction exceeds device/configured resource limits.');
          }
          const requestedBricks = stats.activeBricks + stats.overflowedBricks;
          // Account for triangles in pages that could not yet be reconstructed, avoiding
          // a second immediate grow when a wider source footprint first becomes visible.
          const coverage = Math.max(1, requestedBricks / Math.max(1, stats.activeBricks));
          const predictedTriangles = (stats.triangles + stats.overflowedTriangles) * coverage;
          this.requiredTier = Math.min(this.maximumTier,
            Math.max(requestedBricks / this.initialBricks, predictedTriangles / this.initialTriangles));
          this.benchmarks.set('triangleCount', stats.triangles);
          this.benchmarks.set('activeBricks', stats.activeBricks);
          this.benchmarks.set('activeSurfaceCells', stats.vertices);
          this.benchmarks.set('overflowedBricks', stats.overflowedBricks);
          this.benchmarks.set('overflowedTriangles', stats.overflowedTriangles);
        })
        .catch(() => {})
        .finally(() => {
          this.diagnosticsPending = false;
        });
    }
    this.mesh.visible = true;
    this.mesh.castShadow = this.castShadow;
    this.mesh.receiveShadow = this.receiveShadow;
  }

  private updateSurface(surface: LiquidSurface,
    buffers: GPUParticleBufferState | GPUParticleRenderBufferState, system: ParticleSystem): void {
    surface.update(buffers, this.particleRadius, this.isoLevel, system.getGPURendererTagMask(this.tags),
      system.quality, this.compensation === 'size' && system.quality > 0 ? 1 / Math.sqrt(system.quality) : 1,
      this.smoothingIterations, this.smoothingStrength);
  }

  private syncMaterialColor(): void {
    const vertexColors =
      this.materialCompositeGPU || this.material instanceof LiquidMaterial ? false : this.particleColors;
    if (this.material.vertexColors !== vertexColors) {
      this.material.vertexColors = vertexColors;
      this.material.needsUpdate = true;
    }
  }

  private validate(): void {
    if (
      typeof this.extraction !== 'function' &&
      !Object.values(SurfaceExtraction).includes(this.extraction as SurfaceExtraction)
    ) {
      throw new RangeError('Unknown surface extraction algorithm.');
    }
    if (
      !Number.isFinite(this.voxelSize) ||
      this.voxelSize <= 0 ||
      !Number.isFinite(this.particleRadius) ||
      this.particleRadius <= 0 ||
      !Number.isFinite(this.isoLevel) ||
      this.isoLevel <= 0 ||
      !Number.isInteger(this.maxActiveBricks) ||
      this.maxActiveBricks < 1 ||
      !Number.isInteger(this.maxTriangles) ||
      this.maxTriangles < 2 ||
      this.bounds.isEmpty() ||
      this.bounds
        .getSize(new THREE.Vector3())
        .toArray()
        .some(value => value <= 0) ||
      [...this.bounds.min.toArray(), ...this.bounds.max.toArray()].some(value => !Number.isFinite(value))
    ) {
      throw new RangeError('SurfaceRenderer requires finite positive bounds, voxelSize, radius, isoLevel and budgets.');
    }
    if (
      !Number.isFinite(this.influenceRadius) ||
      this.influenceRadius <= 1 ||
      !Number.isFinite(this.anisotropy) ||
      this.anisotropy < 0 ||
      this.anisotropy > 1 ||
      !Number.isSafeInteger(this.anisotropyMinNeighbors) ||
      this.anisotropyMinNeighbors < 3 ||
      !Number.isFinite(this.anisotropyMaxStretch) ||
      this.anisotropyMaxStretch < 1 ||
      this.anisotropyMaxStretch > 4 ||
      !Number.isFinite(this.anisotropyRadius) ||
      this.anisotropyRadius < 1 ||
      !Number.isFinite(this.dropletSupportMin) ||
      this.dropletSupportMin < 0 ||
      !Number.isFinite(this.dropletSupportMax) ||
      this.dropletSupportMax <= this.dropletSupportMin
    ) {
      throw new RangeError('Invalid surface support or anisotropy controls.');
    }
    if (
      !Number.isSafeInteger(this.fieldSmoothingIterations) ||
      this.fieldSmoothingIterations < 0 ||
      this.fieldSmoothingIterations > 4 ||
      !Number.isFinite(this.fieldSmoothing) ||
      this.fieldSmoothing < 0 ||
      this.fieldSmoothing > 0.5 ||
      !Number.isFinite(this.fieldClosing) ||
      this.fieldClosing < 0 ||
      this.fieldClosing > 1 ||
      !Number.isFinite(this.flowSmoothing) ||
      this.flowSmoothing < 0 ||
      this.flowSmoothing > 1
    ) {
      throw new RangeError('Invalid surface field filtering controls.');
    }
    for (const range of [this.velocityDetailRange, this.vorticityDetailRange]) {
      if (!range.every(Number.isFinite) || range[0] < 0 || range[1] <= range[0]) {
        throw new RangeError('Surface flow detail ranges must be finite and increasing.');
      }
    }
    if (
      !Number.isInteger(this.smoothingIterations) ||
      this.smoothingIterations < 0 ||
      this.smoothingIterations > 16 ||
      !Number.isFinite(this.smoothingStrength) ||
      this.smoothingStrength < 0 ||
      this.smoothingStrength > 1
    ) {
      throw new RangeError('SurfaceRenderer smoothing requires integer iterations 0..16 and strength 0..1.');
    }
  }

  /** Compact allocation counters; vertex/index buffers are never read back during ordinary updates. */
  async readSurfaceDiagnostics(): Promise<{
    triangles: number;
    vertices: number;
    overflowedTriangles: number;
    clippedParticles: number;
    activeBricks: number;
    overflowedBricks: number;
    bounds: THREE.Box3;
    allocatedBytes: number;
  }> {
    return (
      this.surface?.readDiagnostics() ?? {
        triangles: 0,
        vertices: 0,
        overflowedTriangles: 0,
        clippedParticles: 0,
        activeBricks: 0,
        overflowedBricks: 0,
        bounds: this.bounds.clone(),
        allocatedBytes: 0,
      }
    );
  }

  clear(): void {
    this.mesh.visible = false;
    this.surface?.clear();
  }

  override reset(): void {
    super.reset();
    this.clear();
  }

  destroy(): void {
    super.reset();
    this.mesh.removeFromParent();
    if (this.allocation) this.allocation.dispose();
    else this.surface?.dispose();
    this.allocation = undefined;
    if (!this.surface) this.mesh.geometry.dispose();
    this.surface = undefined;
    this.material.dispose();
  }
}
