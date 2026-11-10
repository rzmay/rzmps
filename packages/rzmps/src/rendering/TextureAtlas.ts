import * as THREE from 'three';
import { MeshBasicNodeMaterial, type Node, type WebGPURenderer } from 'three/webgpu';
import { float, texture, uniform, uv, vec2 } from 'three/tsl';

export interface TextureAtlasOptions {
  /** Minimum reserved tile count, rounded up to power-of-two capacity. Default 0 allocates lazily. */
  minCapacity?: number;
  /** Fixed interior tile resolution. Omit to preserve source resolution up to maxTileSize. */
  tileSize?: number;
  /** Maximum automatically selected interior tile resolution. Default 2048. */
  maxTileSize?: number;
  /** Extruded border. Mipmaps are disabled to prevent cross-tile bleeding. */
  padding?: number;
  colorSpace?: THREE.ColorSpace;
}

type AtlasRenderer = THREE.WebGLRenderer | WebGPURenderer;

/** GPU-baked equal-tile atlas. Source textures remain owned by the caller. */
export default class TextureAtlas {
  readonly minCapacity: number;
  readonly maxTileSize: number;
  private readonly fixedTileSize?: number;
  private _tileSize = 1;
  private readonly tileSizeNode = uniform(1);
  private readonly bakeBorder = { value: 0 };
  private readonly resolutionScales: number[] = [];
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
  private needsInitialization = true;

