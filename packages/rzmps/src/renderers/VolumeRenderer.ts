import * as THREE from 'three';
import { MeshBasicNodeMaterial, WebGPURenderer, type Node, type UniformNode } from 'three/webgpu';
import {
  Break,
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
  ceil,
  floor,
  hash,
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
  viewportDepthTexture,
} from 'three/tsl';
import Renderer, { CompensationMode, type RendererOptions } from '../Renderer';
import Particle from '../Particle';
import ParticleSystem from '../ParticleSystem';
import type { GPUParticleBufferState, GPUParticleRenderBufferState } from '../gpu/Particle';
import type { VolumeFieldProvider } from '../interfaces/VolumeFieldProvider';
import type { VolumeField } from '../interfaces/VolumeField';
import volumeVert from '../shaders/Volume.vert';
import volumeFrag from '../shaders/Volume.frag';
import volumeLayersGLSL from '../shaders/VolumeLayers';
import volumeChildren, { volumeNumber } from '../helpers/volumeChildren';
import evaluateByParameterNumber from '../helpers/evaluateByParameterNumber';
import { VolumeInterpolation } from '../enums/VolumeInterpolation';
import { VolumeDensityMapping } from '../enums/VolumeDensityMapping';
import type { ValueByParameter } from '../types/ValueByParameter';
import { generateGPUParticleNoise4D } from '../helpers/noise';

interface FieldBinding {
  field: VolumeField;
  texture: THREE.Texture;
  owned: boolean;
  version: number;
  resolution: THREE.Vector3;
  minimum: UniformNode<'vec3', THREE.Vector3>;
  size: UniformNode<'vec3', THREE.Vector3>;
  resolutionNode: UniformNode<'vec3', THREE.Vector3>;
}

interface VolumeLayer {
  density: FieldBinding;
  color?: FieldBinding;
  offset: UniformNode<'vec3', THREE.Vector3>;
  scale: UniformNode<'float', number>;
  alpha: UniformNode<'float', number>;
}

export interface VolumeRendererOptions extends RendererOptions {
  field?: VolumeField | (() => VolumeField | undefined);
  colorField?: VolumeField | (() => VolumeField | undefined);
  baseColor: THREE.ColorRepresentation;
  /** Opacity per cell of ray travel, after density mapping. Defaults to 0.25. */
  opacity: number;
  threshold: number;
  range: number;
  /** Maximum samples per ray, clamped to 512. Defaults to 100. */
  steps: number;
  renderOrder: number;
  depthTest: boolean;
  jitter: boolean;
  /** Voxel reconstruction, independent of simulation advection. Defaults to Linear. */
  interpolation: VolumeInterpolation | `${VolumeInterpolation}`;
  /** Cell-relative ray spacing. Smaller values take more samples, up to steps. Defaults to one. */
  stepSizeMultiplier: number;
  /** Render-only density multiplier. Defaults to one. */
  densityGain: number;
  /** Defaults to Smoothstep, which uses threshold/range. */
  densityMapping: VolumeDensityMapping | `${VolumeDensityMapping}`;
  /** Density interval mapped to zero through one in Linear/Curve modes. Defaults to [0, 1]. */
  densityRange: [number, number];
  /** Opacity curve on normalized density. Uses the existing ValueByParameter convention. */
  densityCurve: ValueByParameter<number>;
  /** Exponent applied to the contrast-adjusted density mask. Zero disables masking. WebGPU only. */
  noiseStrength: number;
  /** Contrast around noise value 0.5, applied before the strength exponent. Defaults to one. */
  noiseContrast: number;
  /** Noise frequency in simulation units, independent of field resolution. */
  noiseFrequency: number;
  /** Animation speed along the noise helper's fourth dimension. */
  noiseSpeed: number;
  /** Fractal detail layers per ray sample. Defaults to one. */
  noiseOctaves: number;
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
}

