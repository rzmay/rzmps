import * as THREE from 'three';
import CubeRenderTarget from 'three/src/renderers/common/CubeRenderTarget.js';
import WebGPURenderer from 'three/src/renderers/webgpu/WebGPURenderer.js';

export const LIVE_CUBEMAP_CAMERA_KEY = '__rzmps_liveCubemapCamera';
export const PARTICLE_RENDERER_OBJECT_KEY = '__rzmps_particleRendererObject';

export interface LiveCubemapOptions {
  resolutionScale: number;
  fps: number;
  intensity: number;
  excludeParent: boolean;
  excludeParticleRenderers: boolean;
}

type HiddenObject = {
  object: THREE.Object3D;
  visible: boolean;
};

export default class LiveCubemap extends THREE.Object3D {

  static isLiveCubemapCamera(camera?: THREE.Camera): boolean {
    return Boolean(
      camera?.userData?.[LIVE_CUBEMAP_CAMERA_KEY]
      || camera?.parent?.userData?.[LIVE_CUBEMAP_CAMERA_KEY],
    );
  }

  fps: number = 24;
  resolutionScale: number = 1 / 16;
  intensity: number = 1;
  excludeParent: boolean = false;
  excludeParticleRenderers: boolean = false;

  get map(): THREE.Texture | undefined { return this._renderTarget?.texture }

  private _updateAccumulator: number = 0;

  private _renderTarget?: THREE.WebGLCubeRenderTarget | CubeRenderTarget;
  private _cubeCamera?: THREE.CubeCamera;

  constructor(options: Partial<LiveCubemapOptions> = {}) {
    super();

    this.fps = options.fps ?? this.fps;
    this.resolutionScale = options.resolutionScale ?? this.resolutionScale;
    this.intensity = options.intensity ?? this.intensity;
    this.excludeParent = options.excludeParent ?? this.excludeParent;
    this.excludeParticleRenderers = options.excludeParticleRenderers ?? this.excludeParticleRenderers;
  }

  setup(parent: THREE.Object3D) {
    parent.add(this);
  }

  update(scene?: THREE.Scene, renderer?: THREE.WebGLRenderer | WebGPURenderer, deltaTime: number = 0): void {
    if (
      !scene
      || !renderer
    ) return;

    // manage FPS timing
    this._updateAccumulator += deltaTime;
    if (this._updateAccumulator < 1 / this.fps) return;
    this._updateAccumulator -= (1 / this.fps);

    const rendererResolution = new THREE.Vector2();
    renderer.getSize(rendererResolution);
    rendererResolution.multiplyScalar(this.resolutionScale);

    const resolution = THREE.MathUtils.ceilPowerOfTwo(
      Math.max(rendererResolution.x, rendererResolution.y)
    );

    if (!this._renderTarget) {
      if (renderer instanceof WebGPURenderer) {
        // Using WebGPU
        this._renderTarget = new CubeRenderTarget(resolution, {
          type: THREE.HalfFloatType,
          format: THREE.RGBAFormat,
          generateMipmaps: true,
          minFilter: THREE.LinearMipmapLinearFilter,
        });
      } else {
        // Using WebGL
        this._renderTarget = new THREE.WebGLCubeRenderTarget(resolution, {
          type: THREE.HalfFloatType,
          format: THREE.RGBAFormat,
          generateMipmaps: true,
          minFilter: THREE.LinearMipmapLinearFilter,
        });
      }
    } else {
      this._renderTarget.setSize(resolution, resolution);
    }

    if (!this._cubeCamera) {
      this._cubeCamera = new THREE.CubeCamera(0.1, 1000, this._renderTarget);

      // Track so particle system knows not to treat this as the active camera
      this._cubeCamera.userData[LIVE_CUBEMAP_CAMERA_KEY] = true;
      this._cubeCamera.children.forEach((child) => {
        child.userData[LIVE_CUBEMAP_CAMERA_KEY] = true;
      });

      // Should be positioned at the same place as the system
      this.add(this._cubeCamera);
    }

    const previousClearColor = new THREE.Color();
    const previousClearAlpha = renderer.getClearAlpha();

    const backgroundColor = scene.background instanceof THREE.Color
      ? scene.background
      : undefined;
    const previousBackground = scene.background;

    if (backgroundColor) {
      renderer.getClearColor(previousClearColor);
      renderer.setClearColor(backgroundColor, 1);
      scene.background = null;
    }

    const excludedParent = this.excludeParent ? this.parent : undefined;
    const previousParentVisibility = excludedParent?.visible;
    const hiddenParticleRenderers = this.excludeParticleRenderers
      ? this.hideParticleRenderers(scene)
      : [];

    if (excludedParent) {
      excludedParent.visible = false;
    }

    try {
      this._cubeCamera.update(renderer, scene);
    } finally {
      if (excludedParent && previousParentVisibility !== undefined) {
        excludedParent.visible = previousParentVisibility;
      }

      this.restoreHiddenObjects(hiddenParticleRenderers);

      if (backgroundColor) {
        scene.background = previousBackground;
        renderer.setClearColor(previousClearColor, previousClearAlpha);
      }
    }
  }

  dispose(): void {
    this._renderTarget?.dispose();
    this._renderTarget = undefined;
    this._cubeCamera = undefined;
  }

  private hideParticleRenderers(scene: THREE.Scene): HiddenObject[] {
    const hidden: HiddenObject[] = [];

    scene.traverse((object) => {
      if (!object.userData[PARTICLE_RENDERER_OBJECT_KEY]) return;

      hidden.push({
        object,
        visible: object.visible,
      });
      object.visible = false;
    });

    return hidden;
  }

  private restoreHiddenObjects(hidden: HiddenObject[]): void {
    hidden.forEach(({ object, visible }) => {
      object.visible = visible;
    });
  }
}
