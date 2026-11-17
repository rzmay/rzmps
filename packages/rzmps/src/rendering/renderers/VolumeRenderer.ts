import type { ColorRepresentation } from 'three';
import stretchAlongVelocity from '../shaders/stretchAlongVelocity';
import LightingGrid, { type LightingGridOptions } from '../lighting/LightingGrid';
import GasModule, { type GPUGasCell, type GasRenderModuleContext } from '../../modules/GasModule';
import * as THREE from 'three';
import VolumeRenderTarget, { type VolumeResolutionOptions } from '../gpu/VolumeRenderTarget';
import VolumeOccupancy from '../gpu/VolumeOccupancy';
import OpaqueSceneDepth from '../gpu/OpaqueSceneDepth';
import { MeshBasicNodeMaterial, WebGPURenderer, type Node, type UniformNode } from 'three/webgpu';
import {
  Break,
  Continue,
  bool,
  Discard,
  Fn,
  If,
  Loop,
  cameraFar,
  cameraNear,
  cameraPosition,
  cameraWorldMatrix,
  cameraProjectionMatrix,
  cameraViewMatrix,
  float,
  floatBitsToUint,
  hash,
  int,
  ivec2,
  floor,
  max,
  min,
  mix,
  pow,
  perspectiveDepthToViewZ,
  orthographicDepthToViewZ,
  modelWorldMatrix,
  modelWorldMatrixInverse,
  positionGeometry,
  smoothstep,
  texture3D,
  texture,
  uniform,
  vec3,
  vec2,
  vec4,
  screenUV,
  screenCoordinate,
  mrt,
  struct,
} from 'three/tsl';
import Renderer, { CompensationMode, type RendererOptions } from '../../core/Renderer';
import Particle from '../../core/Particle';
import ParticleSystem from '../../core/ParticleSystem';
import type { GPUParticleBufferState, GPUParticleRenderBufferState } from '../../simulation/gpu/Particle';
import type { VolumeFieldProvider } from '../volumeField.types';
import type { VolumeField } from '../volumeField.types';
import { volumeJitter } from '../shaders/volumeJitter';
import createVolumeJitterTexture from '../shaders/createVolumeJitterTexture';
import volumeVert from '../shaders/Volume.vert';
import volumeFrag from '../shaders/Volume.frag';
import buildVolumeBindings from '../shaders/buildVolumeBindings';
import volumeChildren, { volumeNumber } from '../volumeChildren';
import evaluateByParameterColor from '../../values/evaluateByParameterColor';
import evaluateByParameterNumber from '../../values/evaluateByParameterNumber';
import { VolumeInterpolation } from '../../enums/VolumeInterpolation';
import { VolumeDensityMapping } from '../../enums/VolumeDensityMapping';

import type { ValueByParameter } from '../../values/valueByParameter.types';
import { generateGPUParticleNoise4D } from '../../utils/noise.utils';

const VolumeRayResult = struct({ color: 'vec4', firstDepth: 'float' });
// Three's current struct declarations omit its proxy accessors.
type VolumeRayValue = {
  toVar(): VolumeRayValue;
  get(name: 'color'): Node<'vec4'>;
  get(name: 'firstDepth'): Node<'float'>;
};

interface FieldBinding {
  field: VolumeField;
  texture: THREE.Texture;
  textureNode: ReturnType<typeof texture3D>;
  owned: boolean;
  version: number;
  resolution: THREE.Vector3;
  minimum: UniformNode<'vec3', THREE.Vector3>;
  size: UniformNode<'vec3', THREE.Vector3>;
  occupancy?: VolumeOccupancy;
  resolutionNode: UniformNode<'vec3', THREE.Vector3>;
  textureScale: UniformNode<'vec3', THREE.Vector3>;
}

/** Render-only transforms and weights; every child samples its parent source textures. */
interface VolumeChild {
  offset: UniformNode<'vec3', THREE.Vector3>;
  scale: UniformNode<'float', number>;
  alpha: UniformNode<'float', number>;
}

/** One provider/source, including its identity parent contribution. */
interface VolumeLayer {
  density: FieldBinding;
  color?: FieldBinding;
  children: VolumeChild[];
}

export interface VolumeRendererOptions extends RendererOptions {
  /** Options that enable a managed world-space lighting grid. Omission disables it. WebGPU only. */
  lightingGridOptions?: Partial<LightingGridOptions>;
  /** Scalar self-lit fraction. Zero preserves external lighting (default). */
  emissive?: number;
  /** Optional temperature multiplier for emissive. Null is neutral one. */
  emissiveByTemperature?: ValueByParameter<number> | null;
  /** Optional density multiplier for emissive, using minDensity/maxDensity. Null is neutral one. */
  emissiveByDensity?: ValueByParameter<number> | null;
  /** Optional speed multiplier for emissive. Null is neutral one. */
  emissiveBySpeed?: ValueByParameter<number> | null;
  /** Renderer-only temperature color multiplier. Defaults to null (neutral white). */
  colorByTemperature?: ValueByParameter<ColorRepresentation> | null;
  /** Renderer-only temperature opacity multiplier. Defaults to null (neutral one). */
  opacityByTemperature?: ValueByParameter<number> | null;
  /** Physical temperature interval normalized to [0, 1]. Defaults to [0, 1]. */
  temperatureRange?: [number, number];
  /** Renderer-only speed color multiplier. Defaults to null (neutral white). */
  colorBySpeed?: ValueByParameter<ColorRepresentation> | null;
  /** Renderer-only speed opacity multiplier. Defaults to null (neutral one). */
  opacityBySpeed?: ValueByParameter<number> | null;
  /** Physical speed interval normalized to [0, 1]. Defaults to [0, 1]. */
  speedRange?: [number, number];
  /** Renderer-only vorticity color multiplier. Defaults to null (neutral white). */
  colorByVorticity?: ValueByParameter<ColorRepresentation> | null;
  /** Renderer-only vorticity opacity multiplier. Defaults to null (neutral one). */
  opacityByVorticity?: ValueByParameter<number> | null;
  /** Physical vorticity interval normalized to [0, 1]. Defaults to [0, 1]. */
  vorticityRange?: [number, number];
  /** Density color multiplier, using minDensity/maxDensity. Defaults to null (neutral white). */
  colorByDensity?: ValueByParameter<ColorRepresentation> | null;
  field?: VolumeField | (() => VolumeField | undefined);
  colorField?: VolumeField | (() => VolumeField | undefined);
  color: THREE.ColorRepresentation;
  /** Opacity over one simulation unit of ray travel, after density mapping. Defaults to 0.25. */
  opacity: number;
  threshold: number;
  range: number;
  /** Maximum samples per ray, clamped to 512. Defaults to 100. */
  steps: number;
  renderOrder: number;
  depthTest: boolean;
  /** Adapt screen-space resolution to measured GPU time. Defaults to true; full resolution without timestamps. */
  dynamicResolution: boolean | VolumeResolutionOptions;
  /** Screen-resolution divisor on WebGPURenderer: one is full, two is half. Defaults to one. */
  downsample: number;
  /** Skip exactly empty visual-density regions. Defaults to true. */
  emptySpaceSkipping: boolean;
  /** Full-stratum jitter strength, clamped to [0, 1]. Defaults to one. */
  jitterStrength: number;
  /** Stable volume-space sampling seed. Defaults to zero. */
  jitterSeed: number;
  /** Samples per smallest contributing voxel. Defaults to one; two selects high quality. */
  samplesPerVoxel: number;
  /** Henyey–Greenstein anisotropy, clamped to [-0.9, 0.9]. Defaults to zero. */
  anisotropy: number;
  /** Secondary light-march quality; zero disables shadows (default). */
  shadowQuality: number;
  /** Optional directional light; otherwise resolve the dominant visible scene directional light. */
  light?: THREE.DirectionalLight;
  /** Boolean shorthand for enabling/disabling jitterStrength. */
  jitter: boolean;
  /** Voxel reconstruction, independent of simulation advection. Defaults to Linear. */
  interpolation: VolumeInterpolation;
  /** Reciprocal samplesPerVoxel shorthand. Defaults to one (one sample per voxel). */
  stepSizeMultiplier: number;
  /** Render-only density multiplier. Defaults to one. */
  densityGain: number;
  /** Defaults to Smoothstep, which uses threshold/range. */
  densityMapping: VolumeDensityMapping;
  /** Density at or below this value renders transparent. Defaults to zero. */
  minDensity: number;
  /** Density at or above this value maps to full density. Defaults to one. */
  maxDensity: number;
  /** Flow-aligned noise-coordinate compression, clamped to [0, 0.95] like liquid distortion. Defaults to zero. */
  densityNoiseStretch?: number;
  /** Temperature multiplier for flow stretch. Null is neutral one. */
  densityNoiseStretchByTemperature?: ValueByParameter<number> | null;
  /** Density multiplier for flow stretch. Null is neutral one. */
  densityNoiseStretchByDensity?: ValueByParameter<number> | null;
  /** Speed multiplier for flow stretch. Null is neutral one. */
  densityNoiseStretchBySpeed?: ValueByParameter<number> | null;
  /** Opacity curve on normalized density. Uses the existing ValueByParameter convention. */
  densityCurve: ValueByParameter<number>;
  /** Optional temperature multiplier of densityNoiseStrength, using temperatureRange. Null is neutral. WebGPU only. */
  densityNoiseStrengthByTemperature?: ValueByParameter<number> | null;
  /** Optional temperature multiplier of densityNoiseContrast, using temperatureRange. Null is neutral. WebGPU only. */
  densityNoiseContrastByTemperature?: ValueByParameter<number> | null;
  /** Optional temperature multiplier of densityNoiseFrequency, using temperatureRange. Null is neutral. WebGPU only. */
  densityNoiseFrequencyByTemperature?: ValueByParameter<number> | null;
  /** Exponent applied to the contrast-adjusted density mask. Zero disables masking. WebGPU only. */
  densityNoiseStrength: number;
  /** Contrast around noise value 0.5, applied before the strength exponent. Defaults to one. */
  densityNoiseContrast: number;
  /** Noise frequency in simulation units, independent of field resolution. */
  densityNoiseFrequency: number;
  /** Animation speed along the noise helper's fourth dimension. */
  densityNoiseSpeed: number;
  /** Fractal detail layers per ray sample. Defaults to one. */
  densityNoiseOctaves: number;
  /** Grow steps behind accumulated fog. Defaults to false to preserve fine visual detail. */
  adaptiveStepping: boolean;
  /** Accumulated opacity at which step growth begins. Defaults to 0.5. */
  adaptiveStepThreshold: number;
  /** Maximum multiple of the base ray step. Defaults to four. */
  adaptiveStepFactor: number;
  /** Stop when remaining transmittance falls below this value. Zero disables termination. Defaults to 0.01. */
  transmittanceThreshold: number;
  /** Clip rays against opaque scene depth on WebGPURenderer. Defaults to true; requires depthTest. */
  sceneDepthClipping: boolean;
  /** View-space distance kept in front of opaque surfaces. Defaults to 0.001. */
  sceneDepthBias: number;
  /** Enables soft intersections when softParticleDistance is positive. Defaults to true. WebGPU only. */
  softParticles: boolean;
  /** View-space intersection fade distance, matching SpriteRenderer; zero disables fading. Defaults to zero. */
  softParticleDistance: number;
}