class VolumeRenderer extends Renderer {
  field?: VolumeField | (() => VolumeField | undefined);
  colorField?: VolumeField | (() => VolumeField | undefined);
  baseColor = new THREE.Color(0x798aa0);
  opacity: number;
  threshold: number;
  range: number;
  steps: number;
  renderOrder: number;
  depthTest: boolean;
  jitter: boolean;
  interpolation: VolumeRendererOptions['interpolation'];
  stepSizeMultiplier: number;
  densityGain: number;
  densityMapping: VolumeRendererOptions['densityMapping'];
  densityRange: [number, number];
  densityCurve: VolumeRendererOptions['densityCurve'];
  noiseStrength: number;
  noiseContrast: number;
  noiseFrequency: number;
  noiseSpeed: number;
  noiseOctaves: number;
  adaptiveStepping: boolean;
  adaptiveStepThreshold: number;
  adaptiveStepFactor: number;
  transmittanceThreshold: number;
  sceneDepthClipping: boolean;
  sceneDepthBias: number;
  private readonly gpuAdaptiveStepping = uniform(0);
  private readonly gpuAdaptiveStepThreshold = uniform(0.5);
  private readonly gpuAdaptiveStepFactor = uniform(4);
  private readonly gpuTransmittanceThreshold = uniform(0.01);
  private readonly gpuSceneDepthClipping = uniform(1);
  private readonly gpuSceneDepthBias = uniform(0.001);
  private readonly gpuNoiseStrength = uniform(0);
  private readonly gpuNoiseContrast = uniform(1);
  private readonly gpuNoiseFrequency = uniform(1);
  private readonly gpuNoiseTime = uniform(0);
  private noiseTime = 0;

