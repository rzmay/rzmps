import * as THREE from 'three';
import Renderer, { type RendererOptions } from '../Renderer';
import Particle from '../Particle';
import ParticleSystem from '../ParticleSystem';
import defaultTex from '../assets/textures/default.png';
import UnlitSprite, { type UnlitSpriteOptions } from '../materials/UnlitSprite';
import BasicSprite, { type BasicSpriteOptions } from '../materials/BasicSprite';
import WebGPUUnlitSprite from '../materials/WebGPUUnlitSprite';
import WebGPUBasicSprite from '../materials/WebGPUBasicSprite';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';
import seedrandom from 'seedrandom';
import { SpriteMaterialType } from '../enums/SpriteMaterialType';
import { TRAIL_RENDERER_USER_DATA_KEY } from './TrailRenderer';
import WebGPURenderer from 'three/src/renderers/webgpu/WebGPURenderer.js';

type SceneDepthData = {
  target: THREE.WebGLRenderTarget;
  material: THREE.MeshDepthMaterial;
  frame: number;
  rendering: boolean;
};

type WebGPUSceneDepthData = {
  target: THREE.RenderTarget;
  material: THREE.MeshBasicMaterial;
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
  tileSize: {x: number, y: number};
  tileMargin: {x: number, y: number};
  gridSize: {x: number, y: number};
  frames: number;
  randomStartFrame: boolean;
  alphaMap: string | THREE.Texture;
  material: SpriteMaterialType | `${SpriteMaterialType}`;
  materialOptions: Partial<BasicSpriteOptions | UnlitSpriteOptions>;
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

  randomStartFrame: boolean = false;

  castShadow: boolean = false;

  softParticleDistance: number = 0;

  private material: THREE.ShaderMaterial;
  private webgpuMaterial: THREE.Material;
  private readonly hiddenMaterial = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: false,
    transparent: true,
    opacity: 0,
  });

  private _materialOptions?: Partial<BasicSpriteOptions | UnlitSpriteOptions>;
  get materialOptions(): Partial<BasicSpriteOptions | UnlitSpriteOptions> { return this._materialOptions ?? {}; }
  set materialOptions(value: Partial<BasicSpriteOptions | UnlitSpriteOptions> | undefined) {
    this._materialOptions = value;
    this.material = this.loadMaterial(value);
    this.points.material = this.material;
    this.webgpuMaterial = this.loadWebGPUMaterial(value);
    this.webgpuMesh.material = this.webgpuMaterial;
  }

  private environmentSource?: THREE.Texture;
  private environmentRenderer?: THREE.WebGLRenderer;
  private environmentRenderTarget?: THREE.WebGLRenderTarget;

  private readonly geometry: THREE.BufferGeometry;

  private readonly points: THREE.Points;
  private readonly webgpuGeometry: THREE.PlaneGeometry;
  private readonly webgpuMesh: THREE.InstancedMesh;
  private webgpuFrameAttribute: THREE.InstancedBufferAttribute;
  private webgpuAlphaAttribute: THREE.InstancedBufferAttribute;
  private webgpuCapacity = 10000;
  private webgpuParticles: Particle[] = [];

  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly cameraQuaternion = new THREE.Quaternion();
  private readonly rollQuaternion = new THREE.Quaternion();
  private readonly rollAxis = new THREE.Vector3(0, 0, 1);
  private readonly scaleVector = new THREE.Vector3();
  private readonly color = new THREE.Color();

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
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.castShadow = this.castShadow;
    this.points.visible = false;
    this.points.material = this.hiddenMaterial;

    this.webgpuGeometry = new THREE.PlaneGeometry(1, 1);
    this.webgpuFrameAttribute = new THREE.InstancedBufferAttribute(new Float32Array(this.webgpuCapacity), 1);
    this.webgpuAlphaAttribute = new THREE.InstancedBufferAttribute(new Float32Array(this.webgpuCapacity), 1);
    this.webgpuGeometry.setAttribute('frame', this.webgpuFrameAttribute);
    this.webgpuGeometry.setAttribute('instanceAlpha', this.webgpuAlphaAttribute);

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
    this.webgpuMesh.userData[SPRITE_RENDERER_USER_DATA_KEY] = true;
  }

  setup(system: ParticleSystem) {
    system.addRendererObject(this.points);
    system.addRendererObject(this.webgpuMesh);

    this.points.onBeforeRender = (renderer, _scene, camera) => {
      this.setActiveRenderer(renderer);

      if (renderer instanceof THREE.WebGLRenderer) {
        this.setUniformValue(
          'viewportHeight',
          this.getWebGLRenderPassHeight(renderer),
        );

        const isSceneCamera = !system.sceneCamera || camera === system.sceneCamera;
        this.setUniformValue('softParticles', isSceneCamera && Boolean(this.softParticleDistance));
      }
    };
    this.webgpuMesh.onBeforeRender = (renderer, _scene, camera) => {
      this.setActiveRenderer(renderer);
    };
  }

  _update(particles: Particle[], system: ParticleSystem): void {
    this.setActiveRenderer(system.sceneRenderer);

    // Update attributes
    if (system.sceneRenderer instanceof WebGPURenderer) {
      this.webgpuParticles = particles;

      if (system.sceneCamera) {
        this.updateWebGPUInstances(
          particles,
          system.sceneCamera,
          system.sceneCameraQuaternion,
        );
      }
    } else {
      this.updateAttributes(particles);
    }

    // Should the points cast a shadow?
    this.points.castShadow = this.castShadow;
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

    this.geometry.setAttribute('rotation', new THREE.BufferAttribute(
      new Float32Array(
        particles.flatMap(
          (particle: Particle) => particle.rotation.toArray(),
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

    this.geometry.setAttribute('frame', new THREE.BufferAttribute(
      new Float32Array(
        particles.flatMap((particle: Particle) => this.getParticleFrame(particle)),
      ),
      1,
    ));
  }

  destroy(): void
  {
    this.environmentRenderTarget?.dispose();
    this.environmentRenderTarget = undefined;

    this.geometry.dispose();
    this.material.dispose();
    this.webgpuGeometry.dispose();
    this.webgpuMaterial.dispose();
    this.hiddenMaterial.dispose();

    this.points.removeFromParent();
    this.webgpuMesh.removeFromParent();
  }

  clear(): void
  {
    this.updateAttributes([]);
  }

  private loadMaterial(options: Partial<BasicSpriteOptions | UnlitSpriteOptions> | undefined) {
    const createMaterial = this.materialType === SpriteMaterialType.Basic ? BasicSprite : UnlitSprite;

    return createMaterial(this.texture, {
      ...(options ?? {}),

      frames: this.frames,
      gridSize: this.gridSize,
      alphaMap: this.alphaMap,
      softParticleDistance: this.softParticleDistance,
    });
  }

  private loadWebGPUMaterial(options: Partial<BasicSpriteOptions | UnlitSpriteOptions> | undefined) {
    const createMaterial = this.materialType === SpriteMaterialType.Basic ? WebGPUBasicSprite : WebGPUUnlitSprite;

    return createMaterial(this.texture, {
      ...(options ?? {}),

      frames: this.frames,
      gridSize: this.gridSize,
      alphaMap: this.alphaMap,
      softParticleDistance: this.softParticleDistance,
      sceneDepthTexture: WEBGPU_SCENE_DEPTH_TEXTURE,
    });
  }

  private setActiveRenderer(renderer: THREE.WebGLRenderer | WebGPURenderer | undefined): void {
    this.points.visible = Boolean(renderer instanceof THREE.WebGLRenderer);
    this.points.material = renderer instanceof THREE.WebGLRenderer ? this.material : this.hiddenMaterial;
    this.webgpuMesh.visible = renderer instanceof WebGPURenderer;
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

      this.rollQuaternion.setFromAxisAngle(
        this.rollAxis,
        particle.rotation.x,
      );

      this.quaternion.copy(this.cameraQuaternion).multiply(this.rollQuaternion);
      this.scaleVector.copy(
        this.getWebGPUWorldScale(
          particle,
          camera,
        ),
      );

      this.matrix.compose(
        particle.position,
        this.quaternion,
        this.scaleVector,
      );

      this.webgpuMesh.setMatrixAt(index, this.matrix);
      this.webgpuMesh.setColorAt(index, this.color.copy(particle.color));

      this.webgpuFrameAttribute.setX(index, this.getParticleFrame(particle));
      this.webgpuAlphaAttribute.setX(index, particle.alpha);
    }

    this.webgpuMesh.instanceMatrix.needsUpdate = true;
    if (this.webgpuMesh.instanceColor) this.webgpuMesh.instanceColor.needsUpdate = true;
    this.webgpuFrameAttribute.needsUpdate = true;
    this.webgpuAlphaAttribute.needsUpdate = true;

  }

  private getWebGPUWorldScale(
    particle: Particle,
    camera: THREE.Camera | undefined,
  ): THREE.Vector3 {
    const width = particle.scale.x;
    const height = particle.scale.y;

    if (!(camera instanceof THREE.PerspectiveCamera)) {
      this.scaleVector.set(width, height, 1);
      return this.scaleVector;
    }

    this.scaleVector.set(width, height, 1);

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
    if (this.materialType !== SpriteMaterialType.Basic) return;

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
    if (this.materialType !== SpriteMaterialType.Basic)
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
    if (this.materialType !== SpriteMaterialType.Basic)
      return;

    this.material.uniforms.envMap.value = environment;
    this.material.uniforms.hasEnvMap.value = environment !== null;

    if (!environment) {
      delete this.material.defines?.ENVMAP_TYPE_CUBE_UV;
      delete this.material.defines?.CUBEUV_TEXEL_WIDTH;
      delete this.material.defines?.CUBEUV_TEXEL_HEIGHT;
      delete this.material.defines?.CUBEUV_MAX_MIP;

      this.material.needsUpdate = true;
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

    this.material.defines ??= {};

    this.material.defines.ENVMAP_TYPE_CUBE_UV = '';
    this.material.defines.CUBEUV_TEXEL_WIDTH = `${texelWidth}`;
    this.material.defines.CUBEUV_TEXEL_HEIGHT = `${texelHeight}`;
    this.material.defines.CUBEUV_MAX_MIP = `${maxMip}.0`;

    this.material.needsUpdate = true;
  }

  private setUniformValue<T>(name: string, value: T): void {
    this.material.uniforms[name] ??= { value };
    this.material.uniforms[name].value = value;
  }

  private getUniformValue<T>(name: string, create: () => T): T {
    this.material.uniforms[name] ??= { value: create() };
    return this.material.uniforms[name].value as T;
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

      const material = new THREE.MeshBasicMaterial({
        colorWrite: false,
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
