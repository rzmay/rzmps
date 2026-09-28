import * as THREE from 'three';
import type { Node } from 'three/webgpu';
import Renderer, { type RendererOptions } from '../Renderer';
import Particle from '../Particle';
import ParticleSystem from '../ParticleSystem';
import defaultTex from '../assets/textures/default.png';
import UnlitSprite, { type UnlitSpriteOptions } from '../materials/UnlitSprite';
import LitSprite, { type LitSpriteOptions } from '../materials/LitSprite';
import WebGPUUnlitSprite from '../materials/WebGPUUnlitSprite';
import WebGPULitSprite from '../materials/WebGPULitSprite';
import unlitSpriteQuadVert from '../shaders/UnlitSpriteQuad.vert';
import litSpriteQuadVert from '../shaders/LitSpriteQuad.vert';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';
import seedrandom from 'seedrandom';
import { SpriteMaterialType } from '../enums/SpriteMaterialType';
import { TRAIL_RENDERER_USER_DATA_KEY } from './TrailRenderer';
import LiveCubemap from './LiveCubemap';
import { MeshBasicNodeMaterial, WebGPURenderer } from 'three/webgpu';
import { cos, positionLocal, sin, vec3 } from 'three/tsl';
import type { GPUParticleBufferState } from '../GPUParticle';

export const SCENE_COLOR_DATA_USER_DATA_KEY = "__rzmps_sceneColorData";

type SceneDepthData = {
  target: THREE.WebGLRenderTarget;
  material: THREE.MeshDepthMaterial;
  frame: number;
  rendering: boolean;
};

type SceneColorData = {
  texture: THREE.FramebufferTexture;
  frame: number;
};

type WebGPUSceneDepthData = {
  target: THREE.RenderTarget;
  material: MeshBasicNodeMaterial;
  rendering: boolean;
};

type HiddenSpriteRenderer = {
  object: THREE.Object3D;
  visible: boolean;
};

export const SPRITE_RENDERER_USER_DATA_KEY = "__rzmps_spriteRenderer";
export const SCENE_DEPTH_DATA_USER_DATA_KEY = "__rzmps_sceneDepthData";
export const WEBGPU_SCENE_DEPTH_DATA_USER_DATA_KEY = "__rzmps_webgpuSceneDepthData";
export const WEBGPU_SCENE_DEPTH_TEXTURE = new THREE.DepthTexture(
  1,
  1,
  THREE.UnsignedIntType,
);

export interface SpriteRendererOptions extends RendererOptions {
  fps: DynamicValue<number>;
  billboard: boolean;
  sizeAttenuation: boolean;
  tileSize: {x: number, y: number};
  tileMargin: {x: number, y: number};
  gridSize: {x: number, y: number};
  frames: number;
  randomStartFrame: boolean;
  alphaMap: string | THREE.Texture;
  material: SpriteMaterialType | `${SpriteMaterialType}`;
  materialOptions: Partial<LitSpriteOptions | UnlitSpriteOptions>;
  castShadow: boolean;
  softParticleDistance: number;
}

class SpriteRenderer extends Renderer {
  texture: THREE.Texture;

  frames = 1;

  alphaMap?: THREE.Texture;

  materialType: SpriteMaterialType = SpriteMaterialType.Unlit;

  tileSize: THREE.Vector2 = new THREE.Vector2(0, 0);

  tileMargin: THREE.Vector2 = new THREE.Vector2(0, 0);

  gridSize: THREE.Vector2 = new THREE.Vector2(1, 1);

  fps: DynamicValue<number> = 1;

  billboard: boolean = true;

  sizeAttenuation: boolean = true;

  randomStartFrame: boolean = false;

  castShadow: boolean = false;

  softParticleDistance: number = 0;