  private bindings = new Map<VolumeField, FieldBinding>();
  private layers: VolumeLayer[] = [];
  private frame = 0;
  private geometry = new THREE.BoxGeometry(1, 1, 1);
  private webglMaterial: THREE.RawShaderMaterial;
  private webgpuMaterial: THREE.Material;
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
  private gpuMaterialSteps = 0;
  private gpuMaterialDepthTest = true;
  private readonly gpuBoundsMinimum = uniform(new THREE.Vector3());
  private readonly gpuBoundsSize = uniform(new THREE.Vector3(1, 1, 1));
  private readonly gpuCellSize = uniform(1);
  private readonly gpuReferenceCellSize = uniform(1);
  private readonly gpuStepSize = uniform(1);
  private readonly gpuDensityGain = uniform(1);
  private readonly gpuDensityRange = uniform(new THREE.Vector2(0, 1));
  private readonly gpuFrame = uniform(0);
  private readonly gpuJitter = uniform(0);
  private materialSamplingKey = '';
  private readonly curveData = new Uint16Array(256 * 4);
  private readonly curveTexture = new THREE.DataTexture(this.curveData, 256, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  private volumeChildCount = 0;
  private readonly fieldIds = new WeakMap<VolumeField, number>();
  private nextFieldId = 0;

  protected override get usesParticleChildren(): boolean { return false; }

  /** Number of additional field copies, not additional simulated particles. */
  override get renderedChildCount(): number { return this.volumeChildCount; }

  constructor(options: Partial<VolumeRendererOptions> = {}) {
    super(options);

    this.field = options.field;
    this.colorField = options.colorField;
    this.baseColor = new THREE.Color(options.baseColor ?? this.baseColor);
    this.opacity = options.opacity ?? 0.25;
    this.threshold = options.threshold ?? 0.25;
    this.range = options.range ?? 0.1;
    this.steps = options.steps ?? 100;
    this.renderOrder = options.renderOrder ?? 100;
    this.depthTest = options.depthTest ?? true;
    this.jitter = options.jitter ?? false;
    this.interpolation = options.interpolation ?? VolumeInterpolation.Linear;
    this.stepSizeMultiplier = options.stepSizeMultiplier ?? 1;
    this.densityGain = options.densityGain ?? 1;
    this.densityMapping = options.densityMapping ?? VolumeDensityMapping.Smoothstep;
    this.densityRange = [...(options.densityRange ?? [0, 1])];
    this.densityCurve = options.densityCurve ?? ((t: number) => t);
    this.noiseStrength = options.noiseStrength ?? 0;
    this.noiseContrast = options.noiseContrast ?? 1;
    this.noiseFrequency = options.noiseFrequency ?? 3;
    this.noiseSpeed = options.noiseSpeed ?? 0.2;
    this.noiseOctaves = options.noiseOctaves ?? 1;
    this.adaptiveStepping = options.adaptiveStepping ?? false;
    this.adaptiveStepThreshold = options.adaptiveStepThreshold ?? 0.5;
    this.adaptiveStepFactor = options.adaptiveStepFactor ?? 4;
    this.transmittanceThreshold = options.transmittanceThreshold ?? 0.01;
    this.sceneDepthClipping = options.sceneDepthClipping ?? true;
    this.sceneDepthBias = options.sceneDepthBias ?? 0.001;
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

  setup(system: ParticleSystem): void {
    this.mesh.onBeforeRender = (renderer, _scene, camera) => {
      this.setActiveMaterial(renderer);
      this.updateMaterialSide(camera);
      this.frame += 1;
      this.gpuFrame.value = this.frame;
      this.webglMaterial.uniforms.frame.value = this.frame;
    };

    this._update([], system);
    system.addRendererObject(this.mesh);
  }

  protected _update(particles: Particle[], system: ParticleSystem, deltaTime = 0): void {
    void particles;
    this.noiseTime += deltaTime * this.noiseSpeed;
    this.gpuNoiseTime.value = this.noiseTime;
    this.validateOptions();
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
      for (const copy of copies) {
        const index = next.length;
        const old = previous[index];
        const layer = old?.density === density && old.color === color ? old : {
          density, color, offset: uniform(new THREE.Vector3()), scale: uniform(1), alpha: uniform(1),
        };
        layer.offset.value.copy(copy.offset);
        layer.scale.value = copy.scale * (this.compensation === CompensationMode.Size
          ? 1 / Math.sqrt(system.quality) : 1);
        layer.alpha.value = copy.alpha;
        next.push(layer);
      }
    }
    this.layers = next;
    for (const [field, binding] of this.bindings) {
      if (active.has(field)) continue;
      if (binding.owned) binding.texture.dispose();
      this.bindings.delete(field);
    }
    const changed = previous.length !== this.layers.length || this.layers.some((layer, index) => (
      layer.density !== previous[index]?.density || layer.color !== previous[index]?.color
    ));
    this.updateBounds();
    const samplingKey = `${this.interpolation}:${this.densityMapping}:${this.noiseStrength > 0}:${this.noiseOctaves}`;
    if (changed || this.steps !== this.gpuMaterialSteps || this.depthTest !== this.gpuMaterialDepthTest
      || this.materialSamplingKey !== samplingKey) {
      this.materialSamplingKey = samplingKey;
      this.updateMaterialTexture();
    }

    this.webglMaterial.uniforms.base.value.copy(this.baseColor);
    this.webglMaterial.uniforms.opacity.value = this.opacity;
    this.webglMaterial.uniforms.threshold.value = this.threshold;
    this.webglMaterial.uniforms.range.value = this.range;
    this.webglMaterial.uniforms.steps.value = this.steps;
    this.webglMaterial.uniforms.jitter.value = this.jitter;
    this.webglMaterial.uniforms.cellSize.value = this.gpuCellSize.value;
    this.webglMaterial.uniforms.referenceCellSize.value = this.gpuReferenceCellSize.value;
    this.webglMaterial.uniforms.stepSizeMultiplier.value = this.stepSizeMultiplier;
    this.webglMaterial.uniforms.densityGain.value = this.densityGain;
    this.webglMaterial.uniforms.densityRange.value.set(...this.densityRange);
    for (const key of ['adaptiveStepping', 'adaptiveStepThreshold', 'adaptiveStepFactor',
      'transmittanceThreshold'] as const) this.webglMaterial.uniforms[key].value = this[key];
    this.updateDensityCurve();
    this.syncGPUUniforms();
    this.mesh.renderOrder = this.renderOrder;
    this.webglMaterial.depthTest = this.depthTest;
    this.webgpuMaterial.depthTest = this.depthTest;
    this.setActiveMaterial(system.sceneRenderer);
  }

  private syncGPUUniforms(): void {
    this.gpuThreshold.value = this.threshold;
    this.gpuRange.value = this.range;
    this.gpuOpacity.value = this.opacity;
    this.gpuBaseR.value = this.baseColor.r;
    this.gpuBaseG.value = this.baseColor.g;
    this.gpuBaseB.value = this.baseColor.b;
    this.gpuStepSize.value = this.stepSizeMultiplier;
    this.gpuDensityGain.value = this.densityGain;
    this.gpuDensityRange.value.set(...this.densityRange);
    this.gpuJitter.value = this.jitter ? 1 : 0;
    this.gpuNoiseStrength.value = this.noiseStrength;
    this.gpuNoiseContrast.value = this.noiseContrast;
    this.gpuNoiseFrequency.value = this.noiseFrequency;
    this.gpuAdaptiveStepping.value = this.adaptiveStepping ? 1 : 0;
    this.gpuAdaptiveStepThreshold.value = this.adaptiveStepThreshold;
    this.gpuAdaptiveStepFactor.value = this.adaptiveStepFactor;
    this.gpuTransmittanceThreshold.value = this.transmittanceThreshold;
    this.gpuSceneDepthClipping.value = this.sceneDepthClipping ? 1 : 0;
    this.gpuSceneDepthBias.value = this.sceneDepthBias;
  }

  private layersSourceId(field: VolumeField): number {
    let id = this.fieldIds.get(field);
    if (id === undefined) { id = this.nextFieldId++; this.fieldIds.set(field, id); }
    return id;
  }

  private validateOptions(): void {
    if (!Number.isFinite(this.adaptiveStepThreshold) || this.adaptiveStepThreshold < 0
      || this.adaptiveStepThreshold >= 1 || !Number.isFinite(this.adaptiveStepFactor) || this.adaptiveStepFactor < 1
      || !Number.isFinite(this.transmittanceThreshold) || this.transmittanceThreshold < 0
      || this.transmittanceThreshold >= 1 || !Number.isFinite(this.sceneDepthBias) || this.sceneDepthBias < 0) {
      throw new RangeError('Volume adaptive thresholds must be in [0, 1), step factor >= 1, and depth bias >= 0.');
    }
    if (!Number.isFinite(this.noiseStrength) || this.noiseStrength < 0
      || !Number.isFinite(this.noiseContrast) || this.noiseContrast < 0
      || !Number.isFinite(this.noiseFrequency) || this.noiseFrequency < 0 || !Number.isFinite(this.noiseSpeed)
      || !Number.isInteger(this.noiseOctaves) || this.noiseOctaves < 1 || this.noiseOctaves > 4) {
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
    if (!this.densityRange.every(Number.isFinite) || this.densityRange[1] <= this.densityRange[0]) {
      throw new RangeError('Volume densityRange must be finite and increasing.');
    }
    if (!Number.isFinite(this.steps) || this.steps < 1) throw new RangeError('Volume steps must be at least one.');
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
    for (const binding of this.bindings.values()) {
      if (binding.owned) binding.texture.dispose();
    }
    this.bindings.clear();
    this.layers = [];
    this.geometry.dispose();
    this.webglMaterial.dispose();
    this.webgpuMaterial.dispose();
    this.curveTexture.dispose();
    this.mesh.removeFromParent();
  }

  clear(): void {
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
    if (!binding || !binding.resolution.equals(field.resolution) || field.texture !== (
      binding.owned ? undefined : binding.texture
    )) {
      if (binding?.owned) binding.texture.dispose();
      binding = {
        field,
        texture: field.texture ?? this.createTexture(field, channels),
        owned: !field.texture,
        version: field.version,
        resolution: field.resolution.clone(),
        minimum: uniform(field.bounds.min.clone()),
        size: uniform(field.bounds.getSize(new THREE.Vector3())),
        resolutionNode: uniform(field.resolution.clone()),
      };
      this.bindings.set(field, binding);
    } else if (binding.owned && binding.version !== field.version) {
      if (!field.data) throw new Error('VolumeField.data is required for CPU volume textures.');
      (binding.texture as THREE.Data3DTexture).image.data = field.data;
      binding.texture.needsUpdate = true;
      binding.version = field.version;
    }
    binding.minimum.value.copy(field.bounds.min);
    field.bounds.getSize(binding.size.value).clampScalar(Number.EPSILON, Infinity);
    return binding;
  }

  private createTexture(field: VolumeField, channels: 1 | 3 | 4): THREE.Data3DTexture {
    if (!field.data) throw new Error('VolumeField.data is required when no GPU texture is supplied.');
    const texture = new THREE.Data3DTexture(
      field.data,
      field.resolution.x,
      field.resolution.y,
      field.resolution.z,
    );

    texture.format = channels === 4
      ? THREE.RGBAFormat
      : channels === 3
        ? THREE.RGBFormat
        : THREE.RedFormat;
    texture.type = field.data instanceof Float32Array
      ? THREE.FloatType
      : THREE.UnsignedByteType;
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
    const sources: VolumeLayer[] = [];
    const sourceIndices = this.layers.map(layer => {
      let index = sources.findIndex(source => source.density === layer.density && source.color === layer.color);
      if (index < 0) { index = sources.length; sources.push(layer); }
      return index;
    });
    sources.forEach((layer, index) => {
      for (const [name, binding] of [['Density', layer.density], ['Color', layer.color]] as const) {
        if (!binding) continue;
        uniforms[`layer${name}Map${index}`] = { value: binding.texture };
        uniforms[`layer${name}Min${index}`] = { value: binding.minimum.value };
        uniforms[`layer${name}Size${index}`] = { value: binding.size.value };
        uniforms[`layer${name}Resolution${index}`] = { value: binding.resolution };
      }
    });
    this.layers.forEach((layer, index) => {
      uniforms[`layerOffset${index}`] = { value: layer.offset.value };
      uniforms[`layerScale${index}`] = layer.scale;
      uniforms[`layerAlpha${index}`] = layer.alpha;
    });
    this.webglMaterial.fragmentShader = volumeFrag.replace(
      '/* VOLUME_FIELDS */', volumeLayersGLSL(
        sources.map(layer => Boolean(layer.color)), sourceIndices, this.interpolation, this.densityMapping,
      ),
    );
    this.webglMaterial.needsUpdate = true;

    this.webgpuMaterial.dispose();
    this.webgpuMaterial = this.createWebGPUMaterial();
  }

  private updateBounds(): void {
    this.bounds.makeEmpty();
    let cellSize = Infinity;
    let referenceCellSize = Infinity;
    for (const layer of this.layers) {
      const field = layer.density.field;
      const center = field.bounds.getCenter(new THREE.Vector3()).add(layer.offset.value);
      const size = field.bounds.getSize(new THREE.Vector3()).multiplyScalar(layer.scale.value);
      this.bounds.union(new THREE.Box3().setFromCenterAndSize(center, size));
      const cell = size.divide(field.resolution);
      cellSize = Math.min(cellSize, cell.x, cell.y, cell.z);
      referenceCellSize = Math.min(referenceCellSize,
        cell.x / layer.scale.value, cell.y / layer.scale.value, cell.z / layer.scale.value);
    }
    this.gpuCellSize.value = Math.max(1e-6, Number.isFinite(cellSize) ? cellSize : 1);
    this.gpuReferenceCellSize.value = Math.max(1e-6, Number.isFinite(referenceCellSize) ? referenceCellSize : 1);
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
    if (renderer && !(renderer instanceof WebGPURenderer) && this.noiseStrength > 0) {
      throw new Error('Procedural volume density masks require a WebGPU renderer.');
    }
    const gpuTexture = this.layers.some(layer => (
      (layer.density.texture as THREE.Texture & { isStorageTexture?: boolean }).isStorageTexture
    ));
    this.mesh.material = (renderer instanceof WebGPURenderer || (!renderer && gpuTexture))
      ? this.webgpuMaterial
      : this.webglMaterial;
  }

  private updateMaterialSide(camera: THREE.Camera): void {
    camera.getWorldPosition(this.cameraWorldPosition);
    this.cameraLocalPosition.copy(this.cameraWorldPosition);
    this.mesh.worldToLocal(this.cameraLocalPosition);
    const inside = Math.abs(this.cameraLocalPosition.x) <= 0.5
      && Math.abs(this.cameraLocalPosition.y) <= 0.5
      && Math.abs(this.cameraLocalPosition.z) <= 0.5;
    const side = inside ? THREE.BackSide : THREE.FrontSide;
    [this.webglMaterial, this.webgpuMaterial].forEach((material) => {
      if (material.side === side) return;
      material.side = side;
      material.needsUpdate = true;
    });
  }

  private createWebGLMaterial(): THREE.RawShaderMaterial {
    return new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      side: THREE.FrontSide,
      transparent: true,
      depthTest: this.depthTest,
      depthWrite: false,
      uniforms: {
        boundsMinimum: { value: this.gpuBoundsMinimum.value },
        boundsSize: { value: this.gpuBoundsSize.value },
        base: { value: this.baseColor.clone() },
        threshold: { value: this.threshold },
        range: { value: this.range },
        opacity: { value: this.opacity },
        steps: { value: this.steps },
        frame: { value: 0 },
        jitter: { value: this.jitter },
        cellSize: { value: 1 },
        referenceCellSize: { value: 1 },
        stepSizeMultiplier: { value: this.stepSizeMultiplier },
        densityGain: { value: this.densityGain },
        densityRange: { value: new THREE.Vector2(...this.densityRange) },
        densityCurve: { value: this.curveTexture },
        adaptiveStepping: { value: this.adaptiveStepping },
        adaptiveStepThreshold: { value: this.adaptiveStepThreshold },
        adaptiveStepFactor: { value: this.adaptiveStepFactor },
        transmittanceThreshold: { value: this.transmittanceThreshold },
      },
      vertexShader: volumeVert,
      fragmentShader: volumeFrag.replace('/* VOLUME_FIELDS */', volumeLayersGLSL([], [], this.interpolation,
        this.densityMapping)),
    });
  }

