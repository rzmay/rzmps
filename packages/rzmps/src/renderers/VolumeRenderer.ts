import * as THREE from 'three';
import { MeshBasicNodeMaterial, WebGPURenderer } from 'three/webgpu';
import {
  float,
  max,
  positionGeometry,
  smoothstep,
  texture3D,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import Renderer, { type RendererOptions } from '../Renderer';
import Particle from '../Particle';
import ParticleSystem from '../ParticleSystem';
import GasSimulation from '../modules/GasSimulation';
import type { VolumeField } from '../interfaces/VolumeField';

export interface VolumeRendererOptions extends RendererOptions {
  field?: VolumeField | (() => VolumeField | undefined);
  colorField?: VolumeField | (() => VolumeField | undefined);
  baseColor: THREE.ColorRepresentation;
  opacity: number;
  threshold: number;
  range: number;
  steps: number;
  renderOrder: number;
  jitter: boolean;
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
  jitter: boolean;

  private texture?: THREE.Data3DTexture;
  private colorTexture?: THREE.Data3DTexture;
  private fieldVersion = -1;
  private colorFieldVersion = -1;
  private fieldResolution = new THREE.Vector3(-1, -1, -1);
  private colorFieldResolution = new THREE.Vector3(-1, -1, -1);
  private frame = 0;
  private geometry = new THREE.BoxGeometry(1, 1, 1);
  private webglMaterial: THREE.RawShaderMaterial;
  private webgpuMaterial: THREE.Material;
  private mesh: THREE.Mesh;
  private bounds = new THREE.Box3();
  private boundsCenter = new THREE.Vector3();
  private boundsSize = new THREE.Vector3();

  constructor(options: Partial<VolumeRendererOptions> = {}) {
    super(options);

    this.field = options.field;
    this.colorField = options.colorField;
    this.baseColor = new THREE.Color(options.baseColor ?? this.baseColor);
    this.opacity = options.opacity ?? 0.25;
    this.threshold = options.threshold ?? 0.25;
    this.range = options.range ?? 0.1;
    this.steps = options.steps ?? 100;
    this.renderOrder = options.renderOrder ?? 2;
    this.jitter = options.jitter ?? false;

    this.webglMaterial = this.createWebGLMaterial();
    this.webgpuMaterial = this.createWebGPUMaterial();
    this.mesh = new THREE.Mesh(this.geometry, this.webglMaterial);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = this.renderOrder;
  }

  setup(system: ParticleSystem): void {
    this.mesh.onBeforeRender = (renderer) => {
      this.setActiveMaterial(renderer);
      this.frame += 1;
      this.webglMaterial.uniforms.frame.value = this.frame;
    };

    const field = this.resolveField(system);
    const colorField = this.resolveColorField(system);

    if (!field) {
      this.mesh.visible = false;
      system.addRendererObject(this.mesh);
      return;
    }

    this.texture = this.createTexture(field, 1);
    this.fieldVersion = field.version;
    this.fieldResolution.copy(field.resolution);
    if (colorField) {
      this.colorTexture = this.createTexture(colorField, colorField.channels ?? 4);
      this.colorFieldVersion = colorField.version;
      this.colorFieldResolution.copy(colorField.resolution);
    }
    this.updateMaterialTexture();
    this.updateBounds(field);
    this.setActiveMaterial(system.sceneRenderer);

    system.addRendererObject(this.mesh);
  }

  protected _update(_particles: Particle[], system: ParticleSystem): void {
    const field = this.resolveField(system);
    const colorField = this.resolveColorField(system);

    this.setActiveMaterial(system.sceneRenderer);

    if (!field) {
      this.mesh.visible = false;
      return;
    }

    if (!this.texture || !this.fieldResolution.equals(field.resolution)) {
      this.texture?.dispose();
      this.texture = this.createTexture(field, 1);
      this.fieldResolution.copy(field.resolution);
      this.fieldVersion = field.version;
      this.updateMaterialTexture();
    } else if (field.version !== this.fieldVersion) {
      this.texture.image.data = field.data;
      this.texture.needsUpdate = true;
      this.fieldVersion = field.version;
    }

    if (colorField) {
      if (!this.colorTexture || !this.colorFieldResolution.equals(colorField.resolution)) {
        this.colorTexture?.dispose();
        this.colorTexture = this.createTexture(colorField, colorField.channels ?? 4);
        this.colorFieldResolution.copy(colorField.resolution);
        this.colorFieldVersion = colorField.version;
        this.updateMaterialTexture();
      } else if (colorField.version !== this.colorFieldVersion) {
        this.colorTexture.image.data = colorField.data;
        this.colorTexture.needsUpdate = true;
        this.colorFieldVersion = colorField.version;
      }
    } else if (this.colorTexture) {
      this.colorTexture.dispose();
      this.colorTexture = undefined;
      this.colorFieldVersion = -1;
      this.colorFieldResolution.set(-1, -1, -1);
      this.updateMaterialTexture();
    }

    if (!this.bounds.equals(field.bounds)) this.updateBounds(field);

    this.webglMaterial.uniforms.base.value.copy(this.baseColor);
    this.webglMaterial.uniforms.opacity.value = this.opacity;
    this.webglMaterial.uniforms.threshold.value = this.threshold;
    this.webglMaterial.uniforms.range.value = this.range;
    this.webglMaterial.uniforms.steps.value = this.steps;
    this.webglMaterial.uniforms.jitter.value = this.jitter;
    this.mesh.renderOrder = this.renderOrder;
  }

  destroy(): void {
    this.texture?.dispose();
    this.colorTexture?.dispose();
    this.geometry.dispose();
    this.webglMaterial.dispose();
    this.webgpuMaterial.dispose();
    this.mesh.removeFromParent();
  }

  clear(): void {
    this.mesh.visible = false;
  }

  private resolveField(system?: ParticleSystem): VolumeField | undefined {
    if (this.field) {
      return typeof this.field === 'function'
        ? this.field()
        : this.field;
    }

    return this.resolveGasSimulation(system)?.density;
  }

  private resolveColorField(system?: ParticleSystem): VolumeField | undefined {
    if (this.colorField) {
      return typeof this.colorField === 'function'
        ? this.colorField()
        : this.colorField;
    }

    return this.resolveGasSimulation(system)?.colorField;
  }

  private resolveGasSimulation(system?: ParticleSystem): GasSimulation | undefined {
    return system?.modules
      .flatMap((module) => module.withDependents())
      .find((module): module is GasSimulation => module instanceof GasSimulation);
  }

  private createTexture(field: VolumeField, channels: 1 | 3 | 4): THREE.Data3DTexture {
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
    this.webglMaterial.uniforms.map.value = this.texture;
    this.webglMaterial.uniforms.colorMap.value = this.colorTexture;
    this.webglMaterial.uniforms.useColorMap.value = Boolean(this.colorTexture);

    this.webgpuMaterial.dispose();
    this.webgpuMaterial = this.createWebGPUMaterial();
  }

  private updateBounds(field: VolumeField): void {
    this.bounds.copy(field.bounds);
    this.bounds.getCenter(this.boundsCenter);
    this.bounds.getSize(this.boundsSize);
    this.mesh.position.copy(this.boundsCenter);
    this.mesh.scale.copy(this.boundsSize);
    this.mesh.visible = !this.bounds.isEmpty();
  }

  private setActiveMaterial(renderer?: THREE.WebGLRenderer | WebGPURenderer): void {
    this.mesh.material = renderer instanceof WebGPURenderer
      ? this.webgpuMaterial
      : this.webglMaterial;
  }

  private createWebGLMaterial(): THREE.RawShaderMaterial {
    return new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      side: THREE.BackSide,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      uniforms: {
        map: { value: null },
        colorMap: { value: null },
        useColorMap: { value: false },
        base: { value: this.baseColor.clone() },
        threshold: { value: this.threshold },
        range: { value: this.range },
        opacity: { value: this.opacity },
        steps: { value: this.steps },
        frame: { value: 0 },
        jitter: { value: this.jitter },
      },
      vertexShader: /* glsl */`
        precision highp float;

        in vec3 position;

        uniform mat4 modelMatrix;
        uniform mat4 modelViewMatrix;
        uniform mat4 projectionMatrix;
        uniform vec3 cameraPosition;

        out vec3 vOrigin;
        out vec3 vDirection;

        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);

          vOrigin = vec3(inverse(modelMatrix) * vec4(cameraPosition, 1.0));
          vDirection = position - vOrigin;

          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        precision highp sampler3D;

        uniform sampler3D map;
        uniform sampler3D colorMap;
        uniform bool useColorMap;
        uniform vec3 base;
        uniform float threshold;
        uniform float range;
        uniform float opacity;
        uniform float steps;
        uniform float frame;
        uniform bool jitter;

        in vec3 vOrigin;
        in vec3 vDirection;

        out vec4 outColor;

        vec2 hitBox(vec3 orig, vec3 dir) {
          const vec3 boxMin = vec3(-0.5);
          const vec3 boxMax = vec3(0.5);
          vec3 invDir = 1.0 / dir;
          vec3 tMinTemp = (boxMin - orig) * invDir;
          vec3 tMaxTemp = (boxMax - orig) * invDir;
          vec3 tMin = min(tMinTemp, tMaxTemp);
          vec3 tMax = max(tMinTemp, tMaxTemp);
          float t0 = max(max(tMin.x, tMin.y), tMin.z);
          float t1 = min(min(tMax.x, tMax.y), tMax.z);

          return vec2(t0, t1);
        }

        float random(vec3 scale, float seed) {
          return fract(sin(dot(gl_FragCoord.xyz + seed, scale)) * 43758.5453 + seed);
        }

        float sampleDensity(vec3 coord) {
          return texture(map, coord + 0.5).r;
        }

        void main() {
          vec3 rayDir = normalize(vDirection);
          vec2 bounds = hitBox(vOrigin, rayDir);

          if (bounds.x > bounds.y) discard;

          bounds.x = max(bounds.x, 0.0);

          vec3 p = vOrigin + bounds.x * rayDir;
          vec3 inc = 1.0 / abs(rayDir);
          float stepSize = min(min(inc.x, inc.y), inc.z) / steps;
          vec3 step = rayDir * stepSize;
          if (jitter) {
            p += step * random(vec3(12.9898, 78.233, 37.719), frame);
          }

          vec4 color = vec4(0.0);

          for (int i = 0; i < 512; i++) {
            if (float(i) >= steps) break;
            if (distance(p, vOrigin) > bounds.y) break;

            float d = sampleDensity(p);
            float shadeStep = 1.0 / 256.0;
            vec3 gradient = vec3(
              sampleDensity(p - vec3(shadeStep, 0.0, 0.0)) - sampleDensity(p + vec3(shadeStep, 0.0, 0.0)),
              sampleDensity(p - vec3(0.0, shadeStep, 0.0)) - sampleDensity(p + vec3(0.0, shadeStep, 0.0)),
              sampleDensity(p - vec3(0.0, 0.0, shadeStep)) - sampleDensity(p + vec3(0.0, 0.0, shadeStep))
            );
            float light = clamp(dot(normalize(gradient + 0.0001), normalize(vec3(1.0, 1.0, 1.0))) * 0.5 + 0.5, 0.35, 1.0);
            float lower = max(threshold - range, 0.000001);
            float a = d <= 0.0 ? 0.0 : smoothstep(lower, threshold + range, d) * opacity;
            vec4 fieldColor = useColorMap ? texture(colorMap, p + 0.5) : vec4(base, 1.0);
            vec3 sampleColor = mix(base, fieldColor.rgb, fieldColor.a) * light;

            color.rgb += (1.0 - color.a) * a * sampleColor;
            color.a += (1.0 - color.a) * a;

            if (color.a >= 0.95) break;

            p += step;
          }

          if (color.a <= 0.0) discard;

          outColor = color;
        }
      `,
    });
  }

  private createWebGPUMaterial(): THREE.Material {
    const material = new MeshBasicNodeMaterial({
      color: this.baseColor,
      opacity: this.opacity,
      side: THREE.BackSide,
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });

    if (this.texture) {
      const density = texture3D(this.texture).sample(positionGeometry.add(0.5)).r;
      const threshold = uniform(this.threshold);
      const range = uniform(this.range);
      const opacity = uniform(this.opacity);
      const alpha = smoothstep(
        max(threshold.sub(range), float(0.000001)),
        threshold.add(range),
        density,
      ).mul(opacity);
      const base = vec3(
        uniform(this.baseColor.r),
        uniform(this.baseColor.g),
        uniform(this.baseColor.b),
      );
      const colorSample = this.colorTexture
        ? texture3D(this.colorTexture).sample(positionGeometry.add(0.5))
        : vec4(base, float(1));
      const sampleColor = base.mul(float(1).sub(colorSample.a)).add(colorSample.rgb.mul(colorSample.a));

      material.colorNode = vec4(sampleColor.mul(float(0.85).add(density.mul(0.15))), alpha);
    }

    return material;
  }
}

export default VolumeRenderer;
