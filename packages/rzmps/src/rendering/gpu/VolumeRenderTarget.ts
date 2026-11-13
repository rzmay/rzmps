import * as THREE from 'three';
import { MeshBasicNodeMaterial, WebGPURenderer, type Node } from 'three/webgpu';
import {
  Fn,
  cameraFar,
  cameraNear,
  cameraProjectionMatrix,
  exp,
  float,
  floor,
  max,
  orthographicDepthToViewZ,
  perspectiveDepthToViewZ,
  screenUV,
  texture,
  uniform,
  vec2,
  vec4,
} from 'three/tsl';

export interface VolumeResolutionOptions {
  /** GPU frame budget in milliseconds. Defaults to 16.7. */
  targetFrameTime?: number;
  /** Lowest adaptive scale relative to the fixed downsample setting. Defaults to 0.5. */
  minimumScale?: number;
}

type TimingBackend = { trackTimestamp?: boolean };
const timingOwners = new WeakMap<TimingBackend, { previous: boolean; owners: Set<VolumeRenderTarget> }>();

/** Pooled screen-space volume reconstruction. Simulation fields and along-ray quality stay unchanged. @internal */
export default class VolumeRenderTarget {
  readonly sceneDepth = new THREE.DepthTexture(1, 1);
  readonly material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  private readonly color = texture(new THREE.Texture());
  private readonly metadata = texture(new THREE.Texture());
  private readonly respectDepth = uniform(1);
  private readonly size = uniform(new THREE.Vector2(1, 1));
  private readonly targets = new Map<number, THREE.RenderTarget>();
  private readonly scene = new THREE.Scene();
  private readonly depthTarget = new THREE.RenderTarget(1, 1, { depthTexture: this.sceneDepth, samples: 0 });
  private readonly depthMaterial = new MeshBasicNodeMaterial({
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
    side: THREE.DoubleSide,
  });
  private proxy?: THREE.Mesh;
  private depthCamera?: THREE.Camera;
  private scale = 1;
  private downsample = 1;
  private dynamic = true;
  private average = 0;
  private observations = 0;
  private frames = 0;
  private timingPending = false;
  private timingBackend?: TimingBackend;
  private disposed = false;

  constructor() {
    this.material.fragmentNode = Fn(() => {
      const uv = screenUV;
      const raw = texture(this.sceneDepth).sample(uv).level(float(0)).r;
      const orthographic = cameraProjectionMatrix.mul(vec4(0, 0, 0, 1)).w.equal(1);
      const viewDepth = (depth: Node<'float'>) =>
        orthographic.select(
          orthographicDepthToViewZ(depth, cameraNear, cameraFar),
          perspectiveDepthToViewZ(depth, cameraNear, cameraFar),
        );
      const sceneZ = viewDepth(raw);
      const p = uv.mul(this.size).sub(0.5),
        base = floor(p),
        fraction = p.sub(base);
      const sum = vec4(0).toVar(),
        weights = float(0).toVar();
      // Reconstruct premultiplied radiance/transmittance; never interpolate straight RGB through vacuum.
      for (const y of [0, 1])
        for (const x of [0, 1]) {
          const sampleUV = base.add(vec2(x, y)).add(0.5).div(this.size);
          const sample = this.color.sample(sampleUV).level(float(0));
          const info = this.metadata.sample(sampleUV).level(float(0));
          const tolerance = max(sceneZ.abs().mul(0.002), 0.01);
          const spatial = (x ? fraction.x : float(1).sub(fraction.x)).mul(y ? fraction.y : float(1).sub(fraction.y));
          // Reject low-resolution rays clipped by a different opaque surface, or whose
          // representative volume depth lies behind this full-resolution scene pixel.
          const compatible = info.y.greaterThanEqual(sceneZ.sub(tolerance));
          const bilateral = exp(info.x.sub(sceneZ).abs().div(tolerance).negate()).mul(compatible.select(1, 0));
          const weight = spatial.mul(this.respectDepth.greaterThan(0).select(bilateral, float(1)));
          sum.addAssign(vec4(sample.rgb.mul(sample.a), sample.a).mul(weight));
          weights.addAssign(weight);
        }
      const result = sum.div(weights.max(1e-6));
      return vec4(result.rgb.div(result.a.max(1e-6)), result.a);
    })();
  }