class VolumeRenderer extends Renderer {
  lightingGridOptions?: Partial<LightingGridOptions>;
  protected lightingGrid?: LightingGrid;
  private attachedLightingGrid?: LightingGrid;
  private sampledLightingGrid?: LightingGrid;
  private sampledLightingVersion = -1;
  private readonly lightingWorldToVolume = uniform(new THREE.Matrix4());
  private readonly lightingBounds = new THREE.Box3();
  private readonly lightingExtinction = (position: Node<'vec3'>): Node<'float'> => {
    const local = this.lightingWorldToVolume.mul(vec4(position, 1)).xyz;
    const sample = this.sampleVolume(local, this.gasModules.length > 0);
    const opacity = this.renderOpacity(sample.density).mul(sample.opacity).clamp(0, 0.999999);
    return float(1).sub(opacity).log().negate();
  };
  emissive = 0;
  emissiveByTemperature: ValueByParameter<number> | null = null;
  emissiveByDensity: ValueByParameter<number> | null = null;
  emissiveBySpeed: ValueByParameter<number> | null = null;
  private readonly emissiveData = new Uint16Array(256 * 4 * 4);
  private readonly emissiveTexture = new THREE.DataTexture(
    this.emissiveData, 256, 4, THREE.RGBAFormat, THREE.HalfFloatType,
  );
  colorByTemperature: ValueByParameter<ColorRepresentation> | null = null;
  opacityByTemperature: ValueByParameter<number> | null = null;
  colorByDensity: ValueByParameter<ColorRepresentation> | null = null;
  colorBySpeed: ValueByParameter<ColorRepresentation> | null = null;
  opacityBySpeed: ValueByParameter<number> | null = null;
  colorByVorticity: ValueByParameter<ColorRepresentation> | null = null;
  opacityByVorticity: ValueByParameter<number> | null = null;
  temperatureRange: [number, number];
  speedRange: [number, number];
  vorticityRange: [number, number];
  private readonly dynamicTarget = new VolumeRenderTarget();
  private lowResolutionMaterial?: MeshBasicNodeMaterial;
  private readonly appearanceData = new Uint16Array(256 * 4 * 4);
  private readonly appearanceTexture = new THREE.DataTexture(
    this.appearanceData,
    256,
    4,
    THREE.RGBAFormat,
    THREE.HalfFloatType,
  );
  private readonly gpuAppearanceRanges = [
    uniform(new THREE.Vector2()),
    uniform(new THREE.Vector2()),
    uniform(new THREE.Vector2()),
    uniform(new THREE.Vector2()),
  ];

  field?: VolumeField | (() => VolumeField | undefined);
  colorField?: VolumeField | (() => VolumeField | undefined);
  color = new THREE.Color(0xffffff);
  opacity: number;
  threshold: number;
  range: number;
  steps: number;
  renderOrder: number;
  depthTest: boolean;
  /** Adapt screen-space resolution to measured GPU time. Defaults to true; full resolution without timestamps. */
  dynamicResolution: boolean | VolumeResolutionOptions;
  /** Screen-resolution divisor on WebGPURenderer: one is full, two is half. Defaults to one. */
  downsample: number;
  /** Skip exactly empty visual-density regions. Defaults to true. */
  emptySpaceSkipping: boolean;
  /** Full-stratum jitter strength, clamped to [0, 1]. Defaults to one. */
  jitterStrength: number;
  /** Stable volume-space sampling seed. Defaults to zero. */
  jitterSeed: number;
  /** Samples per smallest contributing voxel. Defaults to one; two selects high quality. */
  samplesPerVoxel: number;
  /** Henyey–Greenstein anisotropy, clamped to [-0.9, 0.9]. Defaults to zero. */
  anisotropy: number;
  /** Secondary light-march quality; zero disables shadows (default). */
  shadowQuality: number;
  /** Optional directional light; otherwise resolve the dominant visible scene directional light. */
  light?: THREE.DirectionalLight;
  interpolation: VolumeRendererOptions['interpolation'];
  densityGain: number;
  densityMapping: VolumeRendererOptions['densityMapping'];
  minDensity: number;
  maxDensity: number;
  densityCurve: VolumeRendererOptions['densityCurve'];
  densityNoiseStretch: number;
  densityNoiseStretchByTemperature: ValueByParameter<number> | null = null;
  densityNoiseStretchByDensity: ValueByParameter<number> | null = null;
  densityNoiseStretchBySpeed: ValueByParameter<number> | null = null;
  densityNoiseStrengthByTemperature: ValueByParameter<number> | null = null;
  densityNoiseContrastByTemperature: ValueByParameter<number> | null = null;
  densityNoiseFrequencyByTemperature: ValueByParameter<number> | null = null;
  densityNoiseStrength: number;
  densityNoiseContrast: number;
  densityNoiseFrequency: number;
  densityNoiseSpeed: number;
  densityNoiseOctaves: number;
  adaptiveStepping: boolean;
  adaptiveStepThreshold: number;
  adaptiveStepFactor: number;
  transmittanceThreshold: number;
  sceneDepthClipping: boolean;
  sceneDepthBias: number;
  softParticles: boolean;
  softParticleDistance: number;
  private readonly gpuAdaptiveStepping = uniform(0);
  private readonly gpuAdaptiveStepThreshold = uniform(0.5);
  private readonly gpuAdaptiveStepFactor = uniform(4);
  private readonly gpuTransmittanceThreshold = uniform(0.01);
  private readonly gpuSceneDepthClipping = uniform(1);
  private readonly gpuSceneDepthBias = uniform(0.001);
  private readonly gpuSoftParticleDistance = uniform(0);
  private readonly gpuNoiseStrength = uniform(0);
  private readonly gpuNoiseStretch = uniform(0);
  private readonly gpuEmissive = uniform(0);
  private readonly gpuNoiseContrast = uniform(1);
  private readonly gpuNoiseFrequency = uniform(1);
  private readonly gpuNoiseTime = uniform(0);
  private noiseTime = 0;