  private material: THREE.ShaderMaterial;
  private quadMaterial: THREE.ShaderMaterial;
  private webgpuMaterial: THREE.Material;
  private readonly hiddenMaterial = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: false,
    transparent: true,
    opacity: 0,
  });

  private _materialOptions?: Partial<LitSpriteOptions | UnlitSpriteOptions>;
  get materialOptions(): Partial<LitSpriteOptions | UnlitSpriteOptions> { return this._materialOptions ?? {}; }
  set materialOptions(value: Partial<LitSpriteOptions | UnlitSpriteOptions> | undefined) {
    this._materialOptions = value;
    this.material = this.loadMaterial(value);
    this.quadMaterial = this.loadMaterial(value, true);
    this.points.material = this.material;
    this.webglQuadMesh.material = this.quadMaterial;
    this.webgpuMaterial = this.loadWebGPUMaterial(value);
    this.webgpuMesh.material = this.webgpuMaterial;
    this.environmentSource = undefined;
    this.updateTransmissionRenderOrder();
  }

  private environmentSource?: THREE.Texture;
  private environmentRenderer?: THREE.WebGLRenderer;
  private environmentRenderTarget?: THREE.WebGLRenderTarget;

  private readonly geometry: THREE.BufferGeometry;

  private readonly points: THREE.Points;
  private readonly webglQuadGeometry: THREE.PlaneGeometry;
  private readonly webglQuadMesh: THREE.InstancedMesh;
  private webglQuadSpriteDataAttribute: THREE.InstancedBufferAttribute;
  private readonly webgpuGeometry: THREE.PlaneGeometry;
  private readonly webgpuMesh: THREE.InstancedMesh;
  private webgpuSpriteDataAttribute: THREE.InstancedBufferAttribute;
  private webgpuCapacity = 10000;

  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly cameraQuaternion = new THREE.Quaternion();
  private readonly rollQuaternion = new THREE.Quaternion();
  private readonly rollAxis = new THREE.Vector3(0, 0, 1);
  private readonly euler = new THREE.Euler();
  private readonly scaleVector = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private readonly cameraPosition = new THREE.Vector3();
  private readonly particleWorldPosition = new THREE.Vector3();

  constructor(texture: string | THREE.Texture = defaultTex, options: Partial<SpriteRendererOptions> = {}) {
    super(options);

    const textureLoader = new THREE.TextureLoader();
    this.texture = typeof texture === 'string' ? textureLoader.load(texture, (tex) => {
      if (!options.tileSize) {
        this.tileSize = new THREE.Vector2(
          tex.image.naturalWidth / this.gridSize.x,
          tex.image.naturalHeight / this.gridSize.y,
        );
      }
    }) : texture;

    this.fps = options.fps ?? 1;
    this.billboard = options.billboard ?? this.billboard;
    this.sizeAttenuation = options.sizeAttenuation ?? true;
    this.alphaMap = typeof options.alphaMap === 'string'
      ? textureLoader.load(options.alphaMap)
      : options.alphaMap;
    this.materialType = (options.material as SpriteMaterialType) ?? this.materialType;
    this.tileSize = new THREE.Vector2(options.tileSize?.x, options.tileSize?.y);
    this.tileMargin = new THREE.Vector2(options.tileMargin?.x, options.tileMargin?.y);
    this.gridSize = new THREE.Vector2(options.gridSize?.x ?? 1, options.gridSize?.y ?? 1);
    this.castShadow = options.castShadow ?? this.castShadow;
    this.softParticleDistance = options.softParticleDistance
      ?? options.materialOptions?.softParticleDistance
      ?? 0;

    this.frames = options.frames ?? this.gridSize.x * this.gridSize.y;
    this.randomStartFrame = options.randomStartFrame ?? false;

    this.geometry = new THREE.BufferGeometry();

    // Set material options and load material
    this._materialOptions = options.materialOptions;
    this.material = this.loadMaterial(this._materialOptions);
    this.quadMaterial = this.loadMaterial(this._materialOptions, true);
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.castShadow = this.castShadow;
    this.points.visible = false;
    this.points.material = this.hiddenMaterial;

    this.webglQuadGeometry = new THREE.PlaneGeometry(1, 1);
    this.webglQuadSpriteDataAttribute =
      new THREE.InstancedBufferAttribute(new Float32Array(this.webgpuCapacity * 4), 4);
    this.webglQuadGeometry.setAttribute('instanceSpriteData', this.webglQuadSpriteDataAttribute);
    this.webglQuadMesh = new THREE.InstancedMesh(
      this.webglQuadGeometry,
      this.quadMaterial,
      this.webgpuCapacity,
    );
    this.webglQuadMesh.frustumCulled = false;
    this.webglQuadMesh.castShadow = this.castShadow;
    this.webglQuadMesh.count = 0;
    this.webglQuadMesh.visible = false;
    this.webglQuadMesh.setColorAt(0, new THREE.Color(1, 1, 1));

    this.webgpuGeometry =
      new THREE.PlaneGeometry(1, 1);
    this.webgpuSpriteDataAttribute =
      new THREE.InstancedBufferAttribute(new Float32Array(this.webgpuCapacity * 4), 4);

    this.webgpuGeometry.setAttribute('instanceSpriteData', this.webgpuSpriteDataAttribute);

    this.webgpuMaterial = this.loadWebGPUMaterial(this._materialOptions);
    this.webgpuMesh = new THREE.InstancedMesh(
      this.webgpuGeometry,
      this.webgpuMaterial,
      this.webgpuCapacity,
    );
    this.webgpuMesh.frustumCulled = false;
    this.webgpuMesh.castShadow = this.castShadow;
    this.webgpuMesh.count = 0;
    this.webgpuMesh.visible = false;
    this.webgpuMesh.setColorAt(0, new THREE.Color(1, 1, 1));

    // Add user data to the points so we can recognize it elsewhere
    this.points.userData[SPRITE_RENDERER_USER_DATA_KEY] = true;
    this.webglQuadMesh.userData[SPRITE_RENDERER_USER_DATA_KEY] = true;
    this.webgpuMesh.userData[SPRITE_RENDERER_USER_DATA_KEY] = true;
    this.updateTransmissionRenderOrder();
  }

  setup(system: ParticleSystem) {
    system.addRendererObject(this.points);
    system.addRendererObject(this.webglQuadMesh);
    system.addRendererObject(this.webgpuMesh);

    this.points.onBeforeRender = (renderer, scene, camera) => {
      this.setActiveRenderer(renderer);

      if (renderer instanceof THREE.WebGLRenderer) {
        this.prepareWebGLRender(renderer, scene, camera, system);
      }
    };

    this.webglQuadMesh.onBeforeRender = (renderer, scene, camera) => {
      this.setActiveRenderer(renderer);

      if (renderer instanceof THREE.WebGLRenderer) {
        this.prepareWebGLRender(renderer, scene, camera, system);
      }
    };

    this.webgpuMesh.onBeforeRender = (renderer) => {
      this.setActiveRenderer(renderer);
    };
  }

  _update(particles: Particle[], system: ParticleSystem): void {
    this.setActiveRenderer(system.sceneRenderer);

    // Update attributes
    if (system.sceneRenderer instanceof WebGPURenderer) {
      if (system.sceneCamera) {
        this.updateWebGPUInstances(
          particles,
          system.sceneCamera,
          system.sceneCameraQuaternion,
          this.sizeAttenuation,
          this.billboard,
        );
      }
    } else if (this.billboard) {
      this.updateAttributes(particles);
    } else {
      this.updateWebGLQuadInstances(particles, system.sceneCamera);
    }

    // Should the points cast a shadow?
    this.points.castShadow = this.castShadow;
    this.webglQuadMesh.castShadow = this.castShadow;
    this.webgpuMesh.castShadow = this.castShadow;

    // Select environment
    let environment: THREE.Texture | undefined;
    if (this._materialOptions && 'envMap' in this._materialOptions) {
      environment = this._materialOptions.envMap;
    } else if (system.useLiveCubemap) {
      environment = system.liveCubemap.map;
    } else {
      environment = system.scene?.environment ?? undefined;
    }

    const envIntensity = system.useLiveCubemap && !('envMap' in (this._materialOptions ?? {}))
      ? system.liveCubemap.intensity
      : this._materialOptions && 'envIntensity' in this._materialOptions
        ? this._materialOptions.envIntensity ?? 1
        : system.scene?.environmentIntensity ?? 1;

    if (system.sceneRenderer instanceof WebGPURenderer) {
      this.updateWebGPUEnvironmentMap(environment ?? null, envIntensity);
      this.updateWebGPUSoftParticles(
        system.sceneRenderer,
        system.scene,
        system.sceneCamera,
      );
      return;
    }

    this.setUniformValue('envIntensity', envIntensity);
    this.setUniformValue('sizeAttenuation', this.sizeAttenuation);

    // Set uniforms for soft particles
    this.setUniformValue('softParticles', Boolean(this.softParticleDistance));
    this.setUniformValue('softParticleDistance', this.softParticleDistance);

    // Get depth texture for soft particles
    if (!(system.sceneRenderer instanceof THREE.WebGLRenderer)) return;
    if (!(system.scene instanceof THREE.Scene)) return;
    if (!(system.sceneCamera instanceof THREE.Camera)) return;

    const depthTexture = this.getSceneDepth(system.sceneRenderer, system.scene, system.sceneCamera);
    const cameraNear = 'near' in system.sceneCamera ? system.sceneCamera.near : undefined;
    const cameraFar = 'far' in system.sceneCamera ? system.sceneCamera.far : undefined;
    const softParticles = this.softParticleDistance > 0
      && Boolean(depthTexture)
      && typeof cameraNear === 'number'
      && typeof cameraFar === 'number';

    if (softParticles && depthTexture) {
      this.setUniformValue('softParticles', true);
      this.setUniformValue('sceneDepthTexture', depthTexture);

      const depthResolution = this.getUniformValue<THREE.Vector2>(
        'depthResolution',
        () => new THREE.Vector2(),
      );
      system.sceneRenderer.getDrawingBufferSize(depthResolution);

      this.setUniformValue('depthCameraNear', cameraNear);
      this.setUniformValue('depthCameraFar', cameraFar);
    } else {
      this.setUniformValue('softParticles', false);
    }

    // Update environment map
    this.updateEnvironmentMap(
      system.sceneRenderer,
      environment ?? null,
      system.useLiveCubemap,
    );
  }

  private updateAttributes(particles: Particle[]) {
    this.geometry.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array(
        particles.flatMap(
          (particle: Particle) => particle.position.toArray(),
        ),
      ),
      3,
    ));

    this.geometry.setAttribute('scale', new THREE.BufferAttribute(
      new Float32Array(
        particles.flatMap(
          (particle: Particle) => particle.scale.toArray(),
        ),
      ),
      3,
    ));

    this.geometry.setAttribute('color', new THREE.BufferAttribute(
      new Float32Array(
        particles.flatMap(
          (particle: Particle) => particle.color.toArray().concat(particle.alpha),
        ),
      ),
      4,
    ));

    this.geometry.setAttribute('spriteData', new THREE.BufferAttribute(
      new Float32Array(
        particles.flatMap((particle: Particle) => [
          particle.rotation.x,
          this.getParticleFrame(particle),
          particle.distortionStrength,
        ]),
      ),
      3,
    ));
  }

  destroy(): void
  {
    this.environmentRenderTarget?.dispose();
    this.environmentRenderTarget = undefined;

    this.geometry.dispose();
    this.material.dispose();
    this.webglQuadGeometry.dispose();
    this.quadMaterial.dispose();
    this.webgpuGeometry.dispose();
    this.webgpuMaterial.dispose();
    this.hiddenMaterial.dispose();

    this.points.removeFromParent();
    this.webglQuadMesh.removeFromParent();
    this.webgpuMesh.removeFromParent();
  }

  clear(): void
  {
    this.updateAttributes([]);
    this.webglQuadMesh.count = 0;
    this.webgpuMesh.count = 0;
  }

  private loadMaterial(
    options: Partial<LitSpriteOptions | UnlitSpriteOptions> | undefined,
    quad: boolean = false,
  ) {
    const createMaterial = this.materialType === SpriteMaterialType.Lit ? LitSprite : UnlitSprite;
    const vertexShader = quad
      ? this.materialType === SpriteMaterialType.Lit
        ? litSpriteQuadVert
        : unlitSpriteQuadVert
      : undefined;
    const defines = {
      ...options?.defines,
      ...(!quad && { USE_POINT_SPRITE: '' }),
    };

    return createMaterial(this.texture, {
      ...(options ?? {}),
      defines,
      ...(vertexShader && { vertexShader }),

      frames: this.frames,
      gridSize: this.gridSize,
      alphaMap: this.alphaMap,
      softParticleDistance: this.softParticleDistance,
    });
  }

  private loadWebGPUMaterial(options: Partial<LitSpriteOptions | UnlitSpriteOptions> | undefined) {
    const createMaterial = this.materialType === SpriteMaterialType.Lit ? WebGPULitSprite : WebGPUUnlitSprite;

    return createMaterial(this.texture, {
      ...(options ?? {}),

      frames: this.frames,
      gridSize: this.gridSize,
      alphaMap: this.alphaMap,
      softParticleDistance: this.softParticleDistance,
      sceneDepthTexture: WEBGPU_SCENE_DEPTH_TEXTURE,
    });
  }

  private hasTransmission(
    options: Partial<LitSpriteOptions | UnlitSpriteOptions> | undefined,
  ): boolean {
    return this.getTransmissionAmount(options) > 0;
  }

  private getTransmissionAmount(
    options: Partial<LitSpriteOptions | UnlitSpriteOptions> | undefined,
  ): number {
    return options?.transmission ?? (options?.transmissionMap ? 1 : 0);
  }

  private updateTransmissionRenderOrder(): void {
    const renderOrder = this.hasTransmission(this._materialOptions) ? 1 : 0;

    this.points.renderOrder = renderOrder;
    this.webglQuadMesh.renderOrder = renderOrder;
    this.webgpuMesh.renderOrder = renderOrder;
  }

  private setActiveRenderer(renderer: THREE.WebGLRenderer | WebGPURenderer | undefined): void {
    const webglActive = renderer instanceof THREE.WebGLRenderer;

    this.points.visible = webglActive && this.billboard;
    this.points.material = this.points.visible ? this.material : this.hiddenMaterial;
    this.webglQuadMesh.visible = webglActive && !this.billboard;
    this.webgpuMesh.visible = renderer instanceof WebGPURenderer;
  }

  private prepareWebGLRender(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    system: ParticleSystem,
  ): void {
    this.setUniformValue('viewportHeight', this.getWebGLRenderPassHeight(renderer));

    const isSceneCamera = !system.sceneCamera || camera === system.sceneCamera;
    this.setUniformValue('softParticles', isSceneCamera && Boolean(this.softParticleDistance));
    const isLiveCubemapCamera = LiveCubemap.isLiveCubemapCamera(camera);
    this.setUniformValue(
      'transmission',
      isLiveCubemapCamera ? 0 : this.getTransmissionAmount(this._materialOptions),
    );

    if (!isLiveCubemapCamera && this.hasTransmission(this._materialOptions)) {
      const sceneColorTexture = this.getSceneColor(renderer, scene);
      this.setUniformValue('sceneColorTexture', sceneColorTexture);

      const sceneColorResolution = this.getUniformValue<THREE.Vector2>(
        'sceneColorResolution',
        () => new THREE.Vector2(),
      );
      renderer.getDrawingBufferSize(sceneColorResolution);
      this.setUniformValue('sceneColorResolution', sceneColorResolution);
    }
  }

  private getWebGLRenderPassHeight(renderer: THREE.WebGLRenderer): number {
    const renderTarget = renderer.getRenderTarget();
    if (renderTarget) return renderTarget.height || 600;

    const viewport = renderer.getCurrentViewport(new THREE.Vector4());
    if (viewport.w > 0) return viewport.w;

    const drawingBufferSize = renderer.getDrawingBufferSize(new THREE.Vector2());
    return drawingBufferSize.y || 600;
  }

  private updateWebGPUInstances(
    particles: Particle[],
    camera: THREE.Camera | undefined,
    cameraQuaternion?: THREE.Quaternion,
    sizeAttenuation = true,
    billboard = true,
  ): void {
    const count = Math.min(particles.length, this.webgpuCapacity);

    this.webgpuMesh.count = count;

    if (cameraQuaternion) {
      this.cameraQuaternion.copy(cameraQuaternion);
    } else if (camera) {
      camera.getWorldQuaternion(this.cameraQuaternion);
    } else {
      this.cameraQuaternion.identity();
    }

    for (let index = 0; index < count; index += 1) {
      const particle = particles[index];

      if (billboard) {
        this.rollQuaternion.setFromAxisAngle(
          this.rollAxis,
          particle.rotation.x,
        );
        this.quaternion.copy(this.cameraQuaternion).multiply(this.rollQuaternion);
      } else {
        this.euler.set(
          particle.rotation.x,
          particle.rotation.y,
          particle.rotation.z,
        );
        this.quaternion.setFromEuler(this.euler);
      }
      this.scaleVector.copy(
        this.getWebGPUWorldScale(
          particle,
          camera,
          this.webgpuMesh.parent,
          sizeAttenuation,
        ),
      );

      this.matrix.compose(
        particle.position,
        this.quaternion,
        this.scaleVector,
      );

      this.webgpuMesh.setMatrixAt(index, this.matrix);
      this.webgpuMesh.setColorAt(index, this.color.copy(particle.color));

      this.webgpuSpriteDataAttribute.setXYZW(
        index,
        this.getParticleFrame(particle),
        particle.alpha,
        billboard ? particle.rotation.x : 0,
        particle.distortionStrength,
      );
    }

    this.webgpuMesh.instanceMatrix.needsUpdate = true;
    if (this.webgpuMesh.instanceColor) this.webgpuMesh.instanceColor.needsUpdate = true;
    this.webgpuSpriteDataAttribute.needsUpdate = true;

  }

  private updateWebGLQuadInstances(
    particles: Particle[],
    camera: THREE.Camera | undefined,
  ): void {
    const count = Math.min(particles.length, this.webgpuCapacity);

    this.webglQuadMesh.count = count;

    for (let index = 0; index < count; index += 1) {
      const particle = particles[index];

      this.euler.set(
        particle.rotation.x,
        particle.rotation.y,
        particle.rotation.z,
      );
      this.quaternion.setFromEuler(this.euler);
      this.scaleVector.copy(
        this.getWebGPUWorldScale(
          particle,
          camera,
          this.webglQuadMesh.parent,
          this.sizeAttenuation,
        ),
      );

      this.matrix.compose(
        particle.position,
        this.quaternion,
        this.scaleVector,
      );

      this.webglQuadMesh.setMatrixAt(index, this.matrix);
      this.webglQuadMesh.setColorAt(index, this.color.copy(particle.color));
      this.webglQuadSpriteDataAttribute.setXYZW(
        index,
        this.getParticleFrame(particle),
        particle.alpha,
        0,
        particle.distortionStrength,
      );
    }

    this.webglQuadMesh.instanceMatrix.needsUpdate = true;
    if (this.webglQuadMesh.instanceColor) this.webglQuadMesh.instanceColor.needsUpdate = true;
    this.webglQuadSpriteDataAttribute.needsUpdate = true;
  }

  private getWebGPUWorldScale(
    particle: Particle,
    camera: THREE.Camera | undefined,
    parent: THREE.Object3D | null,
    sizeAttenuation = true,
  ): THREE.Vector3 {
    const width = particle.scale.x;
    const height = particle.scale.y;

    if (!(camera instanceof THREE.PerspectiveCamera)) {
      this.scaleVector.set(width, height, 1);
      return this.scaleVector;
    }

    this.scaleVector.set(width, height, 1);
    if (sizeAttenuation) {
      return this.scaleVector;
    }

    camera.getWorldPosition(this.cameraPosition);
    this.particleWorldPosition.copy(particle.position);
    parent?.localToWorld(this.particleWorldPosition);

    const distance = this.particleWorldPosition.distanceTo(this.cameraPosition);
    this.scaleVector.multiplyScalar(
      Math.max(distance, camera.near) / Math.max(camera.zoom, 0.000001),
    );

    return this.scaleVector;
  }

  private getParticleFrame(particle: Particle): number {
    return (
      this.randomStartFrame
        ? Math.floor(seedrandom(particle.id).quick() * this.frames)
        : 0
    ) + (
      Math.floor(
        (particle.realtime / 1000) * evaluateDynamicNumber(this.fps, particle.time, particle.id),
      ) % this.frames
    );
  }

  private updateWebGPUEnvironmentMap(
    environment: THREE.Texture | null,
    intensity: number,
  ): void {
    if (this.materialType !== SpriteMaterialType.Lit) return;

    const material = this.webgpuMaterial as THREE.MeshStandardMaterial;
    const nextEnvironment = environment ?? null;

    if (
      material.envMap === nextEnvironment
      && material.envMapIntensity === intensity
    ) return;

    material.envMap = nextEnvironment;
    material.envMapIntensity = intensity;
    material.needsUpdate = true;
  }

  private updateWebGPUSoftParticles(
    renderer: WebGPURenderer,
    scene: THREE.Scene | undefined,
    camera: THREE.Camera | undefined,
  ): void {
    if (!this.softParticleDistance) return;
    if (!renderer || !scene || !camera) return;

    this.getWebGPUSceneDepth(renderer, scene, camera);
  }

  private updateEnvironmentMap(
    renderer: THREE.WebGLRenderer,
    environment: THREE.Texture | null,
    force: boolean = false,
  ): void {
    if (this.materialType !== SpriteMaterialType.Lit)
      return;

    if (
      !force
      &&
      environment === this.environmentSource
      && renderer === this.environmentRenderer
    ) {
      return;
    }

    this.environmentRenderTarget?.dispose();
    this.environmentRenderTarget = undefined;

    this.environmentSource = environment ?? undefined;
    this.environmentRenderer = renderer;

    if (!environment) {
      this.setEnvironmentMap(null);
      return;
    }

    // Already a PMREM CubeUV texture.
    if (environment.mapping === THREE.CubeUVReflectionMapping) {
      this.setEnvironmentMap(environment);
      return;
    }

    const pmremGenerator =
        new THREE.PMREMGenerator(renderer);

    let renderTarget: THREE.WebGLRenderTarget;

    if ((environment as THREE.CubeTexture).isCubeTexture) {
      renderTarget =
        pmremGenerator.fromCubemap(
          environment as THREE.CubeTexture
        );
    } else {
      renderTarget =
        pmremGenerator.fromEquirectangular(environment);
    }

    pmremGenerator.dispose();

    this.environmentRenderTarget = renderTarget;

    this.setEnvironmentMap(renderTarget.texture);
  }

  private setEnvironmentMap(
    environment: THREE.Texture | null
  ): void {
    if (this.materialType !== SpriteMaterialType.Lit)
      return;

    const materials = [this.material, this.quadMaterial];

    materials.forEach((material) => {
      material.uniforms.envMap.value = environment;
      material.uniforms.hasEnvMap.value = environment !== null;
    });

    if (!environment) {
      materials.forEach((material) => {
        delete material.defines?.ENVMAP_TYPE_CUBE_UV;
        delete material.defines?.CUBEUV_TEXEL_WIDTH;
        delete material.defines?.CUBEUV_TEXEL_HEIGHT;
        delete material.defines?.CUBEUV_MAX_MIP;

        material.needsUpdate = true;
      });
      return;
    }

    const image = environment.source.data as {
        width: number;
        height: number;
    };

    const imageHeight = image.height;

    const maxMip =
      Math.log2(imageHeight) - 2;

    const texelHeight =
      1 / imageHeight;

    const texelWidth =
      1 / (
        3 * Math.max(
          Math.pow(2, maxMip),
          7 * 16
        )
      );

    materials.forEach((material) => {
      material.defines ??= {};

      material.defines.ENVMAP_TYPE_CUBE_UV = '';
      material.defines.CUBEUV_TEXEL_WIDTH = `${texelWidth}`;
      material.defines.CUBEUV_TEXEL_HEIGHT = `${texelHeight}`;
      material.defines.CUBEUV_MAX_MIP = `${maxMip}.0`;

      material.needsUpdate = true;
    });
  }

  private setUniformValue<T>(name: string, value: T): void {
    [this.material, this.quadMaterial].forEach((material) => {
      material.uniforms[name] ??= { value };
      material.uniforms[name].value = value;
    });
  }

  private getUniformValue<T>(name: string, create: () => T): T {
    this.material.uniforms[name] ??= { value: create() };
    return this.material.uniforms[name].value as T;
  }

  private getSceneColor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
  ): THREE.FramebufferTexture {
    let data = scene.userData[SCENE_COLOR_DATA_USER_DATA_KEY] as SceneColorData | undefined;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());

    if (!data) {
      data = {
        texture: new THREE.FramebufferTexture(size.x, size.y),
        frame: -1,
      };

      scene.userData[SCENE_COLOR_DATA_USER_DATA_KEY] = data;
    }

    if (data.texture.image.width !== size.x || data.texture.image.height !== size.y) {
      data.texture.dispose();
      data.texture = new THREE.FramebufferTexture(size.x, size.y);
    }

    const frame = renderer.info.render.frame;

    if (data.frame !== frame) {
      renderer.copyFramebufferToTexture(data.texture);
      data.frame = frame;
    }

    return data.texture;
  }

  private getSceneDepth(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ): THREE.DepthTexture | undefined {
    let data = scene.userData[SCENE_DEPTH_DATA_USER_DATA_KEY] as SceneDepthData | undefined;

    if (!data) {
      const size = renderer.getDrawingBufferSize(new THREE.Vector2());

      const depthTexture = new THREE.DepthTexture(
        size.x,
        size.y,
        THREE.UnsignedIntType,
      );

      const target = new THREE.WebGLRenderTarget(
        size.x,
        size.y,
        {
          depthBuffer: true,
          depthTexture,
        },
      );

      const material = new THREE.MeshDepthMaterial({
        depthPacking: THREE.BasicDepthPacking,
        side: THREE.DoubleSide,
      });
      material.colorWrite = false;

      data = {
        target,
        material,
        frame: -1,
        rendering: false,
      };

      scene.userData[SCENE_DEPTH_DATA_USER_DATA_KEY] = data;
    }

    if (data.rendering) {
      return data.target.depthTexture ?? undefined;
    }

    const frame = renderer.info.render.frame;

    if (data.frame === frame) {
      return data.target.depthTexture ?? undefined;
    }

    data.frame = frame;
    data.rendering = true;

    const size = renderer.getDrawingBufferSize(
      new THREE.Vector2(),
    );

    if (
      data.target.width !== size.x
      || data.target.height !== size.y
    ) {
      data.target.setSize(
        size.x,
        size.y,
      );
    }

    const previousTarget = renderer.getRenderTarget();
    const previousOverrideMaterial = scene.overrideMaterial;
    const hiddenSpriteRenderers = this.hideSpriteRenderers(scene);

    try {
      scene.overrideMaterial = data.material;

      renderer.setRenderTarget(data.target);
      renderer.clear();

      renderer.render(scene, camera);

      data.frame = renderer.info.render.frame;
    } finally {
      renderer.setRenderTarget(previousTarget);
      scene.overrideMaterial = previousOverrideMaterial;
      this.restoreSpriteRenderers(hiddenSpriteRenderers);
      data.rendering = false;
    }

    return data.target.depthTexture ?? undefined;
  }

  private getWebGPUSceneDepth(
    renderer: WebGPURenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ): THREE.DepthTexture | undefined {
    let data = scene.userData[WEBGPU_SCENE_DEPTH_DATA_USER_DATA_KEY] as WebGPUSceneDepthData | undefined;

    if (!data) {
      const size = renderer.getDrawingBufferSize(new THREE.Vector2());

      const target = new THREE.RenderTarget(
        size.x,
        size.y,
        {
          depthBuffer: true,
          depthTexture: WEBGPU_SCENE_DEPTH_TEXTURE,
          samples: 0,
        },
      );

      const material = new MeshBasicNodeMaterial({
        colorWrite: false,
        side: THREE.DoubleSide,
        depthTest: true,
        depthWrite: true,
      });

      data = {
        target,
        material,
        rendering: false,
      };

      scene.userData[WEBGPU_SCENE_DEPTH_DATA_USER_DATA_KEY] = data;
    }

    if (data.rendering) {
      return data.target.depthTexture ?? undefined;
    }

    data.rendering = true;

    const size = renderer.getDrawingBufferSize(
      new THREE.Vector2(),
    );

    if (
      data.target.width !== size.x
      || data.target.height !== size.y
    ) {
      data.target.setSize(
        size.x,
        size.y,
      );
    }

    const previousTarget = renderer.getRenderTarget();
    const previousOverrideMaterial = scene.overrideMaterial;
    const hiddenParticleRenderers = this.hideParticleRenderers(scene);

    try {
      scene.overrideMaterial = data.material;

      renderer.setRenderTarget(data.target);
      renderer.clear();
      renderer.render(scene, camera);
    } finally {
      renderer.setRenderTarget(previousTarget);
      scene.overrideMaterial = previousOverrideMaterial;
      this.restoreParticleRenderers(hiddenParticleRenderers);
      data.rendering = false;
    }

    return data.target.depthTexture ?? undefined;
  }

  private hideSpriteRenderers(scene: THREE.Scene): HiddenSpriteRenderer[] {
    return this.hideParticleRenderers(scene, false);
  }

  private hideParticleRenderers(
    scene: THREE.Scene,
    includeTrails: boolean = true,
  ): HiddenSpriteRenderer[] {
    const hidden: HiddenSpriteRenderer[] = [];

    scene.traverse((object) => {
      const isSpriteRenderer =
        object.userData[SPRITE_RENDERER_USER_DATA_KEY];
      const isTrailRenderer =
        includeTrails && object.userData[TRAIL_RENDERER_USER_DATA_KEY];

      if (!isSpriteRenderer && !isTrailRenderer) return;

      hidden.push({
        object,
        visible: object.visible,
      });

      object.visible = false;
    });

    return hidden;
  }

  private restoreSpriteRenderers(hidden: HiddenSpriteRenderer[]): void {
    this.restoreParticleRenderers(hidden);
  }

  private restoreParticleRenderers(hidden: HiddenSpriteRenderer[]): void {
    hidden.forEach(({ object, visible }) => {
      object.visible = visible;
    });
  }
}

export default SpriteRenderer;