  get resolutionScale(): number {
    return (this.dynamic ? this.scale : 1) / this.downsample;
  }

  /** Fixed screen-resolution divisor, with optional timing-based adaptation on top. */
  configure(downsample: number, dynamic: boolean): void {
    if (!Number.isFinite(downsample) || downsample < 1) {
      throw new RangeError('Volume downsample must be finite and at least one.');
    }
    this.downsample = downsample;
    this.dynamic = dynamic;
    if (!dynamic) this.releaseTiming();
  }

  /** GPU time only: pipeline compilation/CPU stalls must not lower image resolution. */
  observe(milliseconds: number, options: VolumeResolutionOptions): void {
    const budget = options.targetFrameTime ?? 16.7,
      minimum = options.minimumScale ?? 0.5;
    if (!(budget > 0) || !Number.isFinite(budget) || !(minimum > 0 && minimum <= 1)) {
      throw new RangeError('Volume dynamic resolution requires a positive budget and minimumScale in (0, 1].');
    }
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
    this.average = this.average ? this.average * 0.9 + milliseconds * 0.1 : milliseconds;
    if (++this.observations < 24) return;
    this.observations = 0;
    if (this.average > budget * 1.15) this.scale = Math.max(minimum, Math.round((this.scale - 0.1) * 10) / 10);
    else if (this.average < budget * 0.7) this.scale = Math.min(1, Math.round((this.scale + 0.1) * 10) / 10);
  }