  private createWebGPUMaterial(): THREE.Material {
    this.gpuMaterialSteps = this.steps;
    this.gpuMaterialDepthTest = this.depthTest;
    const material = new MeshBasicNodeMaterial({
      color: this.baseColor,
      opacity: this.opacity,
      side: THREE.FrontSide,
      transparent: true,
      depthTest: this.depthTest,
      depthWrite: false,
    });

    if (this.layers.length) {
      // Test entry depth rather than the proxy box's back face, including camera-inside views.
      material.depthNode = Fn(() => {
        const { origin, direction } = this.volumeRay();
        const inverseDirection = vec3(1).div(direction);
        const nearPlanes = min(
          vec3(-0.5).sub(origin).mul(inverseDirection),
          vec3(0.5).sub(origin).mul(inverseDirection),
        );
        const entry = origin.add(direction.mul(max(max(max(nearPlanes.x, nearPlanes.y), nearPlanes.z), 0)));
        const view = cameraViewMatrix.mul(modelWorldMatrix.mul(vec4(entry, 1)));
        const clip = cameraProjectionMatrix.mul(vec4(view.xy, min(view.z, cameraNear.negate()), 1));
        return clip.z.div(clip.w).clamp(0, 1);
      })();
      material.fragmentNode = Fn(() => {
        const { origin, direction } = this.volumeRay();
        const inverseDirection = vec3(1).div(direction);
        const entry = vec3(-0.5).sub(origin).mul(inverseDirection);
        const exit = vec3(0.5).sub(origin).mul(inverseDirection);
        const minimum = min(entry, exit);
        const maximum = max(entry, exit);
        const near = max(max(minimum.x, minimum.y), minimum.z);
        const far = min(min(maximum.x, maximum.y), maximum.z).toVar('volumeExit');
        const viewOrigin = cameraViewMatrix.mul(modelWorldMatrix.mul(vec4(origin, 1))).xyz.toVar('volumeViewOrigin');
        const viewDirection = cameraViewMatrix.mul(modelWorldMatrix.mul(vec4(direction, 0))).xyz
          .toVar('volumeViewDirection');
        const start = max(max(near, float(0)), cameraNear.negate().sub(viewOrigin.z).div(viewDirection.z))
          .toVar('volumeStart');
        If(start.greaterThanEqual(far), () => Discard());
        const metric = direction.mul(this.gpuBoundsSize).length().toVar('volumeMetric');
        const worldLength = metric.mul(far.sub(start));
        const count = ceil(worldLength.div(this.gpuCellSize.mul(this.gpuStepSize)))
          .clamp(1, Math.min(512, Math.floor(this.steps))).toVar('volumeCount');
        // Preserve the original sampling spacing when geometry shortens the interval.
        const baseStep = far.sub(start).div(count).toVar('volumeBaseStep');
        const rawDepth = this.depthTest ? viewportDepthTexture().toVar('volumeSceneDepth') : float(1);
        const orthographic = cameraProjectionMatrix.mul(vec4(0, 0, 0, 1)).w.equal(1);
        const sceneZ = orthographic.select(orthographicDepthToViewZ(rawDepth, cameraNear, cameraFar),
          perspectiveDepthToViewZ(rawDepth, cameraNear, cameraFar)).toVar('volumeSceneZ');
        if (this.depthTest) {
          If(this.gpuSceneDepthClipping.greaterThan(0), () => {
            If(viewDirection.z.lessThan(-1e-8), () => {
              far.assign(min(far, sceneZ.add(this.gpuSceneDepthBias).sub(viewOrigin.z).div(viewDirection.z)));
            });
          });
        }
        If(start.greaterThanEqual(far), () => Discard());
        const distance = start.toVar('volumeDistance');
        const sampleOffset = mix(float(0.5), hash(positionGeometry.dot(vec3(12.9898, 78.233, 37.719))
          .add(this.gpuFrame)), this.gpuJitter);
        const accumulated = vec4(0).toVar('volumeAccumulated');
        Loop({ start: 0, end: Math.max(1, Math.min(512, Math.floor(this.steps))), type: 'int' }, () => {
          If(distance.greaterThanEqual(far), () => Break());
          const growth = mix(float(1), this.gpuAdaptiveStepFactor,
            smoothstep(this.gpuAdaptiveStepThreshold, float(1), accumulated.a).mul(this.gpuAdaptiveStepping));
          const segment = min(baseStep.mul(growth), far.sub(distance)).toVar('volumeSegment');
          const position = origin.add(direction.mul(distance.add(segment.mul(sampleOffset))));
          if (this.depthTest) {
            If(this.gpuSceneDepthClipping.lessThan(1), () => {
              const viewZ = viewOrigin.z.add(viewDirection.z.mul(distance.add(segment.mul(sampleOffset))));
              If(viewZ.lessThanEqual(sceneZ.add(this.gpuSceneDepthBias)), () => Break());
            });
          }
          const sample = this.sampleVolume(position);
          let density = sample.a;
          if (this.noiseStrength > 0) {
            const masked = density.toVar('maskedVolumeDensity');
            If(density.greaterThan(0), () => {
              const point = position.add(0.5).mul(this.gpuBoundsSize).add(this.gpuBoundsMinimum);
              const noise = generateGPUParticleNoise4D(point.mul(this.gpuNoiseFrequency), {
                frequency: 1, octaves: this.noiseOctaves, lacunarity: 2, persistence: 0.5,
                time: 0, offset: new THREE.Vector3(),
              }, this.gpuNoiseTime);
              const mask = noise.sub(0.5).mul(this.gpuNoiseContrast).add(0.5).clamp(0, 1);
              masked.mulAssign(pow(mask, this.gpuNoiseStrength));
            });
            density = masked;
          }
          const alpha = float(1).sub(pow(float(1).sub(this.renderOpacity(density)),
            metric.mul(segment).div(this.gpuReferenceCellSize)));
          const color = sample.rgb.div(max(sample.a, 1e-6));
          const contribution = float(1).sub(accumulated.a).mul(alpha);
          accumulated.rgb.addAssign(color.mul(contribution));
          accumulated.a.addAssign(contribution);
          If(float(1).sub(accumulated.a).lessThanEqual(this.gpuTransmittanceThreshold), () => Break());
          distance.addAssign(segment);
        });
        If(accumulated.a.lessThanEqual(0), () => Discard());
        return vec4(accumulated.rgb.div(max(accumulated.a, 1e-6)), accumulated.a);
      })();
    }

    return material;
  }

