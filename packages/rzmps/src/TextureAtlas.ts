import * as THREE from 'three';
import { MeshBasicNodeMaterial, type Node, type WebGPURenderer } from 'three/webgpu';
import { float, texture, uniform, uv, vec2 } from 'three/tsl';

export interface TextureAtlasOptions {
  /** Interior tile resolution. Sources are resampled on the GPU. */
  tileSize?: number;
  /** Extruded border. Mipmaps are disabled to prevent cross-tile bleeding. */
  padding?: number;
  colorSpace?: THREE.ColorSpace;
}

type AtlasRenderer = THREE.WebGLRenderer | WebGPURenderer;

/** GPU-baked equal-tile atlas. Source textures remain owned by the caller. */
export default class TextureAtlas {
  readonly tileSize: number;
  readonly padding: number;
  readonly sources: THREE.Texture[] = [];
  readonly grid = new THREE.Vector2(1, 1);
  readonly target: THREE.WebGLRenderTarget;
  private readonly aliases = new Map<THREE.Texture, number>();
  private readonly revisions: number[] = [];
  private readonly imageSizes = new Map<THREE.Texture, string>();
  private _version = 0;
  private readonly dirty = new Set<number>();
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 2);
  private readonly geometry = new THREE.PlaneGeometry(2, 2);
  private readonly quad = new THREE.Mesh(this.geometry);
  private readonly materials = new Map<THREE.Texture, THREE.Material>();
  private renderer?: AtlasRenderer;
  private layoutCount = -1;
  private needsInitialization = true;

  constructor(options: TextureAtlasOptions = {}) {
    if (!Number.isFinite(options.tileSize ?? 128) || (options.tileSize ?? 128) < 1) {
      throw new RangeError('TextureAtlas tileSize must be a positive finite number.');
    }
    if (!Number.isFinite(options.padding ?? 2) || (options.padding ?? 2) < 0) {
      throw new RangeError('TextureAtlas padding must be a nonnegative finite number.');
    }

    this.tileSize = Math.max(1, Math.floor(options.tileSize ?? 128));
    this.padding = Math.max(1, Math.floor(options.padding ?? 2));
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      depthBuffer: false,
      stencilBuffer: false,
      magFilter: THREE.LinearFilter,
      minFilter: THREE.LinearFilter,
      generateMipmaps: false,
      colorSpace: options.colorSpace ?? THREE.SRGBColorSpace,
    });

    this.camera.position.z = 1;
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  get texture(): THREE.Texture {
    return this.target.texture;
  }

  /** Changes when layout or baked content changes. */
  get version(): number {
    return this._version;
  }

  isBaked(source: THREE.Texture): boolean {
    const index = this.aliases.get(source);
    return index !== undefined && this.revisions[index] !== undefined;
  }

  /** Stable tile index. Passing a source again aliases its existing tile. */
  add(source: THREE.Texture): number {
    if (source === this.texture) throw new Error('An atlas cannot sample its own render target.');

    const existing = this.aliases.get(source);
    if (existing !== undefined) return existing;

    const index = this.sources.length;
    this.sources.push(source);
    this.aliases.set(source, index);
    this.dirty.add(index);
    return index;
  }

  /** GPU-resident, compressed, image and data textures can all be sampled without CPU access. */
  static canBake(source: THREE.Texture): boolean {
    const image = source.image as { width?: number; height?: number } | undefined;
    const unsupported = source as THREE.Texture & {
      isDepthTexture?: boolean; isCubeTexture?: boolean; isData3DTexture?: boolean; isDataArrayTexture?: boolean;
    };

    return !unsupported.isDepthTexture && !unsupported.isCubeTexture
      && !unsupported.isData3DTexture && !unsupported.isDataArrayTexture
      && Boolean(image?.width && image?.height);
  }

  /**
   * Bakes only new or revised tiles. Supply the initialized scene renderer before sampling.
   * Layout changes re-bake the atlas; ordinary frames issue no atlas draw calls.
   */
  update(renderer?: AtlasRenderer): void {
    // Repacking invalidates tile contents and their normalized UV rectangles.
    if (this.layoutCount !== this.sources.length) {
      const columns = Math.max(1, Math.ceil(Math.sqrt(this.sources.length)));
      const rows = Math.max(1, Math.ceil(this.sources.length / columns));
      const resized = columns !== this.grid.x || rows !== this.grid.y || this.layoutCount < 0;
      this.layoutCount = this.sources.length;

      // Filling an unused cell keeps existing tiles and shader UVs valid.
      if (resized) {
        this.revisions.length = 0;
        this.needsInitialization = true;
        this.grid.set(columns, rows);
        const stride = this.tileSize + this.padding * 2;
        this.target.setSize(columns * stride, rows * stride);
        this.sources.forEach((_, i) => this.dirty.add(i));
        this._version++;
      }
    }

    if (!renderer) return;
    if (this.renderer && this.renderer !== renderer) {
      throw new Error('A TextureAtlas belongs to one renderer. Create another atlas for a different renderer.');
    }

    this.renderer = renderer;
    if (this.needsInitialization) {
      renderer.initRenderTarget(this.target);
      this.needsInitialization = false;
    }

    // Poll texture versions without submitting GPU work on unchanged frames.
    this.sources.forEach((source, index) => {
      if (this.revisions[index] !== source.version) this.dirty.add(index);
    });
    if (!this.dirty.size) return;

    // Baking can run inside a scene update; preserve the caller's render target state.
    const previous = renderer.getRenderTarget();
    const cubeFace = renderer.getActiveCubeFace?.() ?? 0;
    const mipmapLevel = renderer.getActiveMipmapLevel?.() ?? 0;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    const stride = this.tileSize + this.padding * 2;

    try {
      for (const index of this.dirty) {
        const source = this.sources[index];
        if (!TextureAtlas.canBake(source)) continue;

        this.quad.material = this.material(source, renderer);
        const x = index % this.grid.x * stride;
        const y = (this.grid.y - 1 - Math.floor(index / this.grid.x)) * stride;
        this.target.viewport.set(x, y, stride, stride);
        this.target.scissor.set(x, y, stride, stride);
        this.target.scissorTest = true;
        renderer.setRenderTarget(this.target);
        renderer.render(this.scene, this.camera);

        this.revisions[index] = source.version;
        this._version++;
        this.dirty.delete(index);
      }
    } finally {
      renderer.setRenderTarget(previous as THREE.WebGLRenderTarget | null, cubeFace, mipmapLevel);
      renderer.autoClear = autoClear;
    }
  }

  /** Marks a GPU-rendered or otherwise externally changed source for another bake. */
  invalidate(source?: THREE.Texture): void {
    if (!source) this.sources.forEach((_, index) => this.dirty.add(index));
    else {
      const index = this.aliases.get(source);
      if (index !== undefined) this.dirty.add(index);
    }
  }

  /** Interior UV rectangle, in bottom-left texture coordinates. */
  rect(tile: number, target = new THREE.Vector4()): THREE.Vector4 {
    const stride = this.tileSize + this.padding * 2;
    const width = this.grid.x * stride;
    const height = this.grid.y * stride;

    return target.set(
      (tile % this.grid.x * stride + this.padding) / width,
      ((this.grid.y - 1 - Math.floor(tile / this.grid.x)) * stride + this.padding) / height,
      this.tileSize / width,
      this.tileSize / height,
    );
  }

  /** TSL sampler with dynamic tile selection and tile-local wrapping. Adds no storage buffers. */
  sample(tile: Node<'float'> | number = 0, coordinates: Node<'vec2'> = uv()): ReturnType<typeof texture> {
    const stride = this.tileSize + this.padding * 2;
    const grid = this.gridNode;
    const selection = typeof tile === 'number' ? float(tile) : tile;
    const column = selection.mod(grid.x);
    const row = grid.y.sub(1).sub(selection.div(grid.x).floor());
    const pixel = vec2(column, row).mul(stride).add(this.padding);
    const point = pixel.add(coordinates.fract().mul(this.tileSize)).div(grid.mul(stride));

    return texture(this.texture, point);
  }

  private readonly gridNode = (() => {
    // Uniform references the mutable grid; callers can retain the sampler across repacks.
    return uniform(this.grid);
  })();

  private material(source: THREE.Texture, renderer: AtlasRenderer): THREE.Material {
    const image = source.image as { width: number; height: number };
    const size = `${image.width}:${image.height}`;
    const existing = this.materials.get(source);
    if (existing && this.imageSizes.get(source) === size) return existing;

    existing?.dispose();
    this.imageSizes.set(source, size);

    // Extend edge texels into the gutter; source transforms belong to the sampler.
    const border = this.padding / this.tileSize;
    const minimum = new THREE.Vector2(0.5 / image.width, 0.5 / image.height);
    const maximum = new THREE.Vector2(1 - minimum.x, 1 - minimum.y);

    let material: THREE.Material;
    if ('isWebGPURenderer' in renderer) {
      const sampleUV = uv().mul(1 + 2 * border).sub(border).clamp(vec2(minimum), vec2(maximum));
      const sample = texture(source, sampleUV);
      const nodeMaterial = new MeshBasicNodeMaterial();
      nodeMaterial.colorNode = sample.rgb;
      nodeMaterial.opacityNode = sample.a;
      material = nodeMaterial;
    } else {
      const basic = new THREE.MeshBasicMaterial({ map: source });
      // The injected edge clamp depends on dimensions, unlike Three.js's default map shader.
      basic.customProgramCacheKey = () => `rzmps.atlas:${border}:${size}`;
      basic.onBeforeCompile = shader => {
        shader.vertexShader = shader.vertexShader.replace(
          '#include <uv_vertex>',
          `#include <uv_vertex>
            vMapUv = clamp(uv * ${1 + 2 * border} - ${border},
              vec2(${minimum.x}, ${minimum.y}), vec2(${maximum.x}, ${maximum.y}));`,
        );
      };
      material = basic;
    }

    // Preserve source RGBA without lighting, blending or scene tone mapping.
    material.transparent = true;
    material.blending = THREE.NoBlending;
    material.depthTest = false;
    material.depthWrite = false;
    material.toneMapped = false;
    this.materials.set(source, material);
    return material;
  }

  /** Releases baked resources, retaining caller-owned source textures. */
  dispose(): void {
    this.target.dispose();
    this.geometry.dispose();
    this.materials.forEach(material => material.dispose());
    this.materials.clear();
    this.sources.length = 0;
    this.aliases.clear();
  }
}