  private bindings = new Map<VolumeField, FieldBinding>();
  private layers: VolumeLayer[] = [];
  private geometry = new THREE.BoxGeometry(1, 1, 1);
  private webglMaterial: THREE.ShaderMaterial;
  private webgpuMaterial: THREE.Material;
  private readonly jitterTexture = createVolumeJitterTexture();
  private mesh: THREE.Mesh;
  private bounds = new THREE.Box3();
  private boundsCenter = new THREE.Vector3();
  private boundsSize = new THREE.Vector3();
  private cameraWorldPosition = new THREE.Vector3();
  private cameraLocalPosition = new THREE.Vector3();
  private readonly gpuThreshold = uniform(0.25);
  private readonly gpuRange = uniform(0.1);
  private readonly gpuOpacity = uniform(0.25);
  private readonly gpuBaseR = uniform(0.5);
  private readonly gpuBaseG = uniform(0.5);
  private readonly gpuBaseB = uniform(0.5);
  private preparingResources = false;
  private readonly opaqueDepth = new OpaqueSceneDepth();
  private readonly viewportDepth = this.opaqueDepth.node;
  private readonly gpuSteps = uniform(100, 'int');
  private gpuMaterialDepthTest = true;
  private readonly gpuBoundsMinimum = uniform(new THREE.Vector3());
  private readonly gpuBoundsSize = uniform(new THREE.Vector3(1, 1, 1));
  private readonly gpuCellSize = uniform(1);
  private readonly gpuStepSize = uniform(1);
  private readonly gpuDensityGain = uniform(1);
  private readonly gpuDensityRange = uniform(new THREE.Vector2(0, 1));
  private readonly gpuJitterSeed = uniform(0);
  private readonly gpuAnisotropy = uniform(0);
  private readonly gpuShadowQuality = uniform(0);
  private readonly gpuLightDirection = uniform(new THREE.Vector3(1, 1, 1).normalize());
  private readonly gpuLightColor = uniform(new THREE.Color(1, 1, 1));
  private readonly lightPosition = new THREE.Vector3();
  private readonly lightTarget = new THREE.Vector3();
  private readonly gpuJitter = uniform(0);
  private gasModules: GasModule[] = [];
  private readonly gasElapsedTime = uniform(0);
  private materialSamplingKey = '';
  private readonly curveData = new Uint16Array(256 * 4);
  private readonly curveTexture = new THREE.DataTexture(this.curveData, 256, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  private volumeChildCount = 0;
  private readonly fieldIds = new WeakMap<VolumeField, number>();
  private nextFieldId = 0;

  protected override get usesParticleChildren(): boolean {
    return false;
  }

  /** Number of additional field copies, not additional simulated particles. */
  override get renderedChildCount(): number {
    return this.volumeChildCount;
  }

  constructor(options: Partial<VolumeRendererOptions> = {}) {
    super(options);
    this.lightingGridOptions = options.lightingGridOptions;
    this.syncLightingGrid();
    this.emissive = options.emissive ?? 0;
    this.densityNoiseStretch = options.densityNoiseStretch ?? 0;
    for (const parameter of ['Temperature', 'Density', 'Speed'] as const)
      this[`densityNoiseStretchBy${parameter}`] = options[`densityNoiseStretchBy${parameter}`] ?? null;
    for (const key of ['Temperature', 'Density', 'Speed'] as const)
      this[`emissiveBy${key}`] = options[`emissiveBy${key}`] ?? null;
    this.emissiveTexture.minFilter = this.emissiveTexture.magFilter = THREE.LinearFilter;
    this.emissiveTexture.generateMipmaps = false;

    for (const key of ['Temperature', 'Density', 'Speed', 'Vorticity'] as const) {
      this[`colorBy${key}`] = options[`colorBy${key}`] ?? null;
      if (key !== 'Density') this[`opacityBy${key}`] = options[`opacityBy${key}`] ?? null;
    }
    this.temperatureRange = [...(options.temperatureRange ?? [0, 1])];
    this.speedRange = [...(options.speedRange ?? [0, 1])];
    this.vorticityRange = [...(options.vorticityRange ?? [0, 1])];
    this.appearanceTexture.minFilter = THREE.LinearFilter;
    this.appearanceTexture.magFilter = THREE.LinearFilter;
    this.appearanceTexture.generateMipmaps = false;
    this.updateAppearanceCurves(true);
    this.field = options.field;
    this.colorField = options.colorField;
    this.color = new THREE.Color(options.color ?? this.color);
    this.opacity = options.opacity ?? 0.25;
    this.threshold = options.threshold ?? 0.25;
    this.range = options.range ?? 0.1;
    this.steps = options.steps ?? 100;
    this.renderOrder = options.renderOrder ?? 100;
    this.depthTest = options.depthTest ?? true;
    this.emptySpaceSkipping = options.emptySpaceSkipping ?? true;
    this.dynamicResolution = options.dynamicResolution ?? true;
    this.downsample = options.downsample ?? 1;
    this.jitterStrength = options.jitterStrength ?? (options.jitter === false ? 0 : 1);
    this.jitterSeed = options.jitterSeed ?? 0;
    this.samplesPerVoxel = options.samplesPerVoxel ?? 1 / (options.stepSizeMultiplier ?? 1);
    this.anisotropy = options.anisotropy ?? 0;
    this.shadowQuality = options.shadowQuality ?? 0;
    this.light = options.light;
    this.interpolation = options.interpolation ?? VolumeInterpolation.Linear;
    this.densityGain = options.densityGain ?? 1;
    this.densityMapping = options.densityMapping ?? VolumeDensityMapping.Smoothstep;
    this.minDensity = options.minDensity ?? 0;
    this.maxDensity = options.maxDensity ?? 1;
    this.densityCurve = options.densityCurve ?? ((t: number) => t);
    for (const name of ['densityNoiseStrength', 'densityNoiseContrast', 'densityNoiseFrequency'] as const) {
      this[`${name}ByTemperature`] = options[`${name}ByTemperature`] ?? null;
    }
    this.densityNoiseStrength = options.densityNoiseStrength ?? 0;
    this.densityNoiseContrast = options.densityNoiseContrast ?? 1;
    this.densityNoiseFrequency = options.densityNoiseFrequency ?? 3;
    this.densityNoiseSpeed = options.densityNoiseSpeed ?? 0.2;
    this.densityNoiseOctaves = options.densityNoiseOctaves ?? 1;
    this.adaptiveStepping = options.adaptiveStepping ?? false;
    this.adaptiveStepThreshold = options.adaptiveStepThreshold ?? 0.5;
    this.adaptiveStepFactor = options.adaptiveStepFactor ?? 4;
    this.transmittanceThreshold = options.transmittanceThreshold ?? 0.01;
    this.sceneDepthClipping = options.sceneDepthClipping ?? true;
    this.sceneDepthBias = options.sceneDepthBias ?? 0.001;
    this.softParticles = options.softParticles ?? true;
    this.softParticleDistance = options.softParticleDistance ?? 0;
    this.curveTexture.minFilter = THREE.LinearFilter;
    this.curveTexture.magFilter = THREE.LinearFilter;
    this.curveTexture.generateMipmaps = false;
    this.validateOptions();
    this.syncGPUUniforms();

    this.webglMaterial = this.createWebGLMaterial();
    this.webgpuMaterial = this.createWebGPUMaterial();
    this.mesh = new THREE.Mesh(this.geometry, this.webglMaterial);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = this.renderOrder;
  }

  /** Reciprocal shorthand retained for cell-relative spacing. Prefer samplesPerVoxel. */
  get stepSizeMultiplier(): number {
    return 1 / this.samplesPerVoxel;
  }
  set stepSizeMultiplier(value: number) {
    this.samplesPerVoxel = 1 / value;
  }

  get jitter(): boolean {
    return this.jitterStrength > 0;
  }
  set jitter(value: boolean) {
    this.jitterStrength = value ? 1 : 0;
  }

  setup(system: ParticleSystem): void {
    this.mesh.onBeforeRender = (renderer, _scene, camera) => {
      if (this.preparingResources || _scene.overrideMaterial) return;
      this.syncLightingGrid();
      if (renderer instanceof WebGPURenderer) this.updateLighting(renderer, _scene);
      this.setActiveMaterial(renderer);
      this.updateMaterialSide(camera);
      if (!this.lightingGrid || !(renderer instanceof WebGPURenderer)) this.resolveLight(_scene);
      if (renderer instanceof WebGPURenderer && (this.dynamicResolution || this.downsample > 1)) {
        if (this.dynamicTarget.resolutionScale < 1) {
          this.lowResolutionMaterial ??= this.createWebGPUMaterial(true) as MeshBasicNodeMaterial;
          this.lowResolutionMaterial.side = this.webgpuMaterial.side;
        }
        this.dynamicTarget.render(
          renderer,
          camera,
          this.mesh,
          this.lowResolutionMaterial ?? (this.webgpuMaterial as MeshBasicNodeMaterial),
          typeof this.dynamicResolution === 'object' ? this.dynamicResolution : {},
          this.viewportDepth.value as THREE.DepthTexture,
        );
      }
      this.webglMaterial.uniforms.worldToVolume.value.copy(this.mesh.matrixWorld).invert();
      this.webglMaterial.uniforms.volumeToWorld.value.copy(this.mesh.matrixWorld);
    };

    this._update([], system);
    system.addRendererObject(this.mesh);
  }

  /** Compile the visible volume path during preparation, overlapping simulation pipeline creation. */
  public override async prepareResources(system: ParticleSystem, renderer: WebGPURenderer): Promise<void> {
    const camera = system.sceneCamera, scene = system.scene;
    if (!camera || !scene) return;
    this.preparingResources = true;
    try {
      this._update([], system, 0);
      if (!this.mesh.visible) return;
      if (this.lightingGrid) {
        this.mesh.updateWorldMatrix(true, false);
        this.updateLighting(renderer, scene);
      } else this.resolveLight(scene);
      this.updateMaterialSide(camera);
      // Outside a draw Three reports zero samples when using its intermediate framebuffer.
      // Seed the viewport texture under the actual target's sample count before compilation;
      // the visible draw fills/resizes it normally. No scene pass or depth copy is needed here.
      if (this.depthTest) {
        const previous = renderer.getRenderTarget();
        const reference = previous ?? renderer.getCanvasTarget();
        const depth = this.viewportDepth.getTextureForReference(reference) as THREE.DepthTexture;
        const target = new THREE.RenderTarget(1, 1, { samples: previous?.samples ?? renderer.samples });
        depth.image.width ||= 1;
        depth.image.height ||= 1;
        depth.needsUpdate = true;
        this.viewportDepth.value = depth;
        try {
          renderer.setRenderTarget(target);
          renderer.initTexture(depth);
        } finally {
          renderer.setRenderTarget(previous);
          target.dispose();
        }
      }
      await renderer.compileAsync(this.mesh, camera, scene);
    } finally {
      this.preparingResources = false;
    }
  }

  protected _update(particles: Particle[], system: ParticleSystem, deltaTime = 0): void {
    void particles;
    const captureDepth = !system.sceneRenderer || system.sceneRenderer instanceof WebGPURenderer;
    this.opaqueDepth.attach(system.scene, this.depthTest && captureDepth);
    this.syncLightingGrid();
    this.noiseTime += deltaTime * this.densityNoiseSpeed;
    this.gasElapsedTime.value += deltaTime;
    this.gasModules = GasModule.collect(system, this.tags, 'render');
    this.gpuNoiseTime.value = this.noiseTime;
    this.validateOptions();
    this.dynamicTarget.configure(this.downsample, !!this.dynamicResolution);
    this.evaluateDynamicGPU.sync();
    // Reuse source bindings and child uniforms; child transforms do not rebuild the material.
    const previous = this.layers;
    const active = new Set<VolumeField>();
    const next: VolumeLayer[] = [];
    this.volumeChildCount = 0;
    for (const { field, colorField } of system.quality > 0 ? this.resolveFields(system) : []) {
      active.add(field);
      if (colorField) active.add(colorField);
      const density = this.bindField(field, field.channels ?? 1);
      const color = colorField ? this.bindField(colorField, colorField.channels ?? 4) : undefined;
      const copies = [{ offset: new THREE.Vector3(), scale: 1, alpha: 1 }];
      if (this.generateChildren) copies.push(...volumeChildren(this.children, `volume:${this.layersSourceId(field)}`));
      const artistic = copies.length;
      if (this.generateChildren && this.compensation === CompensationMode.Children && system.quality < 1) {
        const additional = 1 / system.quality - 1;
        const cell = field.bounds.getSize(new THREE.Vector3()).divide(field.resolution).length() / Math.sqrt(3);
        for (let i = 0; i < artistic; i++) {
          const parent = copies[i];
          const children = volumeChildren({ count: [additional, additional + 1], radius: cell }, `volume:lod:${i}`);
          for (const child of children) {
            copies.push({ offset: child.offset.add(parent.offset), scale: parent.scale, alpha: parent.alpha });
          }
        }
      }
      this.volumeChildCount += copies.length - 1;
      const old = previous[next.length];
      const retained = old?.density === density && old.color === color ? old.children : [];
      const children = copies.map((copy, index) => {
        const child = retained[index] ?? {
          offset: uniform(new THREE.Vector3()),
          scale: uniform(1),
          alpha: uniform(1),
        };
        child.offset.value.copy(copy.offset);
        child.scale.value =
          copy.scale * (this.compensation === CompensationMode.Size ? 1 / Math.sqrt(system.quality) : 1);
        child.alpha.value = copy.alpha;
        return child;
      });
      next.push({ density, color, children });
    }
    this.layers = next;
    // Occupancy and resource ownership belong to sources, independent of their child count.
    const activeRenderer = system.sceneRenderer as WebGPURenderer | undefined;
    const nativeGPU = (activeRenderer?.backend as { isWebGPUBackend?: boolean } | undefined)?.isWebGPUBackend;
    if (this.emptySpaceSkipping && activeRenderer && nativeGPU) {
      for (const binding of new Set(next.map(layer => layer.density))) {
        binding.occupancy ??= new VolumeOccupancy(binding.texture,
          (binding.field.textureResolution ?? binding.resolution).clone());
        binding.occupancy.updateSource(activeRenderer, binding.texture,
          binding.field.textureResolution ?? binding.resolution);
        if (!this.preparingResources) binding.occupancy.update(activeRenderer, binding.field.version);
      }
    }
    for (const [field, binding] of this.bindings) {
      if (active.has(field)) continue;
      if (binding.owned) binding.texture.dispose();
      binding.occupancy?.dispose();
      this.bindings.delete(field);
    }
    const changed =
      previous.length !== this.layers.length ||
      this.layers.some(
        (layer, index) =>
          layer.density !== previous[index]?.density ||
          layer.color !== previous[index]?.color ||
          layer.children.length !== previous[index]?.children.length,
      );
    this.updateBounds();
    const samplingKey = [
      this.interpolation,
      this.densityMapping,
      this.densityNoiseStrength > 0,
      this.densityNoiseOctaves,
      this.shadowQuality > 0,
      this.emptySpaceSkipping,
      this.layers.every(layer => !!layer.density.occupancy),
      ...this.appearanceEnabled(), this.emissive !== 0, this.densityNoiseStretch > 0,
      ...(['Temperature', 'Density', 'Speed'] as const).map(parameter =>
        this[`densityNoiseStretchBy${parameter}`] != null),
      ...['Temperature', 'Density', 'Speed'].map(parameter =>
        this[`emissiveBy${parameter as 'Temperature' | 'Density' | 'Speed'}`] != null),
      ...(['densityNoiseStrength', 'densityNoiseContrast', 'densityNoiseFrequency'] as const).map(name =>
        this[`${name}ByTemperature`] != null),
      this.evaluateDynamicGPU.version,
      ...this.gasModules.map(module => module.graphKey('render')),
      ...this.layers.map(layer =>
        JSON.stringify([layer.density.field.parameterChannels, layer.density.field.parametersPremultiplied,
          this.densityNoiseStretch > 0 && !!layer.density.field.sampleVelocityGPU]),
      ),
    ].join(':');
    if (
      changed ||
      this.depthTest !== this.gpuMaterialDepthTest ||
      this.materialSamplingKey !== samplingKey
    ) {
      this.materialSamplingKey = samplingKey;
      this.updateMaterialTexture();
    }

    this.webglMaterial.uniforms.base.value.copy(this.color);
    this.webglMaterial.uniforms.opacity.value = this.opacity;
    this.webglMaterial.uniforms.threshold.value = this.threshold;
    this.webglMaterial.uniforms.range.value = this.range;
    this.webglMaterial.uniforms.steps.value = this.steps;
    this.webglMaterial.uniforms.jitterStrength.value = this.jitterStrength;
    this.webglMaterial.uniforms.jitterSeed.value = this.jitterSeed;
    this.webglMaterial.uniforms.anisotropy.value = this.anisotropy;
    this.webglMaterial.uniforms.emissive.value = this.emissive;
    this.webglMaterial.uniforms.shadowQuality.value = this.shadowQuality;
    this.webglMaterial.uniforms.cellSize.value = this.gpuCellSize.value;
    this.webglMaterial.uniforms.stepSizeMultiplier.value = this.stepSizeMultiplier;
    this.webglMaterial.uniforms.densityGain.value = this.densityGain;
    this.webglMaterial.uniforms.densityRange.value.set(this.minDensity, this.maxDensity);
    for (const key of [
      'adaptiveStepping',
      'adaptiveStepThreshold',
      'adaptiveStepFactor',
      'transmittanceThreshold',
    ] as const)
      this.webglMaterial.uniforms[key].value = this[key];
    this.updateDensityCurve();
    if (system.sceneRenderer && !(system.sceneRenderer instanceof WebGPURenderer)) {
      this.updateAppearanceCurves();
    }
    for (const [index, key] of (['temperature', 'density', 'speed', 'vorticity'] as const).entries()) {
      const range: [number, number] = key === 'density' ? [this.minDensity, this.maxDensity] : this[`${key}Range`];
      if (!range.every(Number.isFinite) || range[1] <= range[0]) {
        throw new RangeError(`Volume ${key}Range must be finite and increasing.`);
      }
      this.gpuAppearanceRanges[index].value.set(...range);
      this.webglMaterial.uniforms[`appearanceRange${index}`].value.set(...range);
    }
    this.syncGPUUniforms();
    this.mesh.renderOrder = this.renderOrder;
    this.webglMaterial.depthTest = this.depthTest;
    this.webgpuMaterial.depthTest = this.depthTest;
    if (!this.layers.length) this.attachedLightingGrid?.release(this);
    this.setActiveMaterial(system.sceneRenderer);
  }

  private syncGPUUniforms(): void {
    this.gpuThreshold.value = this.threshold;
    this.gpuRange.value = this.range;
    this.gpuOpacity.value = this.opacity;
    this.gpuEmissive.value = this.emissive;
    this.gpuNoiseStretch.value = this.densityNoiseStretch;
    this.gpuBaseR.value = this.color.r;
    this.gpuBaseG.value = this.color.g;
    this.gpuBaseB.value = this.color.b;
    this.gpuStepSize.value = this.stepSizeMultiplier;
    this.gpuSteps.value = Math.max(1, Math.min(512, Math.floor(this.steps)));
    this.gpuDensityGain.value = this.densityGain;
    this.gpuDensityRange.value.set(this.minDensity, this.maxDensity);
    this.gpuJitter.value = this.jitterStrength;
    this.gpuJitterSeed.value = this.jitterSeed;
    this.gpuAnisotropy.value = this.anisotropy;
    this.gpuShadowQuality.value = this.shadowQuality;
    this.gpuNoiseStrength.value = this.densityNoiseStrength;
    this.gpuNoiseContrast.value = this.densityNoiseContrast;
    this.gpuNoiseFrequency.value = this.densityNoiseFrequency;
    this.gpuAdaptiveStepping.value = this.adaptiveStepping ? 1 : 0;
    this.gpuAdaptiveStepThreshold.value = this.adaptiveStepThreshold;
    this.gpuAdaptiveStepFactor.value = this.adaptiveStepFactor;
    this.gpuTransmittanceThreshold.value = this.transmittanceThreshold;
    this.gpuSceneDepthClipping.value = this.sceneDepthClipping ? 1 : 0;
    this.gpuSceneDepthBias.value = this.sceneDepthBias;
    this.gpuSoftParticleDistance.value = this.softParticles ? Math.max(0, this.softParticleDistance) : 0;
  }

  private layersSourceId(field: VolumeField): number {
    let id = this.fieldIds.get(field);
    if (id === undefined) {
      id = this.nextFieldId++;
      this.fieldIds.set(field, id);
    }
    return id;
  }

  private syncLightingGrid(): void {
    if (this.lightingGridOptions === undefined) {
      this.lightingGrid?.release(this);
      this.lightingGrid?.dispose();
      this.lightingGrid = undefined;
    } else if (this.lightingGrid) this.lightingGrid.setOptions(this.lightingGridOptions);
    else this.lightingGrid = new LightingGrid(this.lightingGridOptions);
  }

  private updateLighting(renderer: WebGPURenderer, scene: THREE.Scene): void {
    const grid = this.lightingGrid;
    if (grid !== this.attachedLightingGrid) {
      this.attachedLightingGrid?.release(this);
      this.attachedLightingGrid = grid;
    }
    if (grid && this.layers.length) {
      this.lightingWorldToVolume.value.copy(this.mesh.matrixWorld).invert();
      this.lightingBounds.set(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5))
        .applyMatrix4(this.mesh.matrixWorld);
      const layers = this.layers.map(layer => [this.layersSourceId(layer.density.field),
        layer.color ? this.layersSourceId(layer.color.field) : -1, layer.children.length].join(','));
      const version = [this.opacity, this.threshold, this.range, this.minDensity, this.maxDensity, this.densityGain,
        this.evaluateDynamicGPU.uploadCount, ...this.mesh.matrixWorld.elements,
        ...this.layers.flatMap(layer => [layer.density.field.version, layer.color?.field.version,
          ...layer.children.flatMap(child => [...child.offset.value.toArray(), child.scale.value, child.alpha.value])]),
      ].join(':');
      grid.update(renderer, scene, this.lightingBounds, { owner: this, extinctionGPU: this.lightingExtinction,
        shaderKey: `${this.materialSamplingKey}|${layers.join(';')}`, version });
    } else grid?.release(this);
    if (grid !== this.sampledLightingGrid || (grid?.version ?? -1) !== this.sampledLightingVersion) {
      this.updateMaterialTexture();
    }
  }