  private volumeRay(): { origin: Node<'vec3'>; direction: Node<'vec3'> } {
    const surfaceView = cameraViewMatrix.mul(modelWorldMatrix.mul(vec4(positionGeometry, 1)));
    const orthographicOrigin = cameraWorldMatrix.mul(vec4(surfaceView.xy, 0, 1)).xyz;
    const orthographic = cameraProjectionMatrix.mul(vec4(0, 0, 0, 1)).w.equal(1);
    const cameraOrigin = orthographic.select(orthographicOrigin, cameraPosition);
    const origin = modelWorldMatrixInverse.mul(vec4(cameraOrigin, 1)).xyz;
    return { origin, direction: positionGeometry.sub(origin).normalize() };
  }

  private sampleVolume(position: Node<'vec3'>): Node<'vec4'> {
    const point = position.add(0.5).mul(this.gpuBoundsSize).add(this.gpuBoundsMinimum);
    const result = vec4(0).toVar('volumeSample');
    const base = vec3(this.gpuBaseR, this.gpuBaseG, this.gpuBaseB);
    for (const layer of this.layers) {
      const center = layer.density.minimum.add(layer.density.size.mul(0.5));
      const sourcePoint = point.sub(center).sub(layer.offset).div(layer.scale).add(center);
      const uv = sourcePoint.sub(layer.density.minimum).div(layer.density.size);
      If(uv.greaterThanEqual(0).all().and(uv.lessThanEqual(1).all()), () => {
        const density = max(this.readVolume(layer.density, uv).r, float(0)).mul(layer.alpha);
        const color = vec3(base).toVar();
        if (layer.color) {
          const colorUV = sourcePoint.sub(layer.color.minimum).div(layer.color.size);
          If(colorUV.greaterThanEqual(0).all().and(colorUV.lessThanEqual(1).all()), () => {
            const sample = this.readVolume(layer.color!, colorUV);
            color.assign(mix(base, sample.rgb, sample.a));
          });
        }
        result.addAssign(vec4(color.mul(density), density));
      });
    }
    return result;
  }