  render(
    renderer: WebGPURenderer,
    rootScene: THREE.Scene,
    camera: THREE.Camera,
    source: THREE.Mesh,
    rayMaterial: MeshBasicNodeMaterial,
    options: VolumeResolutionOptions,
  ): void {
    const backend = renderer.backend as {
      trackTimestamp?: boolean;
      device?: { features: { has(feature: string): boolean } };
    };
    if (this.dynamic && backend.device?.features.has('timestamp-query') && this.timingBackend !== backend) {
      this.releaseTiming();
      const state = timingOwners.get(backend) ?? { previous: !!backend.trackTimestamp, owners: new Set() };
      state.owners.add(this);
      timingOwners.set(backend, state);
      this.timingBackend = backend;
      backend.trackTimestamp = true;
    }
    const timestamps = this.dynamic && backend.trackTimestamp;
    if (++this.frames % 8 === 0 && !this.timingPending && timestamps) {
      this.timingPending = true;
      // Adapt to render cost only: lowering image resolution cannot recover simulation time.
      // Resolve after the application has submitted the rest of this frame, never inside the render pass.
      void Promise.resolve()
        .then(() =>
          renderer.resolveTimestampsAsync('render'),
        )
        .then(() => {
          if (!this.disposed)
            this.observe(renderer.info.render.timestamp, options);
        })
        .catch(() => {
          /* Unavailable timestamps keep the current quality. */
        })
        .finally(() => {
          this.timingPending = false;
        });
    }
    const scale = this.resolutionScale;
    if (scale >= 1) return;
    this.respectDepth.value = rayMaterial.depthTest ? 1 : 0;
    const previousTarget = renderer.getRenderTarget();
    const full = previousTarget
      ? new THREE.Vector2(previousTarget.width, previousTarget.height)
      : renderer.getDrawingBufferSize(new THREE.Vector2());
    this.depthTarget.setSize(full.x, full.y);
    let target = this.targets.get(scale);
    if (!target) {
      target = new THREE.RenderTarget(1, 1, { count: 2, type: THREE.HalfFloatType, depthBuffer: false });
      target.textures[0].name = 'output';
      target.textures[1].name = 'volumeMetadata';
      for (const map of target.textures) {
        map.minFilter = THREE.NearestFilter;
        map.magFilter = THREE.NearestFilter;
      }
      this.targets.set(scale, target);
    }
    target.setSize(Math.max(1, Math.ceil(full.x * scale)), Math.max(1, Math.ceil(full.y * scale)));
    this.color.value = target.textures[0];
    this.metadata.value = target.textures[1];
    this.size.value.set(target.width, target.height);
    if (!this.proxy) {
      this.proxy = new THREE.Mesh(source.geometry, rayMaterial);
      this.proxy.matrixAutoUpdate = false;
      this.proxy.frustumCulled = false;
      this.scene.add(this.proxy);
    }
    this.proxy.material = rayMaterial;
    this.proxy.matrix.copy(source.matrixWorld);
    const clearColor = renderer.getClearColor(new THREE.Color()),
      clearAlpha = renderer.getClearAlpha();
    const autoClear = renderer.autoClear,
      mrt = renderer.getMRT();
    const previousBlend = rayMaterial.blending,
      depthTest = rayMaterial.depthTest;
    const hidden: THREE.Object3D[] = [];
    const override = rootScene.overrideMaterial;
    rootScene.traverse(object => {
      if (!(object instanceof THREE.Mesh) || !object.visible) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (object === source || materials.every(material => material.transparent || !material.depthWrite)) {
        hidden.push(object);
        object.visible = false;
      }
    });
    try {
      // A nested offscreen pass cannot consume an unsubmitted main-pass depth copy.
      // Render current opaque depth first, in queue order, instead of reading last-frame depth.
      rootScene.overrideMaterial = this.depthMaterial;
      renderer.setMRT(null);
      renderer.setRenderTarget(this.depthTarget);
      renderer.autoClear = true;
      renderer.setClearColor(0, 0);
      // Three caches render lists by scene and camera. Reusing both during onBeforeRender
      // clears the outer pass's list while it is being iterated, aborting subsequent frames.
      // Keep a separate camera identity, with exactly the same current projection and pose.
      if (!this.depthCamera || this.depthCamera.constructor !== camera.constructor) {
        this.depthCamera = camera.clone();
      }
      this.depthCamera.copy(camera, false);
      this.depthCamera.matrixAutoUpdate = false;
      this.depthCamera.matrixWorldAutoUpdate = false;
      this.depthCamera.matrix.copy(camera.matrixWorld);
      renderer.render(rootScene, this.depthCamera);
      rootScene.overrideMaterial = override;
      hidden.forEach(object => {
        object.visible = true;
      });
      // MRT writes straight radiance and explicit metadata; composition performs blending exactly once.
      rayMaterial.blending = THREE.NoBlending;
      rayMaterial.depthTest = false;
      renderer.setMRT(null);
      renderer.setRenderTarget(target);
      renderer.setClearColor(0, 0);
      renderer.autoClear = true;
      renderer.render(this.scene, camera);
    } finally {
      rootScene.overrideMaterial = override;
      hidden.forEach(object => {
        object.visible = true;
      });
      rayMaterial.blending = previousBlend;
      rayMaterial.depthTest = depthTest;
      renderer.setRenderTarget(previousTarget);
      renderer.setMRT(mrt);
      renderer.setClearColor(clearColor, clearAlpha);
      renderer.autoClear = autoClear;
    }
  }

  /** Restore timestamp tracking when the last adaptive volume releases its renderer. */
  releaseTiming(): void {
    const backend = this.timingBackend;
    if (!backend) return;
    const state = timingOwners.get(backend);
    state?.owners.delete(this);
    if (state && state.owners.size === 0) {
      backend.trackTimestamp = state.previous;
      timingOwners.delete(backend);
    }
    this.timingBackend = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.releaseTiming();
    this.targets.forEach(target => target.dispose());
    this.targets.clear();
    this.depthTarget.dispose();
    this.depthMaterial.dispose();
    this.sceneDepth.dispose();
    this.material.dispose();
    this.scene.clear();
  }
}