  private resolveLight(scene: THREE.Scene): void {
    let selected = this.light;
    if (!selected) {
      let brightness = -1;
      scene.traverseVisible(object => {
        if (!(object instanceof THREE.DirectionalLight)) return;
        const value = object.intensity * (object.color.r * 0.2126 + object.color.g * 0.7152 + object.color.b * 0.0722);
        if (value > brightness) {
          selected = object;
          brightness = value;
        }
      });
    }
    if (selected) {
      selected.getWorldPosition(this.lightPosition);
      selected.target.getWorldPosition(this.lightTarget);
      this.gpuLightDirection.value.copy(this.lightPosition).sub(this.lightTarget).normalize();
      this.gpuLightColor.value.copy(selected.color).multiplyScalar(selected.intensity);
    } else {
      this.gpuLightDirection.value.set(1, 1, 1).normalize();
      this.gpuLightColor.value.setRGB(1, 1, 1);
    }
  }

  private validateOptions(): void {
    if (!Number.isFinite(this.softParticleDistance) || this.softParticleDistance < 0) {
      throw new RangeError('Volume softParticleDistance must be finite and nonnegative.');
    }

    if (!Number.isFinite(this.downsample) || this.downsample < 1) {
      throw new RangeError('Volume downsample must be finite and at least one.');
    }
    if (
      ![this.jitterStrength, this.jitterSeed, this.anisotropy, this.shadowQuality].every(Number.isFinite) ||
      this.shadowQuality < 0
    )
      throw new RangeError('Volume jitter, lighting and shadow controls must be finite.');
    this.jitterStrength = THREE.MathUtils.clamp(this.jitterStrength, 0, 1);
    this.anisotropy = THREE.MathUtils.clamp(this.anisotropy, -0.9, 0.9);
    if (
      !Number.isFinite(this.adaptiveStepThreshold) ||
      this.adaptiveStepThreshold < 0 ||
      this.adaptiveStepThreshold >= 1 ||
      !Number.isFinite(this.adaptiveStepFactor) ||
      this.adaptiveStepFactor < 1 ||
      !Number.isFinite(this.transmittanceThreshold) ||
      this.transmittanceThreshold < 0 ||
      this.transmittanceThreshold >= 1 ||
      !Number.isFinite(this.sceneDepthBias) ||
      this.sceneDepthBias < 0
    ) {
      throw new RangeError('Volume adaptive thresholds must be in [0, 1), step factor >= 1, and depth bias >= 0.');
    }
    if (!Number.isFinite(this.emissive)) throw new RangeError('Volume emissive must be a finite scalar.');
    if (!Number.isFinite(this.densityNoiseStretch) || this.densityNoiseStretch < 0)
      throw new RangeError('Volume densityNoiseStretch must be finite and nonnegative.');
    if (
      !Number.isFinite(this.densityNoiseStrength) ||
      this.densityNoiseStrength < 0 ||
      !Number.isFinite(this.densityNoiseContrast) ||
      this.densityNoiseContrast < 0 ||
      !Number.isFinite(this.densityNoiseFrequency) ||
      this.densityNoiseFrequency < 0 ||
      !Number.isFinite(this.densityNoiseSpeed) ||
      !Number.isInteger(this.densityNoiseOctaves) ||
      this.densityNoiseOctaves < 1 ||
      this.densityNoiseOctaves > 4
    ) {
      throw new RangeError('Volume noise requires nonnegative finite strength/contrast, frequency, and 1..4 octaves.');
    }
    if (!Object.values(VolumeInterpolation).includes(this.interpolation as VolumeInterpolation)) {
      throw new RangeError('Unknown volume interpolation.');
    }
    if (!Object.values(VolumeDensityMapping).includes(this.densityMapping as VolumeDensityMapping)) {
      throw new RangeError('Unknown volume densityMapping.');
    }
    if (!(this.stepSizeMultiplier > 0) || !Number.isFinite(this.stepSizeMultiplier)) {
      throw new RangeError('Volume stepSizeMultiplier must be finite and positive.');
    }
    if (!Number.isFinite(this.densityGain) || this.densityGain < 0) {
      throw new RangeError('Volume densityGain must be finite and nonnegative.');
    }
    if (![this.minDensity, this.maxDensity].every(Number.isFinite) || this.maxDensity <= this.minDensity) {
      throw new RangeError('Volume minDensity/maxDensity must be finite and increasing.');
    }
    if (!Number.isFinite(this.steps) || this.steps < 1) throw new RangeError('Volume steps must be at least one.');
  }