  private renderOpacity(rawDensity: Node<'float'>): Node<'float'> {
    if (this.densityMapping === VolumeDensityMapping.None) return float(0);
    const density = max(rawDensity.mul(this.gpuDensityGain), 0);
    const normalized = density.sub(this.gpuDensityRange.x)
      .div(this.gpuDensityRange.y.sub(this.gpuDensityRange.x)).clamp(0, 1);
    let mapped = smoothstep(max(this.gpuThreshold.sub(this.gpuRange), 1e-6),
      this.gpuThreshold.add(this.gpuRange), density);
    if (this.densityMapping === VolumeDensityMapping.Linear) mapped = normalized;
    if (this.densityMapping === VolumeDensityMapping.Curve) {
      mapped = texture(this.curveTexture).sample(vec2(normalized.mul(255).add(0.5).div(256), 0.5)).r;
    }
    return density.greaterThan(0).select(mapped.mul(this.gpuOpacity).clamp(0, 1), float(0));
  }

  private readVolume(binding: FieldBinding, uv: Node<'vec3'>): Node<'vec4'> {
    const resolution = binding.resolutionNode;
    if (this.interpolation === VolumeInterpolation.Nearest) {
      const texel = floor(uv.mul(resolution)).clamp(vec3(0), resolution.sub(1));
      return texture3D(binding.texture).sample(texel.add(0.5).div(resolution));
    }
    if (this.interpolation !== VolumeInterpolation.Cubic) return texture3D(binding.texture).sample(uv);
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
    const sample = (x: Node<'float'>, y: Node<'float'>, z: Node<'float'>) => (
      texture3D(binding.texture).sample(vec3(x, y, z))
    );
    return mix(
      mix(mix(sample(a.x, a.y, a.z), sample(b.x, a.y, a.z), g1.x),
        mix(sample(a.x, b.y, a.z), sample(b.x, b.y, a.z), g1.x), g1.y),
      mix(mix(sample(a.x, a.y, b.z), sample(b.x, a.y, b.z), g1.x),
        mix(sample(a.x, b.y, b.z), sample(b.x, b.y, b.z), g1.x), g1.y), g1.z,
    );
  }
}

export default VolumeRenderer;