  constructor(options: TextureAtlasOptions = {}) {
    if (options.tileSize !== undefined && (!Number.isFinite(options.tileSize) || options.tileSize < 1)) {
      throw new RangeError('TextureAtlas tileSize must be a positive finite number.');
    }

    if (!Number.isFinite(options.maxTileSize ?? 2048) || (options.maxTileSize ?? 2048) < 1) {
      throw new RangeError('TextureAtlas maxTileSize must be a positive finite number.');
    }

    if (!Number.isFinite(options.padding ?? 2) || (options.padding ?? 2) < 0) {
      throw new RangeError('TextureAtlas padding must be a nonnegative finite number.');
    }

    if (!Number.isFinite(options.minCapacity ?? 0) || (options.minCapacity ?? 0) < 0) {
      throw new RangeError('TextureAtlas minCapacity must be a nonnegative finite number.');
    }

    this.minCapacity = Math.ceil(options.minCapacity ?? 0);
    this.fixedTileSize = options.tileSize === undefined ? undefined : Math.floor(options.tileSize);
    this.maxTileSize = Math.floor(options.maxTileSize ?? 2048);
    this._tileSize = this.fixedTileSize ?? 1;
    this.tileSizeNode.value = this._tileSize;
    this.padding = Math.max(1, Math.floor(options.padding ?? 2));

    this.bakeBorder.value = this.padding / this.tileSize;

    // An explicit minimum reserves layout immediately and GPU storage on the first renderer update.
    const capacity = THREE.MathUtils.ceilPowerOfTwo(Math.max(1, this.minCapacity));
    const columns = 2 ** Math.ceil(Math.log2(capacity) / 2);
    this.grid.set(columns, capacity / columns);
    const stride = this.tileSize + this.padding * 2;
    this.target = new THREE.WebGLRenderTarget(
      this.minCapacity ? this.grid.x * stride : 1,
      this.minCapacity ? this.grid.y * stride : 1,
      {
        depthBuffer: false,
        stencilBuffer: false,
        magFilter: THREE.LinearFilter,
        minFilter: THREE.LinearFilter,
        generateMipmaps: false,
        colorSpace: options.colorSpace ?? THREE.SRGBColorSpace,
      },
    );

    this.camera.position.z = 1;
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  get tileSize(): number {
    return this._tileSize;
  }

  /** Dynamic padding for consumers whose shader graph outlives atlas resolution changes. */
  get insetNode(): Node<'float'> {
    return float(this.padding).div(this.tileSizeNode.add(this.padding * 2));
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

  /** Stable tile index. Aliases retain the highest requested resolution scale for that source. */
  add(source: THREE.Texture, resolutionScale = 1): number {
    if (!Number.isFinite(resolutionScale) || resolutionScale <= 0 || resolutionScale > 1) {
      throw new RangeError('TextureAtlas resolutionScale must be greater than 0 and at most 1.');
    }

    if (source === this.texture) throw new Error('An atlas cannot sample its own render target.');

    const existing = this.aliases.get(source);
    if (existing !== undefined) {
      this.resolutionScales[existing] = Math.max(this.resolutionScales[existing], resolutionScale);
      return existing;
    }

    const index = this.sources.length;
    this.sources.push(source);
    this.resolutionScales.push(resolutionScale);
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
    // Loaded image dimensions can change without adding another source (for example TextureLoader completion).
    let desiredSize = this.fixedTileSize ?? this.tileSize;
    this.sources.forEach((source, index) => {
      if (this.revisions[index] !== source.version) this.dirty.add(index);

      if (!TextureAtlas.canBake(source)) return;

      const { width, height } = source.image as { width: number; height: number };
      if (this.imageSizes.get(source) !== `${width}:${height}`) this.dirty.add(index);

      if (this.fixedTileSize === undefined) {
        desiredSize = Math.max(desiredSize,
          Math.min(this.maxTileSize, Math.ceil(Math.max(width, height) * this.resolutionScales[index])));
      }
    });

    // Reserve spare cells geometrically, retaining layout until its capacity is exceeded.
    const count = this.sources.length;
    let columns = this.grid.x;
    let rows = this.grid.y;
    if (count > columns * rows || (count > 0 && this.target.width === 1)) {
      const reserved = THREE.MathUtils.ceilPowerOfTwo(Math.max(this.minCapacity, count + 1));
      columns = 2 ** Math.ceil(Math.log2(reserved) / 2);
      rows = reserved / columns;
    }

    // The cap is per tile; also respect the backend's limit for the complete padded atlas.
    let maximum = Infinity;
    if (renderer && 'isWebGPURenderer' in renderer) {
      maximum = (renderer.backend as { device?: { limits: { maxTextureDimension2D: number } } })
        ?.device?.limits.maxTextureDimension2D ?? Infinity;
    } else if (renderer) maximum = renderer.capabilities?.maxTextureSize ?? Infinity;

    const tileLimit = Math.floor(maximum / Math.max(columns, rows)) - this.padding * 2;
    if (tileLimit < 1) throw new RangeError('TextureAtlas capacity exceeds the renderer texture-size limit.');

    desiredSize = Math.min(desiredSize, tileLimit);

    const stride = desiredSize + this.padding * 2;
    const allocated = count > 0 || this.minCapacity > 0;
    if (desiredSize !== this.tileSize || columns !== this.grid.x || rows !== this.grid.y
      || (allocated && this.target.width !== columns * stride)) {
      this._tileSize = desiredSize;
      this.tileSizeNode.value = desiredSize;
      this.bakeBorder.value = this.padding / desiredSize;
      this.grid.set(columns, rows);
      this.target.setSize(columns * stride, rows * stride);
      this.revisions.length = 0;
      this.needsInitialization = true;
      this.sources.forEach((_, index) => this.dirty.add(index));
      this._version++;
    }

    if (!renderer) return;
    if (this.renderer && this.renderer !== renderer) {
      throw new Error('A TextureAtlas belongs to one renderer. Create another atlas for a different renderer.');
    }

    this.renderer = renderer;

    // Empty channels stay lazy unless the caller explicitly requested preallocated storage.
    if (!this.sources.length && !this.minCapacity) return;

    const previous = renderer.getRenderTarget();
    const cubeFace = renderer.getActiveCubeFace?.() ?? 0;
    const mipmapLevel = renderer.getActiveMipmapLevel?.() ?? 0;

    if (this.needsInitialization) {
      renderer.initRenderTarget(this.target);
      // WebGL allocation changes the framebuffer binding even for an empty atlas.
      // Restore it before the unchanged/empty-atlas early return below.
      renderer.setRenderTarget(previous as THREE.WebGLRenderTarget | null, cubeFace, mipmapLevel);
      this.needsInitialization = false;
    }

    if (!this.dirty.size) return;

    // Baking can run inside a scene update; preserve the caller's render target state.
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    const bakeStride = this.tileSize + this.padding * 2;

    try {
      for (const index of this.dirty) {
        const source = this.sources[index];
        if (!TextureAtlas.canBake(source)) continue;

        this.quad.material = this.material(source, renderer);
        const x = index % this.grid.x * bakeStride;
        const y = (this.grid.y - 1 - Math.floor(index / this.grid.x)) * bakeStride;
        this.target.viewport.set(x, y, bakeStride, bakeStride);
        this.target.scissor.set(x, y, bakeStride, bakeStride);
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
    const stride = this.tileSizeNode.add(this.padding * 2);
    const grid = this.gridNode;
    const selection = typeof tile === 'number' ? float(tile) : tile;
    const column = selection.mod(grid.x);
    const row = grid.y.sub(1).sub(selection.div(grid.x).floor());
    const pixel = vec2(column, row).mul(stride).add(this.padding);
    const point = pixel.add(coordinates.fract().mul(this.tileSizeNode)).div(grid.mul(stride));

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
    const border = float(this.padding).div(this.tileSizeNode);
    const minimum = new THREE.Vector2(0.5 / image.width, 0.5 / image.height);
    const maximum = new THREE.Vector2(1 - minimum.x, 1 - minimum.y);

    let material: THREE.Material;
    if ('isWebGPURenderer' in renderer) {
      // Native WebGPU samples texture row zero at the top, including render targets.
      // Bake row zero from source v=0 so aliases retain the source UV convention on either backend.
      const coordinates = renderer.coordinateSystem === THREE.WebGPUCoordinateSystem ? uv().flipY() : uv();
      const sampleUV = coordinates.mul(border.mul(2).add(1)).sub(border).clamp(vec2(minimum), vec2(maximum));
      const sample = texture(source, sampleUV);
      const nodeMaterial = new MeshBasicNodeMaterial();
      nodeMaterial.colorNode = sample.rgb;
      nodeMaterial.opacityNode = sample.a;
      material = nodeMaterial;
    } else {
      const basic = new THREE.MeshBasicMaterial({ map: source });
      // Keep dimensions in uniforms so differently sized images reuse the same bake program.
      basic.customProgramCacheKey = () => 'rzmps.atlas';
      basic.onBeforeCompile = shader => {
        Object.assign(shader.uniforms, {
          atlasBorder: this.bakeBorder,
          atlasMinimum: { value: minimum },
          atlasMaximum: { value: maximum },
        });
        shader.vertexShader = `uniform float atlasBorder;\n${shader.vertexShader}`;
        shader.fragmentShader = 'uniform vec2 atlasMinimum;\n'
          + `uniform vec2 atlasMaximum;\n${shader.fragmentShader}`;
        shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>',
          THREE.ShaderChunk.map_fragment.replaceAll('vMapUv', 'clamp(vMapUv, atlasMinimum, atlasMaximum)'));
        shader.vertexShader = shader.vertexShader.replace(
          '#include <uv_vertex>',
          `#include <uv_vertex>
            vMapUv = uv * (1.0 + 2.0 * atlasBorder) - atlasBorder;`,
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
    this.resolutionScales.length = 0;
    this.revisions.length = 0;
    this.imageSizes.clear();
    this.dirty.clear();
  }
}