  /** Classic WebGL renderers use sampled ramps; WebGPU uses normal GPU parameter bindings. */
  private updateAppearanceCurves(neutral = false): void {
    let changed = false;
    const white = new THREE.Color(1, 1, 1);
    for (const [row, parameter] of (['Temperature', 'Density', 'Speed', 'Vorticity'] as const).entries()) {
      const color = neutral ? null : this[`colorBy${parameter}`];
      const opacity = neutral || parameter === 'Density' ? null : this[`opacityBy${parameter}`];
      for (let i = 0; i < 256; i++) {
        // Null bypasses evaluation; other values follow the library ValueByParameter convention.
        const rgb = color == null ? white : evaluateByParameterColor(color, i / 255);
        const alpha = opacity == null ? 1 : evaluateByParameterNumber(opacity, i / 255);
        for (const [channel, value] of [rgb.r, rgb.g, rgb.b, alpha].entries()) {
          if (!Number.isFinite(value) || value < 0 || value > 65504) {
            throw new RangeError('Volume appearance multipliers must be finite, nonnegative half-float values.');
          }
          const index = (row * 256 + i) * 4 + channel;
          const half = THREE.DataUtils.toHalfFloat(value);
          changed ||= this.appearanceData[index] !== half;
          this.appearanceData[index] = half;
        }
      }
    }
    if (changed) this.appearanceTexture.needsUpdate = true;
    this.updateEmissiveCurves(neutral);
  }

  private updateEmissiveCurves(neutral: boolean): void {
    let changed = false;
    for (const [row, name] of ['Temperature', 'Density', 'Speed'].entries()) {
      const value = neutral ? null : this[`emissiveBy${name as 'Temperature' | 'Density' | 'Speed'}`];
      for (let i = 0; i < 256; i++) {
        const factor = value == null ? 1 : evaluateByParameterNumber(value, i / 255);
        if (!Number.isFinite(factor) || Math.abs(factor) > 65504)
          throw new RangeError('Volume emissive values must be finite half-float values.');

        const index = (row * 256 + i) * 4, half = THREE.DataUtils.toHalfFloat(factor);
        changed ||= this.emissiveData[index] !== half;
        this.emissiveData[index] = half;
      }
    }
    if (changed) this.emissiveTexture.needsUpdate = true;
  }

  private updateDensityCurve(): void {
    if (this.densityMapping !== VolumeDensityMapping.Curve) return;
    let changed = false;
    const curve = volumeNumber(this.densityCurve) as ValueByParameter<number>;
    for (let i = 0; i < 256; i++) {
      const value = typeof curve === 'number' ? curve : evaluateByParameterNumber(curve, i / 255);
      if (!Number.isFinite(value)) throw new RangeError('Volume densityCurve must return finite values.');
      const half = THREE.DataUtils.toHalfFloat(THREE.MathUtils.clamp(value, 0, 1));
      for (let channel = 0; channel < 4; channel++) {
        const index = i * 4 + channel;
        changed ||= this.curveData[index] !== half;
        this.curveData[index] = half;
      }
    }
    if (changed) this.curveTexture.needsUpdate = true;
  }

  protected override _updateGPU(
    buffers: GPUParticleBufferState | GPUParticleRenderBufferState,
    system: ParticleSystem,
    deltaTime = 0,
  ): void {
    void buffers;
    this._update([], system, deltaTime);
  }

  destroy(): void {
    this.attachedLightingGrid?.release(this);
    this.attachedLightingGrid = undefined;
    this.lightingGrid?.dispose();
    this.lightingGrid = undefined;
    for (const binding of this.bindings.values()) {
      if (binding.owned) binding.texture.dispose();
      binding.occupancy?.dispose();
    }
    this.bindings.clear();
    this.layers = [];
    this.geometry.dispose();
    this.webglMaterial.dispose();
    this.webgpuMaterial.dispose();
    this.curveTexture.dispose();
    this.lowResolutionMaterial?.dispose();
    this.dynamicTarget.dispose();
    this.opaqueDepth.dispose();
    this.appearanceTexture.dispose();
    this.emissiveTexture.dispose();
    this.jitterTexture.dispose();
    this.mesh.removeFromParent();
  }

  clear(): void {
    this.attachedLightingGrid?.release(this);
    this.opaqueDepth.attach(undefined, false);
    this.mesh.visible = false;
  }

  private resolveFields(system: ParticleSystem): Array<{ field: VolumeField; colorField?: VolumeField }> {
    const providers = system.getModules<VolumeFieldProvider>(['getVolumeField'], this.tags);
    const color = typeof this.colorField === 'function' ? this.colorField() : this.colorField;
    if (this.field) {
      const field = typeof this.field === 'function' ? this.field() : this.field;
      return field ? [{ field, colorField: this.colorField ? color : providers[0]?.getVolumeColorField?.() }] : [];
    }
    return providers.flatMap(provider => {
      const field = provider.getVolumeField();
      return field ? [{ field, colorField: this.colorField ? color : provider.getVolumeColorField?.() }] : [];
    });
  }

  private bindField(field: VolumeField, channels: 1 | 3 | 4): FieldBinding {
    let binding = this.bindings.get(field);
    if (
      !binding ||
      (!field.texture && !binding.resolution.equals(field.resolution)) ||
      binding.owned === !!field.texture ||
      (!!field.texture && (field.texture.type !== binding.texture.type
        || field.texture.format !== binding.texture.format))
    ) {
      if (binding?.owned) binding.texture.dispose();
      binding?.occupancy?.dispose();
      const sourceTexture = field.texture ?? this.createTexture(field, channels);
      binding = {
        field,
        texture: sourceTexture,
        textureNode: texture3D(sourceTexture),
        owned: !field.texture,
        version: field.version,
        resolution: field.resolution.clone(),
        minimum: uniform(field.bounds.min.clone()),
        size: uniform(field.bounds.getSize(new THREE.Vector3())),
        resolutionNode: uniform(field.resolution.clone()),
        textureScale: uniform(new THREE.Vector3(1, 1, 1)),
      };
      this.bindings.set(field, binding);
    } else if (binding.owned && binding.version !== field.version) {
      if (!field.data) throw new Error('VolumeField.data is required for CPU volume textures.');
      (binding.texture as THREE.Data3DTexture).image.data = field.data;
      binding.texture.needsUpdate = true;
      binding.version = field.version;
    }
    if (field.texture) binding.textureNode.value = binding.texture = field.texture;
    binding.resolution.copy(field.resolution);
    binding.resolutionNode.value.copy(field.resolution);
    binding.textureScale.value.copy(field.resolution).divide(field.textureResolution ?? field.resolution);
    binding.minimum.value.copy(field.bounds.min);
    field.bounds.getSize(binding.size.value).clampScalar(Number.EPSILON, Infinity);
    return binding;
  }

  private createTexture(field: VolumeField, channels: 1 | 3 | 4): THREE.Data3DTexture {
    if (!field.data) throw new Error('VolumeField.data is required when no GPU texture is supplied.');
    const texture = new THREE.Data3DTexture(field.data, field.resolution.x, field.resolution.y, field.resolution.z);

    texture.format = channels === 4 ? THREE.RGBAFormat : channels === 3 ? THREE.RGBFormat : THREE.RedFormat;
    texture.type = field.data instanceof Float32Array ? THREE.FloatType : THREE.UnsignedByteType;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;

    return texture;
  }

  private updateMaterialTexture(): void {
    const uniforms = this.webglMaterial.uniforms;
    for (const key of Object.keys(uniforms)) {
      if (key.startsWith('layer')) delete uniforms[key];
    }
    const sources = this.layers;
    const children = sources.flatMap(layer => layer.children);
    sources.forEach((layer, index) => {
      for (const [name, binding] of [
        ['Density', layer.density],
        ['Color', layer.color],
      ] as const) {
        if (!binding) continue;
        uniforms[`layer${name}Map${index}`] = { value: binding.texture };
        uniforms[`layer${name}Min${index}`] = { value: binding.minimum.value };
        uniforms[`layer${name}Size${index}`] = { value: binding.size.value };
        uniforms[`layer${name}Resolution${index}`] = { value: binding.resolution };
      }
    });
    children.forEach((layer, index) => {
      uniforms[`layerOffset${index}`] = { value: layer.offset.value };
      uniforms[`layerScale${index}`] = layer.scale;
      uniforms[`layerAlpha${index}`] = layer.alpha;
    });
    this.webglMaterial.fragmentShader = volumeFrag.replace(
      '/* VOLUME_FIELDS */',
      buildVolumeBindings(
        sources.map(layer => Boolean(layer.color)),
        sources.map(layer => layer.children.length),
        this.interpolation,
        this.densityMapping,
        sources.map(layer => layer.density.field.parameterChannels ?? {}),
        this.appearanceEnabled(),
        sources.map(layer => !!layer.density.field.parametersPremultiplied),
        this.emissive !== 0,
      ),
    );
    this.webglMaterial.needsUpdate = true;

    this.webgpuMaterial.dispose();
    this.webgpuMaterial = this.createWebGPUMaterial();
    this.lowResolutionMaterial?.dispose();
    this.lowResolutionMaterial = undefined;
  }

  private updateBounds(): void {
    this.bounds.makeEmpty();
    let cellSize = Infinity;
    const center = new THREE.Vector3(), size = new THREE.Vector3();
    const childCenter = new THREE.Vector3(), halfSize = new THREE.Vector3(), corner = new THREE.Vector3();

    // Union transformed bounds directly, without allocating a box for every child.
    for (const layer of this.layers) {
      const field = layer.density.field;
      field.bounds.getCenter(center);
      field.bounds.getSize(size);

      for (const child of layer.children) {
        childCenter.copy(center).add(child.offset.value);
        halfSize.copy(size).multiplyScalar(child.scale.value * 0.5);
        this.bounds.expandByPoint(corner.copy(childCenter).sub(halfSize));
        this.bounds.expandByPoint(corner.copy(childCenter).add(halfSize));
        const cell = corner.copy(size).multiplyScalar(child.scale.value).divide(field.resolution);
        cellSize = Math.min(cellSize, cell.x, cell.y, cell.z);
      }
    }
    this.gpuCellSize.value = Math.max(1e-6, Number.isFinite(cellSize) ? cellSize : 1);
    this.mesh.visible = !this.bounds.isEmpty();
    if (!this.mesh.visible) return;
    this.bounds.getCenter(this.boundsCenter);
    this.bounds.getSize(this.boundsSize);
    this.mesh.position.copy(this.boundsCenter);
    this.mesh.scale.copy(this.boundsSize);
    this.gpuBoundsMinimum.value.copy(this.bounds.min);
    this.gpuBoundsSize.value.copy(this.boundsSize);
  }

  private setActiveMaterial(renderer?: THREE.WebGLRenderer | WebGPURenderer): void {
    if (!this.dynamicResolution) this.dynamicTarget.releaseTiming();
    if (renderer && !(renderer instanceof WebGPURenderer) && this.downsample > 1) {
      throw new Error('Volume downsampling requires WebGPURenderer.');
    }
    if (renderer && !(renderer instanceof WebGPURenderer) && this.densityNoiseStrength > 0) {
      throw new Error('Procedural volume density masks require a WebGPU renderer.');
    }
    const gpuTexture = this.layers.some(
      layer => (layer.density.texture as THREE.Texture & { isStorageTexture?: boolean }).isStorageTexture,
    );
    const gpu = renderer instanceof WebGPURenderer || (!renderer && gpuTexture);
    const reduced = gpu && this.dynamicTarget.resolutionScale < 1;
    if (reduced) {
      this.dynamicTarget.material.side = this.webgpuMaterial.side;
      this.dynamicTarget.material.depthTest = this.depthTest;
      this.dynamicTarget.material.depthNode = (this.webgpuMaterial as MeshBasicNodeMaterial).depthNode;
    }
    this.mesh.material = gpu ? (reduced ? this.dynamicTarget.material : this.webgpuMaterial) : this.webglMaterial;
  }

  private updateMaterialSide(camera: THREE.Camera): void {
    camera.getWorldPosition(this.cameraWorldPosition);
    this.cameraLocalPosition.copy(this.cameraWorldPosition);
    this.mesh.worldToLocal(this.cameraLocalPosition);
    const inside =
      Math.abs(this.cameraLocalPosition.x) <= 0.5 &&
      Math.abs(this.cameraLocalPosition.y) <= 0.5 &&
      Math.abs(this.cameraLocalPosition.z) <= 0.5;
    const side = inside ? THREE.BackSide : THREE.FrontSide;
    [this.webglMaterial, this.webgpuMaterial, this.dynamicTarget.material].forEach(material => {
      if (material.side === side) return;
      material.side = side;
      material.needsUpdate = true;
    });
  }

  private createWebGLMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      side: THREE.FrontSide,
      transparent: true,
      depthTest: this.depthTest,
      depthWrite: false,
      uniforms: {
        boundsMinimum: { value: this.gpuBoundsMinimum.value },
        boundsSize: { value: this.gpuBoundsSize.value },
        base: { value: this.color.clone() },
        threshold: { value: this.threshold },
        range: { value: this.range },
        opacity: { value: this.opacity },
        steps: { value: this.steps },
        jitterStrength: { value: this.jitterStrength },
        jitterSeed: { value: this.jitterSeed },
        jitterMap: { value: this.jitterTexture },
        anisotropy: { value: this.anisotropy },
        shadowQuality: { value: this.shadowQuality },
        lightDirection: this.gpuLightDirection,
        lightColor: this.gpuLightColor,
        worldToVolume: { value: new THREE.Matrix4() },
        volumeToWorld: { value: this.mesh?.matrixWorld ?? new THREE.Matrix4() },
        cellSize: { value: 1 },
        stepSizeMultiplier: { value: this.stepSizeMultiplier },
        densityGain: { value: this.densityGain },
        densityRange: { value: new THREE.Vector2(this.minDensity, this.maxDensity) },
        densityCurve: { value: this.curveTexture },
        appearanceMap: { value: this.appearanceTexture },
        emissiveMap: { value: this.emissiveTexture },
        emissive: { value: this.emissive },
        ...Object.fromEntries(
          this.gpuAppearanceRanges.map((range, index) => [`appearanceRange${index}`, { value: range.value.clone() }]),
        ),
        adaptiveStepping: { value: this.adaptiveStepping },
        adaptiveStepThreshold: { value: this.adaptiveStepThreshold },
        adaptiveStepFactor: { value: this.adaptiveStepFactor },
        transmittanceThreshold: { value: this.transmittanceThreshold },
      },
      vertexShader: volumeVert,
      fragmentShader: volumeFrag.replace(
        '/* VOLUME_FIELDS */',
        buildVolumeBindings([], [], this.interpolation, this.densityMapping),
      ),
    });
  }

  private createWebGPUMaterial(reduced = false): THREE.Material {
    this.gpuMaterialDepthTest = this.depthTest;
    const lightingGrid = this.lightingGrid;
    this.sampledLightingGrid = lightingGrid;
    this.sampledLightingVersion = lightingGrid?.version ?? -1;
    const material = new MeshBasicNodeMaterial({
      color: this.color,
      opacity: this.opacity,
      side: THREE.FrontSide,
      transparent: true,
      depthTest: this.depthTest,
      depthWrite: false,
    });

    if (this.layers.length) {
      // The main buffer may contain transparent depth by now. Opaque occlusion is tested along
      // the ray below, so the proxy must pass that polluted hardware buffer without writing it.
      material.depthNode = Fn(() => {
        const clip = cameraProjectionMatrix.mul(vec4(0, 0, cameraNear.negate(), 1));
        return clip.z.div(clip.w).clamp(0, 1);
      })();
      const raymarch = Fn(() => {
        const firstOpacityDepth = float(0).toVar('volumeFirstOpacityDepth');
        const { origin, direction } = this.volumeRay();
        const inverseDirection = vec3(1).div(direction);
        const entry = vec3(-0.5).sub(origin).mul(inverseDirection);
        const exit = vec3(0.5).sub(origin).mul(inverseDirection);
        const minimum = min(entry, exit);
        const maximum = max(entry, exit);
        const near = max(max(minimum.x, minimum.y), minimum.z);
        const far = min(min(maximum.x, maximum.y), maximum.z).toVar('volumeExit');
        const viewOrigin = cameraViewMatrix.mul(modelWorldMatrix.mul(vec4(origin, 1))).xyz.toVar('volumeViewOrigin');
        const viewDirection = cameraViewMatrix
          .mul(modelWorldMatrix.mul(vec4(direction, 0)))
          .xyz.toVar('volumeViewDirection');
        const start = max(max(near, float(0)), cameraNear.negate().sub(viewOrigin.z).div(viewDirection.z)).toVar(
          'volumeStart',
        );
        If(start.greaterThanEqual(far), () => Discard());
        const metric = direction.mul(this.gpuBoundsSize).length().toVar('volumeMetric');
        const depth = reduced
          ? this.dynamicTarget.sceneDepth.sample(screenUV).level(float(0)).r
          : this.viewportDepth;
        const rawDepth = this.depthTest ? depth.toVar('volumeSceneDepth') : float(1);
        const orthographic = cameraProjectionMatrix.mul(vec4(0, 0, 0, 1)).w.equal(1);
        const sceneZ = orthographic
          .select(
            orthographicDepthToViewZ(rawDepth, cameraNear, cameraFar),
            perspectiveDepthToViewZ(rawDepth, cameraNear, cameraFar),
          )
          .toVar('volumeSceneZ');
        if (this.depthTest) {
          If(this.gpuSceneDepthClipping.greaterThan(0), () => {
            If(viewDirection.z.lessThan(-1e-8), () => {
              far.assign(min(far, sceneZ.add(this.gpuSceneDepthBias).sub(viewOrigin.z).div(viewDirection.z)));
            });
          });
        }
        If(start.greaterThanEqual(far), () => Discard());
        const worldLength = metric.mul(far.sub(start));
        // Do not redistribute every sample when a ray crosses an integer sample-count boundary.
        const worldStep = max(
          this.gpuCellSize.mul(this.gpuStepSize),
          worldLength.div(float(this.gpuSteps)),
        );
        // Use the complete visible interval if the requested sampling exceeds the step budget.
        const baseStep = worldStep.div(metric).toVar('volumeBaseStep');
        const distance = start.toVar('volumeDistance');
        // Directional HG is constant along a camera ray. Scale its normalized phase by 4π
        // so an isotropic unit light preserves the familiar unit brightness. Ray and source-to-light
        // directions are both opposite the physical outgoing/photon-travel vectors, preserving their dot.
        const worldDirection = modelWorldMatrix.mul(vec4(direction, 0)).xyz.normalize();
        const cosine = worldDirection.dot(this.gpuLightDirection);
        const g = this.gpuAnisotropy;
        const phase = float(1)
          .sub(g.mul(g))
          .div(pow(float(1).add(g.mul(g)).sub(g.mul(cosine).mul(2)), 1.5));
        const lightDirection = modelWorldMatrixInverse.mul(vec4(this.gpuLightDirection, 0)).xyz.normalize();
        const sampleJitter = this.createRayJitter();
        const accumulated = vec4(0).toVar('volumeAccumulated');
        // Keep the quality budget uniform-backed: edits reuse the compiled raymarch pipeline.
        Loop({ start: 0, end: this.gpuSteps, type: 'int' }, ({ i }) => {
          // Derive the lattice from its index: repeated additions and DDA jumps must not
          // round differently and select unrelated spatial jitter on later strata.
          If(this.gpuAdaptiveStepping.lessThan(0.5), () => distance.assign(start.add(baseStep.mul(float(i)))));
          If(distance.greaterThanEqual(far), () => Break());
          const growth = mix(
            float(1),
            this.gpuAdaptiveStepFactor,
            smoothstep(this.gpuAdaptiveStepThreshold, float(1), accumulated.a).mul(this.gpuAdaptiveStepping),
          );
          if (this.emptySpaceSkipping && this.layers.every(layer => !!layer.density.occupancy)) {
            const advance = this.emptyAdvance(origin.add(direction.mul(distance)), direction);
            const stride = baseStep.mul(growth);
            const skip = min(advance, far.sub(distance))
              .div(stride)
              .floor()
              .min(float(this.gpuSteps).sub(float(i)))
              .toVar();
            If(skip.greaterThan(0), () => {
              distance.addAssign(stride.mul(skip));
              i.addAssign(int(skip.sub(1)));
              Continue();
            });
          }
          const segment = min(baseStep.mul(growth), far.sub(distance)).toVar('volumeSegment');
          // One stable, decorrelated evaluation inside each complete integration stratum.
          const center = origin.add(direction.mul(distance.add(segment.mul(0.5))));
          const point = center.add(0.5).mul(this.gpuBoundsSize).add(this.gpuBoundsMinimum);
          const sampleOffset = mix(float(0.5), sampleJitter(point, float(i)), this.gpuJitter);
          const position = origin.add(direction.mul(distance.add(segment.mul(sampleOffset))));
          // Materialize outside optional depth branches so metadata always receives the sample depth.
          const viewZ = viewOrigin.z.add(viewDirection.z.mul(distance.add(segment.mul(sampleOffset))))
            .toVar('volumeSampleViewZ');
          if (this.depthTest) {
            If(this.gpuSceneDepthClipping.lessThan(1), () => {
              If(viewZ.lessThanEqual(sceneZ.add(this.gpuSceneDepthBias)), () => Break());
            });
          }
          const sample = this.sampleVolume(position);
          const density = this.modulateDensity(
            position, sample.density, sample.temperature, sample.noise, () => sample.velocity,
          );
          const opacity = this.renderOpacity(density).mul(sample.opacity).clamp(0, 1).toVar('volumeSampleOpacity');

          // Match sprite soft particles in view space, reusing the depth already fetched for clipping.
          // Fade extinction before distance integration so changing ray steps does not change softness.
          if (this.depthTest) {
            If(this.gpuSoftParticleDistance.greaterThan(0), () => {
              opacity.mulAssign(smoothstep(0, this.gpuSoftParticleDistance, viewZ.sub(sceneZ).abs()));
            });
          }

          // A transparent stratum contributes no radiance. Advance before continuing so adaptive
          // marching follows the identical lattice, without paying for lighting or shadow rays.
          If(opacity.lessThanEqual(0), () => {
            distance.addAssign(segment);
            Continue();
          });

          const alpha = float(1).sub(
            pow(float(1).sub(opacity), metric.mul(segment)),
          );
          const color = sample.color;
          const contribution = float(1).sub(accumulated.a).mul(alpha);
          if (reduced) If(firstOpacityDepth.equal(0).and(contribution.greaterThan(0)), () => {
            firstOpacityDepth.assign(viewZ);
          });
          // Fully self-lit samples need neither LightingGrid fetches nor shadow marches.
          const emissive = sample.emissive.clamp(0, 1);
          const shaded = color.toVar('volumeShadedColor');
          If(emissive.lessThan(1), () => {
            const worldPosition = modelWorldMatrix.mul(vec4(position, 1)).xyz;
            const transmission = !lightingGrid && this.shadowQuality > 0
              ? this.lightTransmittance(position, lightDirection) : float(1);
            const incident = vec3(0).toVar();
            if (lightingGrid) {
              If(this.gpuAnisotropy.equal(0), () => {
                incident.assign(lightingGrid.sampleIsotropicGPU(worldPosition));
              }).Else(() => {
                incident.assign(lightingGrid.sampleScatteringGPU(worldPosition, worldDirection, this.gpuAnisotropy));
              });
            } else incident.assign(vec3(0.2).add(this.gpuLightColor.mul(phase).mul(transmission).mul(0.8)));
            shaded.assign(mix(color.mul(incident), color, emissive));
          });
          accumulated.rgb.addAssign(shaded.add(sample.emission ?? vec3(0)).mul(contribution));
          accumulated.a.addAssign(contribution);
          If(float(1).sub(accumulated.a).lessThanEqual(this.gpuTransmittanceThreshold), () => Break());
          distance.addAssign(segment);
        });
        If(accumulated.a.lessThanEqual(0), () => Discard());
        const color = vec4(accumulated.rgb.div(max(accumulated.a, 1e-6)), accumulated.a);
        return VolumeRayResult(color, firstOpacityDepth);
      })() as unknown as VolumeRayValue;
      const rayResult = raymarch.toVar();
      if (reduced) {
        material.outputNode = rayResult.get('color');
        material.mrtNode = mrt({
          output: rayResult.get('color'),
          volumeMetadata: Fn(() => {
            const raw = this.dynamicTarget.sceneDepth.sample(screenUV).level(float(0)).r;
            const ortho = cameraProjectionMatrix.mul(vec4(0, 0, 0, 1)).w.equal(1);
            const sceneZ = ortho.select(
              orthographicDepthToViewZ(raw, cameraNear, cameraFar),
              perspectiveDepthToViewZ(raw, cameraNear, cameraFar),
            );
            return vec4(sceneZ, rayResult.get('firstDepth'), 0, 1);
          })(),
        });
      } else material.fragmentNode = rayResult.get('color');
    }

    return material;
  }


  /** Distance to the nearest coarse boundary across all source/copy transforms, only when all are empty. */
  private emptyAdvance(position: Node<'vec3'>, direction: Node<'vec3'>): Node<'float'> {
    const point = position.add(0.5).mul(this.gpuBoundsSize).add(this.gpuBoundsMinimum);
    const travel = direction.mul(this.gpuBoundsSize);
    const occupied = bool(false).toVar();
    const distance = float(1e20).toVar();
    for (const layer of this.layers) {
      const binding = layer.density,
        occupancy = binding.occupancy!;
      const center = binding.minimum.add(binding.size.mul(0.5));
      for (const child of layer.children) {
        const source = point.sub(center).sub(child.offset).div(child.scale).add(center);
        const delta = travel.div(child.scale);
        const inverse = delta.greaterThanEqual(0).select(vec3(1), vec3(-1)).div(delta.abs().max(1e-12));
        const uv = source.sub(binding.minimum).div(binding.size);
        If(child.alpha.greaterThan(0), () => {
          If(uv.greaterThanEqual(0).all().and(uv.lessThanEqual(1).all()), () => {
            const cell = floor(uv.mul(binding.resolutionNode).div(8))
              .clamp(vec3(0), occupancy.getResolutionNode().sub(1));
            const flag = occupancy.sample(cell.add(0.5).div(occupancy.getResolutionNode())).r;
            occupied.assign(occupied.or(flag.greaterThan(0)));
            const boundary = cell
              .add(delta.greaterThanEqual(0).select(vec3(1), vec3(0)))
              .mul(8)
              .div(binding.resolutionNode)
              .mul(binding.size)
              .add(binding.minimum);
            const limits = boundary.sub(source).mul(inverse).max(0);
            distance.assign(min(distance, min(min(limits.x, limits.y), limits.z)));
          }).Else(() => {
            const a = binding.minimum.sub(source).mul(inverse);
            const b = binding.minimum.add(binding.size).sub(source).mul(inverse);
            const lo = min(a, b),
              hi = max(a, b);
            const entry = max(max(lo.x, lo.y), lo.z);
            const exit = min(min(hi.x, hi.y), hi.z);
            If(exit.greaterThanEqual(max(entry, 0)), () => distance.assign(min(distance, max(entry, 0))));
          });
        });
      }
    }
    return occupied.select(float(0), distance);
  }

  private modulateDensity(position: Node<'vec3'>, density: Node<'float'>,
    temperature: Node<'float'>, noise?: ReturnType<VolumeRenderer['noiseCoefficients']>,
    velocity?: () => Node<'vec3'>): Node<'float'> {
    if (this.densityNoiseStrength <= 0 && !noise) return density;
    const masked = density.toVar();
    If(density.greaterThan(0), () => {
      const { strength, contrast, frequency, stretch } = noise ?? this.noiseCoefficients(temperature, density);
      const applyMask = () => {
        const point = position.add(0.5).mul(this.gpuBoundsSize).add(this.gpuBoundsMinimum).toVar();
        if (this.densityNoiseStretch > 0 && velocity) {
          // Zero local stretch avoids even the sparse velocity lookup. Keep the simulation origin
          // as the anchor, so domain growth never slides the mask's coordinate lattice.
          If(stretch.greaterThan(0), () => point.assign(stretchAlongVelocity(point, velocity(), stretch)));
        }
        const noise = generateGPUParticleNoise4D(
          point.mul(frequency),
          {
            frequency: 1,
            octaves: this.densityNoiseOctaves,
            lacunarity: 2,
            persistence: 0.5,
            time: 0,
            offset: new THREE.Vector3(),
          },
          this.gpuNoiseTime,
        );
        masked.mulAssign(pow(noise.sub(0.5).mul(contrast).add(0.5).clamp(0, 1), strength));
      };
      // A zero local strength disables the mask, including zero noise samples (avoid pow(0, 0)).
      if (noise || this.densityNoiseStrengthByTemperature != null) If(strength.greaterThan(0), applyMask);
      else applyMask();
    });
    return masked;
  }

  private noiseCoefficients(temperature: Node<'float'>, density: Node<'float'> = float(0),
    speed: Node<'float'> = float(0)) {
    const range = this.gpuAppearanceRanges[0];
    const active = this.densityNoiseStrengthByTemperature != null || this.densityNoiseContrastByTemperature != null
      || this.densityNoiseFrequencyByTemperature != null;
    const t = active ? temperature.sub(range.x).div(range.y.sub(range.x)).clamp(0, 1).toVar() : float(0);
    const coefficient = (
      name: 'densityNoiseStrength' | 'densityNoiseContrast' | 'densityNoiseFrequency', base: Node<'float'>,
    ) => {
      const key = `${name}ByTemperature` as const;
      return this[key] == null ? base : base.mul(this.evaluateDynamicGPU.parameterNumber(
        key, () => this[key] ?? undefined, t, 1).max(0));
    };
    const strength = coefficient('densityNoiseStrength', this.gpuNoiseStrength);
    const contrast = coefficient('densityNoiseContrast', this.gpuNoiseContrast);
    const frequency = coefficient('densityNoiseFrequency', this.gpuNoiseFrequency);
    let stretch: Node<'float'> = this.gpuNoiseStretch;
    if (this.densityNoiseStretch > 0) {
      for (const [index, name] of (['Temperature', 'Density', 'Speed'] as const).entries()) {
        const value = [temperature, density.mul(this.gpuDensityGain), speed][index];
        const limits = this.gpuAppearanceRanges[index];
        const normalized = value.sub(limits.x).div(limits.y.sub(limits.x)).clamp(0, 1);
        const key = `densityNoiseStretchBy${name}` as const;
        if (this[key] != null) stretch = stretch.mul(this.evaluateDynamicGPU.parameterNumber(
          key, () => this[key] ?? undefined, normalized, 1));
      }
    }
    return { strength, contrast, frequency, stretch };
  }

  private lightTransmittance(position: Node<'vec3'>, direction: Node<'vec3'>): Node<'float'> {
    const inverse = direction.greaterThanEqual(0).select(vec3(1), vec3(-1)).div(direction.abs().max(1e-6));
    const exit = max(vec3(-0.5).sub(position).mul(inverse), vec3(0.5).sub(position).mul(inverse));
    const far = min(min(exit.x, exit.y), exit.z).max(0);
    const metric = direction.mul(this.gpuBoundsSize).length();
    const budget = this.gpuShadowQuality.mul(8).ceil().clamp(1, 64);
    const step = max(this.gpuCellSize.mul(2).div(this.gpuShadowQuality.max(1e-6)), far.mul(metric).div(budget)).div(
      metric,
    );
    const distance = float(0).toVar();
    const transmission = float(1).toVar();
    Loop(64, ({ i }) => {
      If(float(i).greaterThanEqual(budget).or(distance.greaterThanEqual(far)), () => Break());
      const segment = min(step, far.sub(distance));
      const point = position.add(direction.mul(distance.add(segment.mul(0.5))));
      const sample = this.sampleVolume(point, false);
      const density = this.modulateDensity(
        point, sample.density, sample.temperature, sample.noise, () => sample.velocity,
      );
      transmission.mulAssign(
        pow(float(1).sub(this.renderOpacity(density).mul(sample.opacity).clamp(0, 1)), segment.mul(metric)),
      );
      distance.addAssign(segment);
      If(transmission.lessThanEqual(0.001), () => Break());
    });
    return transmission;
  }

  private volumeRay(): { origin: Node<'vec3'>; direction: Node<'vec3'> } {
    const surfaceView = cameraViewMatrix.mul(modelWorldMatrix.mul(vec4(positionGeometry, 1)));
    const orthographicOrigin = cameraWorldMatrix.mul(vec4(surfaceView.xy, 0, 1)).xyz;
    const orthographic = cameraProjectionMatrix.mul(vec4(0, 0, 0, 1)).w.equal(1);
    const cameraOrigin = orthographic.select(orthographicOrigin, cameraPosition);
    const origin = modelWorldMatrixInverse.mul(vec4(cameraOrigin, 1)).xyz;
    return { origin, direction: positionGeometry.sub(origin).normalize() };
  }

  private createRayJitter(): (point: Node<'vec3'>, index: Node<'float'>) => Node<'float'> {
    // Fetch once per ray. Screen-space ranks remove the old piecewise-constant world-cell phase.
    const pixel = ivec2(screenCoordinate.xy.mod(32));
    const rotation = texture(this.jitterTexture).load(pixel).r.mul(255).add(0.5).div(256)
      .add(hash(floatBitsToUint(this.gpuJitterSeed))).toVar('volumeRayJitterRotation');
    return (_point, index) => volumeJitter(rotation, index);
  }

  private sampleVolume(
    position: Node<'vec3'>,
    includeColor = true,
  ): {
    color: Node<'vec3'>;
    density: Node<'float'>;
    opacity: Node<'float'>;
    temperature: Node<'float'>;
    velocity: Node<'vec3'>;
    emissive: Node<'float'>;
    emission?: Node<'vec3'>;
    noise?: ReturnType<VolumeRenderer['noiseCoefficients']>;
  } {
    const point = position.add(0.5).mul(this.gpuBoundsSize).add(this.gpuBoundsMinimum);
    const result = vec4(0).toVar('volumeSample');
    const parameters = vec3(0).toVar('volumeParameters');
    const base = vec3(this.gpuBaseR, this.gpuBaseG, this.gpuBaseB);
    for (const layer of this.layers) {
      const center = layer.density.minimum.add(layer.density.size.mul(0.5));
      for (const child of layer.children) {
        const sourcePoint = point.sub(center).sub(child.offset).div(child.scale).add(center);
        const uv = sourcePoint.sub(layer.density.minimum).div(layer.density.size);
        If(uv.greaterThanEqual(0).all().and(uv.lessThanEqual(1).all()), () => {
          const field = this.readVolume(layer.density, uv).toVar();
          const density = max(field.r, float(0)).mul(child.alpha);
          const channels = layer.density.field.parameterChannels;
          const parameter = (key: 'temperature' | 'speed' | 'vorticity') =>
            channels?.[key] === undefined ? float(0) : [field.r, field.g, field.b, field.a][channels[key]!];
          const weight = layer.density.field.parametersPremultiplied ? child.alpha : density;
          parameters.addAssign(vec3(parameter('temperature'), parameter('speed'), parameter('vorticity')).mul(weight));
          const color = vec3(base).toVar();
          if (includeColor && layer.color) {
            const colorUV = sourcePoint.sub(layer.color.minimum).div(layer.color.size);
            If(colorUV.greaterThanEqual(0).all().and(colorUV.lessThanEqual(1).all()), () => {
              const sample = this.readVolume(layer.color!, colorUV);
              color.assign(base.mul(mix(vec3(1), sample.rgb, sample.a)));
            });
          }
          result.addAssign(vec4(color.mul(density), density));
        });
      }
    }
    const physical = parameters.div(max(result.a, 1e-6));
    const values = [physical.x, result.a.mul(this.gpuDensityGain), physical.y, physical.z];
    const multiplier = vec4(1).toVar('volumeAppearance');
    const names = ['Temperature', 'Density', 'Speed', 'Vorticity'] as const;
    const emissive = (includeColor && this.emissive !== 0 ? this.gpuEmissive : float(0))
      .toVar('volumeEmissive');
    for (let row = 0; row < names.length; row++) {
      const name = names[row],
        range = this.gpuAppearanceRanges[row];
      const t = values[row].sub(range.x).div(range.y.sub(range.x)).clamp(0, 1);
      if (includeColor && name !== 'Vorticity' && this[`emissiveBy${name}`] != null)
        emissive.mulAssign(this.evaluateDynamicGPU.parameterNumber(`emissiveBy${name}`,
          () => this[`emissiveBy${name}`] ?? undefined, t, 1));
      // Reuse the same GPU parameter bindings as other renderers/materials. Null is neutral.
      if (includeColor && this[`colorBy${name}`] != null) {
        multiplier.rgb.mulAssign(
          this.evaluateDynamicGPU.parameterColor(
            `colorBy${name}`,
            () => this[`colorBy${name}`] ?? undefined,
            t,
            new THREE.Color('white'),
          ),
        );
      }
      if (name !== 'Density' && this[`opacityBy${name}`] != null)
        multiplier.a.mulAssign(
          this.evaluateDynamicGPU.parameterNumber(
            `opacityBy${name}`,
            () => this[`opacityBy${name}`] ?? undefined,
            t,
            1,
          ),
        );
    }
    // Modules see the configured effective factor; final shading clamps again after custom edits.
    emissive.assign(emissive.clamp(0, 1));
    const color = result.rgb.div(max(result.a, 1e-6)).mul(multiplier.rgb);
    let velocity: Node<'vec3'> | undefined;
    const sampleVelocity = () => velocity ??= this.sampleGasVelocity(point, result.a).toVar();
    if (!this.gasModules.length) {
      const noise = this.densityNoiseStretch > 0 ? this.noiseCoefficients(physical.x, result.a, physical.y) : undefined;
      return { color, density: result.a, opacity: multiplier.a, temperature: physical.x, emissive, noise,
        get velocity() { return sampleVelocity(); } };
    }

    // The same cell view references only local variables, never writable simulation storage.
    const cell: GPUGasCell = {
      position: point, density: result.a.toVar(), temperature: physical.x.toVar(), color: color.toVar(),
      // Reading velocity is optional: fire's mask-only callback adds no sparse-storage bindings or reads.
      get velocity() { return sampleVelocity(); },
    };
    const noise = this.noiseCoefficients(cell.temperature, cell.density, physical.y);
    const context: GasRenderModuleContext = {
      module: this.gasModules[0], elapsedTime: this.gasElapsedTime,
      density: cell.density, color: cell.color, opacity: multiplier.a.toVar(), emission: vec3(0).toVar(), emissive,
      densityNoiseStrength: noise.strength.toVar(), densityNoiseContrast: noise.contrast.toVar(),
      densityNoiseFrequency: noise.frequency.toVar(),
    };
    for (const module of this.gasModules) module.modifyRenderGPU!(cell, { ...context, module });
    return { color: cell.color, density: cell.density, temperature: cell.temperature,
      opacity: context.opacity, emission: context.emission, emissive: context.emissive,
      get velocity() { return cell.velocity; },
      noise: { strength: context.densityNoiseStrength, contrast: context.densityNoiseContrast,
        frequency: context.densityNoiseFrequency, stretch: noise.stretch } };
  }

  /** Lazily read existing producer velocity, without gathering density twice for a single source. */
  private sampleGasVelocity(point: Node<'vec3'>, density: Node<'float'>): Node<'vec3'> {
    if (this.layers.length === 1 && this.layers[0].children.length === 1) {
      const layer = this.layers[0], child = layer.children[0];
      if (!layer.density.field.sampleVelocityGPU) return vec3(0);
      const center = layer.density.minimum.add(layer.density.size.mul(0.5));
      const source = point.sub(center).sub(child.offset).div(child.scale).add(center);
      return Fn(() => {
        const velocity = vec3(0).toVar();
        If(density.greaterThan(0), () => velocity.assign(layer.density.field.sampleVelocityGPU!(source)));
        return velocity;
      })();
    }
    return Fn(() => {
      const momentum = vec3(0).toVar();
      const mass = float(0).toVar();
      for (const layer of this.layers) {
        if (!layer.density.field.sampleVelocityGPU) continue;
        const center = layer.density.minimum.add(layer.density.size.mul(0.5));
        for (const child of layer.children) {
          const source = point.sub(center).sub(child.offset).div(child.scale).add(center);
          const uv = source.sub(layer.density.minimum).div(layer.density.size);
          If(uv.greaterThanEqual(0).all().and(uv.lessThanEqual(1).all()), () => {
            const density = this.readVolume(layer.density, uv).r.max(0).mul(child.alpha);
            mass.addAssign(density);
            momentum.addAssign(layer.density.field.sampleVelocityGPU!(source).mul(density));
          });
        }
      }
      return momentum.div(mass.max(1e-6));
    })();
  }

  private appearanceEnabled(): boolean[] {
    return (['Temperature', 'Density', 'Speed', 'Vorticity'] as const).map(
      parameter =>
        this[`colorBy${parameter}`] != null || (parameter !== 'Density' && this[`opacityBy${parameter}`] != null),
    );
  }

  private renderOpacity(rawDensity: Node<'float'>): Node<'float'> {
    if (this.densityMapping === VolumeDensityMapping.None) return float(0);
    const density = max(rawDensity.mul(this.gpuDensityGain), 0);
    const normalized = density
      .sub(this.gpuDensityRange.x)
      .div(this.gpuDensityRange.y.sub(this.gpuDensityRange.x))
      .clamp(0, 1);
    let mapped = smoothstep(
      max(this.gpuThreshold.sub(this.gpuRange), 1e-6),
      this.gpuThreshold.add(this.gpuRange),
      normalized,
    );
    if (this.densityMapping === VolumeDensityMapping.Linear) mapped = normalized;
    if (this.densityMapping === VolumeDensityMapping.Curve) {
      mapped = texture(this.curveTexture)
        .sample(vec2(normalized.mul(255).add(0.5).div(256), 0.5))
        .level(float(0)).r;
    }
    return normalized
      .greaterThan(0)
      .select(normalized.greaterThanEqual(1).select(float(1), mapped).mul(this.gpuOpacity).clamp(0, 1), float(0));
  }

  private readVolume(binding: FieldBinding, uv: Node<'vec3'>): Node<'vec4'> {
    // Rays terminate/skip independently. Implicit texture derivatives are undefined
    // in divergent fragment control flow; volumes have no mip chain, so always read LOD zero.
    const resolution = binding.resolutionNode;
    const sampleAt = (position: Node<'vec3'>) => binding.textureNode.sample(
      position.clamp(vec3(0.5).div(resolution), vec3(1).sub(vec3(0.5).div(resolution)))
        .mul(binding.textureScale),
    ).level(float(0));
    if (this.interpolation === VolumeInterpolation.Nearest) {
      const texel = floor(uv.mul(resolution)).clamp(vec3(0), resolution.sub(1));
      return sampleAt(texel.add(0.5).div(resolution));
    }
    if (this.interpolation !== VolumeInterpolation.Cubic) return sampleAt(uv);
    // Group cubic B-spline weights into eight hardware-linear texture reads.
    const p = uv.mul(resolution).sub(0.5);
    const f = p.sub(floor(p));
    const w0 = pow(vec3(1).sub(f), vec3(3)).div(6);
    const w1 = f.mul(f).mul(f).mul(3).sub(f.mul(f).mul(6)).add(4).div(6);
    const w2 = f.mul(f).mul(f).mul(-3).add(f.mul(f).mul(3)).add(f.mul(3)).add(1).div(6);
    const w3 = f.mul(f).mul(f).div(6);
    const g0 = w0.add(w1);
    const g1 = w2.add(w3);
    const a = floor(p).sub(0.5).add(w1.div(g0)).div(resolution);
    const b = floor(p).add(1.5).add(w3.div(g1)).div(resolution);
    const sample = (x: Node<'float'>, y: Node<'float'>, z: Node<'float'>) =>
      sampleAt(vec3(x, y, z));
    return mix(
      mix(
        mix(sample(a.x, a.y, a.z), sample(b.x, a.y, a.z), g1.x),
        mix(sample(a.x, b.y, a.z), sample(b.x, b.y, a.z), g1.x),
        g1.y,
      ),
      mix(
        mix(sample(a.x, a.y, b.z), sample(b.x, a.y, b.z), g1.x),
        mix(sample(a.x, b.y, b.z), sample(b.x, b.y, b.z), g1.x),
        g1.y,
      ),
      g1.z,
    );
  }
}

export default VolumeRenderer;
