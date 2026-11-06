import { copyMaterialEnvironment, type MaterialEnvironment } from './Environment';
import {
  applyMaterialCopies, compositeGPU, type AppearanceNodes, type MaterialCompositeConfiguration,
} from './Composite';
import * as THREE from 'three';
import {
  attribute, float, texture, uniform, uniformArray, Fn, uv, vec2, vec3, vec4, positionGeometry,
  materialColor, materialOpacity, materialNormal, materialRoughness, materialMetalness,
} from 'three/tsl';
import type { Node, WebGPURenderer } from 'three/webgpu';
import TextureAtlas, { type TextureAtlasOptions } from '../TextureAtlas';
import { bindSurface, MaterialCopyRegistry, targetMaterial, type MaterialTarget, type SurfaceSample } from './Surface';
import type Particle from '../Particle';

const maps = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'alphaMap'] as const;
const columns = 2 + maps.length * 3;

/** Per-renderer atlas/palette owner. Uses texture bindings, never storage-buffer bindings. */
export default class Appearance {
  private static nextID = 0;
  private readonly id = Appearance.nextID++;
  readonly atlases: TextureAtlas[];
  readonly palette = new THREE.DataTexture(
    new Float32Array(columns * 4), columns, 1, THREE.RGBAFormat, THREE.FloatType,
  );
  readonly size = new THREE.Vector2(columns, 1);
  readonly defaultID = uniform(0);
  readonly mode = uniform(0);
  private revision = '';
  private registeredCount = 0;
  private layoutKey = '0:1';
  private environmentCount = -1;
  private commonEnvironment?: MaterialEnvironment;
  private readonly singlePalette = new Float32Array(columns * 4);
  private readonly singlePaletteValues = Array.from({ length: columns }, () => new THREE.Vector4());
  private readonly singlePaletteNode = uniformArray(this.singlePaletteValues, 'vec4');
  private readonly trackedMaterials = new Map<THREE.Material, { prefix: string; dispose: () => void }>();

  constructor(readonly registry: MaterialCopyRegistry,
    readonly configuration: () => MaterialCompositeConfiguration = () => ({}), atlasOptions: TextureAtlasOptions = {},
    readonly textureCopyQuality = 1) {
    this.atlases = maps.map((_, i) => new TextureAtlas({
      ...atlasOptions,
      tileSize: atlasOptions.tileSize === undefined ? undefined
        : Math.max(1, Math.ceil(atlasOptions.tileSize * textureCopyQuality)),
      colorSpace: i === 0 ? THREE.SRGBColorSpace : THREE.NoColorSpace,
    }));

    this.palette.magFilter = this.palette.minFilter = THREE.NearestFilter;
    this.palette.generateMipmaps = false;
    this.palette.needsUpdate = true;
  }

  get cacheKey(): string {
    return `rzmps.appearance:${this.id}:${this.configuration().version ?? 0}:${this.layoutKey}`;
  }

  /** Shared draw materials can inherit one compatible environment; decals select their exact binding. */
  environment(target?: MaterialTarget): MaterialEnvironment | undefined {
    const explicit = targetMaterial(target) as (THREE.Material & MaterialEnvironment) | undefined;
    if (explicit) return explicit.envMap ? explicit : undefined;

    if (this.environmentCount === this.registry.sources.length) return this.commonEnvironment;

    // Empty environment slots preserve the destination fallback; distinct captures cannot share one draw.
    this.environmentCount = this.registry.sources.length;
    this.commonEnvironment = undefined;

    for (const material of this.registry.sources) {
      const source = material as THREE.Material & MaterialEnvironment;

      if (!source.envMap) continue;

      const previous = this.commonEnvironment;
      const sameRotation = previous?.envMapRotation && source.envMapRotation
        ? previous.envMapRotation.equals(source.envMapRotation) : previous?.envMapRotation === source.envMapRotation;

      if (previous && (previous.envMap !== source.envMap || previous.envMapIntensity !== source.envMapIntensity
        || !sameRotation)) {
        this.commonEnvironment = undefined;
        return;
      }

      this.commonEnvironment = source;
    }

    return this.commonEnvironment;
  }

  /** Compile only populated atlas channels, leaving texture units available for lights and reflection maps. */
  trackMaterial(material: THREE.Material, prefix = 'copy'): void {
    if (this.trackedMaterials.has(material)) return;

    // Layout changes must invalidate node-material pipelines as well as GLSL shader defines.
    const previousKey = material.customProgramCacheKey;
    const cacheKey = () => `${previousKey.call(material)}:${this.cacheKey}`;
    material.customProgramCacheKey = cacheKey;

    const dispose = () => {
      if (material.customProgramCacheKey === cacheKey) material.customProgramCacheKey = previousKey;
      this.trackedMaterials.delete(material);
      material.removeEventListener('dispose', dispose);
    };

    this.trackedMaterials.set(material, { prefix, dispose });
    material.addEventListener('dispose', dispose);
    this.updateMapDefines(material, prefix);
  }

  private updateMapDefines(material: THREE.Material, prefix: string): void {
    const target = material as THREE.Material & { defines?: Record<string, unknown> };
    target.defines ??= {};
    let changed = false;

    // Each appearance owns its own macro namespace, including batched source materials.
    this.atlases.forEach((atlas, index) => {
      const name = `${prefix}Map${index}Enabled`;
      const enabled = atlas.sources.length > 0;

      if ((target.defines![name] !== undefined) === enabled) return;

      if (enabled) target.defines![name] = 1;
      else delete target.defines![name];

      changed = true;
    });

    // One source material uses uniforms instead of spending a texture unit on its palette.
    const single = `${prefix}SingleMaterialEnabled`;
    const enabled = this.registry.sources.length <= 2;
    if ((target.defines[single] !== undefined) !== enabled) {
      if (enabled) target.defines[single] = 1;
      else delete target.defines[single];

      changed = true;
    }

    if (changed) material.needsUpdate = true;
  }

  sync(target?: MaterialTarget, mode = 0, renderer?: THREE.WebGLRenderer | WebGPURenderer): void {
    this.mode.value = mode;
    this.defaultID.value = this.registry.register(targetMaterial(target));

    // Add only new snapshots; atlas updates separately detect revised source pixels.
    for (let id = this.registeredCount; id < this.registry.sources.length; id++) {
      const material = this.registry.sources[id] as THREE.MeshStandardMaterial;
      if (id) maps.forEach((key, channel) => {
        const source = material[key];
        if (source) this.atlases[channel].add(source, this.textureCopyQuality);
      });
    }

    this.registeredCount = this.registry.sources.length;
    const mapMask = this.atlases.reduce((mask, atlas, index) => mask | (atlas.sources.length ? 1 << index : 0), 0);
    const layout = `${mapMask}:${this.registry.sources.length <= 2 ? 1 : 0}`;

    if (layout !== this.layoutKey) {
      this.layoutKey = layout;
      for (const [material, { prefix }] of this.trackedMaterials) this.updateMapDefines(material, prefix);
    }

    this.atlases.forEach(atlas => atlas.update(renderer));

    const revision = `${this.registeredCount}:${this.atlases.map(atlas => atlas.version).join(':')}`;
    if (revision === this.revision) return;

    // Rebuild metadata only when snapshots, tile placement or baked content change.
    this.revision = revision;
    const data = new Float32Array(this.registry.sources.length * columns * 4);
    this.registry.sources.forEach((material, id) => {
      const m = material as THREE.MeshStandardMaterial;
      const put = (column: number, values: number[]) => data.set(values, (id * columns + column) * 4);
      put(0, [m.color?.r ?? 1, m.color?.g ?? 1, m.color?.b ?? 1, material.opacity]);
      put(1, [m.roughness ?? 1, m.metalness ?? 1, m.normalScale?.x ?? 1, m.normalScale?.y ?? 1]);

      maps.forEach((key, channel) => {
        const source = m[key];
        if (!id || !source || !this.atlases[channel].isBaked(source) || source.channel !== 0) return;

        if (key === 'normalMap' && m.normalMapType === THREE.ObjectSpaceNormalMap) return;

        const rect = this.atlases[channel].rect(this.atlases[channel].add(source, this.textureCopyQuality));
        put(2 + channel * 3, rect.toArray());
        const e = this.registry.transforms[id][key] ?? [...source.matrix.elements, source.wrapS, source.wrapT];
        put(3 + channel * 3, [e[0], e[3], e[6], e[9]]);
        put(4 + channel * 3, [e[1], e[4], e[7], e[10]]);
      });
    });

    // Three.js allocates immutable texture storage. A new palette height needs fresh GPU storage,
    // including when a previously empty collision subsystem receives its first material.
    if (this.palette.image.height !== this.registry.sources.length) this.palette.dispose();

    this.singlePalette.set(data.subarray(columns * 4, columns * 8));
    this.singlePaletteValues.forEach((value, index) => value.fromArray(this.singlePalette, index * 4));
    this.palette.image = { data, width: columns, height: this.registry.sources.length };
    this.size.set(columns, this.registry.sources.length);
    this.palette.needsUpdate = true;
  }

  /** Instance attributes are allocated only when copying is enabled. */
  attributes(geometry: THREE.BufferGeometry, particles: Particle[], instanced: boolean): void {
    const names = ['materialCopy', 'materialCopyU', 'materialCopyV'] as const;
    const first = geometry.getAttribute(names[0]) as THREE.InterleavedBufferAttribute | undefined;
    let data = first?.isInterleavedBufferAttribute ? first.data : undefined;
    if (!data || first!.count < particles.length) {
      const capacity = 2 ** Math.ceil(Math.log2(Math.max(1, particles.length)));
      const values = new Float32Array(capacity * 12);
      data = instanced ? new THREE.InstancedInterleavedBuffer(values, 12) : new THREE.InterleavedBuffer(values, 12);
      data.setUsage(THREE.DynamicDrawUsage);
      names.forEach((name, row) => {
        geometry.setAttribute(name, new THREE.InterleavedBufferAttribute(data!, 4, row * 4));
      });
    }
    particles.forEach((particle, index) => names.forEach((name, row) => {
      particle[name].toArray(data!.array, index * 12 + row * 4);
    }));
    data.needsUpdate = true;
  }

  nodes(
    binding: Node<'vec4'> = attribute('materialCopy', 'vec4'),
    rowU: Node<'vec4'> = attribute('materialCopyU', 'vec4'),
    rowV: Node<'vec4'> = attribute('materialCopyV', 'vec4'),
    offset?: Node<'vec3'>,
    coordinates?: Node<'vec2'>,
  ): AppearanceNodes {
    const selectedID = binding.x.greaterThan(0).select(binding.x, this.defaultID);
    const valid = selectedID.greaterThan(0).and(selectedID.lessThan(uniform(this.size).y));
    const id = valid.select(selectedID, float(0));
    // Decide the sampling layout when the shader builds, after sources have been registered.
    const read = (column: number): Node<'vec4'> => Fn(() => {
      if (this.registry.sources.length <= 2) {
        return id.greaterThan(0).select(this.singlePaletteNode.element(column), vec4(column < 2 ? 1 : 0));
      }

      return texture(this.palette, vec2(
        float(column + 0.5).div(columns), id.add(0.5).div(uniform(this.size).y),
      ));
    })() as Node<'vec4'>;

    // Meshes retain the birth-local frame. Billboards retain chart density and shear.
    const localOffset = offset ?? vec3(uv().sub(0.5), 0);
    const uLength = rowU.xyz.length().max(1e-8);
    const parallel = rowU.xyz.dot(rowV.xyz).div(uLength);
    const perpendicular = rowV.xyz.dot(rowV.xyz).sub(parallel.mul(parallel)).max(0).sqrt();
    const delta = offset ? vec2(rowU.xyz.dot(localOffset), rowV.xyz.dot(localOffset))
      : vec2(localOffset.x.mul(uLength), localOffset.x.mul(parallel).add(localOffset.y.mul(perpendicular)));
    const patchUV = binding.yz.add(delta);
    const hasPatch = rowU.xyz.length().add(rowV.xyz.length()).greaterThan(0);
    const mode = binding.w.notEqual(0).select(binding.w.max(0), this.mode);
    const impactUV = binding.x.greaterThan(0).select(binding.yz, vec2(0.5));
    const sampleUV = coordinates ?? mode.equal(1).select(impactUV,
      mode.equal(2).or(binding.x.lessThanEqual(0)).or(hasPatch.not()).select(uv(), patchUV));

    // Apply the source transform and wrapping within its atlas tile.
    const wrap = (value: Node<'float'>, mode: Node<'float'>) => mode.equal(THREE.RepeatWrapping).select(
      value.fract(), mode.equal(THREE.MirroredRepeatWrapping).select(
        float(1).sub(value.mod(2).sub(1).abs()), value.clamp(0, 1),
      ),
    );

    const sample = (channel: number, fallback: Node<'vec4'>): Node<'vec4'> => Fn(() => {
      if (!this.atlases[channel].sources.length) return fallback;

      const rect = read(2 + channel * 3);
      const u = read(3 + channel * 3);
      const v = read(4 + channel * 3);
      const input = vec3(sampleUV, 1);
      const coord = vec2(wrap(u.xyz.dot(input), u.w), wrap(v.xyz.dot(input), v.w));
      const value = texture(this.atlases[channel].texture, rect.xy.add(coord.mul(rect.zw)));
      return rect.z.greaterThan(0).select(value, fallback);
    })() as Node<'vec4'>;

    // Normal derivatives use the same chart as the copied normal map.
    const normalU = read(6);
    const normalV = read(7);
    const effectiveMode = binding.w.notEqual(0).select(binding.w.max(0), this.mode);
    const normalUV = effectiveMode.equal(1).select(uv(), vec2(
      normalU.xyz.dot(vec3(sampleUV, 1)), normalV.xyz.dot(vec3(sampleUV, 1)),
    ));
    const color = read(0);
    const parameters = read(1);

    const result: AppearanceNodes = {
      sourceUV: sampleUV, valid,
      resample: point => this.nodes(binding, rowU, rowV, offset, point),
      compositeGPU: (dest, destUV) => compositeGPU(result, dest, this.configuration().materialCompositeGPU, destUV),
      normalUV,
      color: sample(0, vec4(1)).rgb.mul(color.rgb),
      alpha: sample(0, vec4(1)).a.mul(sample(4, vec4(1)).g).mul(color.a),
      roughness: sample(2, vec4(1)).g.mul(parameters.x),
      metalness: sample(3, vec4(1)).b.mul(parameters.y),
      normal: sample(1, vec4(0.5, 0.5, 1, 1)).xyz.mul(2).sub(1)
        .mul(vec3(parameters.zw, 1)).normalize(),
    };
    return result;
  }

  /** Shared geometry adapter for persistent, non-instanced material consumers such as decals. */
  attach(material: THREE.Material, geometry: THREE.BufferGeometry, particle: Particle,
    sourceFrame: THREE.Matrix4, geometryFrame: THREE.Matrix4, surface?: SurfaceSample): Particle {
    const source = particle.clone();
    if (source.materialCopy.x <= 0 && this.defaultID.value <= 0 && surface?.material) {
      bindSurface(source, this.registry.register(surface.material), sourceFrame, surface, this.mode.value);
    }

    // Persistent geometry owns one material, so it can inherit its exact source environment.
    const environmentID = source.materialCopy.x || this.defaultID.value;
    const environment = this.registry.sources[environmentID] as THREE.Material & MaterialEnvironment | undefined;
    if (environment?.envMap) copyMaterialEnvironment(material, environment);

    this.trackMaterial(material);

    const binding = source.clone();
    const change = sourceFrame.clone().invert().multiply(geometryFrame);
    const e = change.elements;
    const column = (i: number) => new THREE.Vector3(e[i], e[i + 1], e[i + 2]);
    const u = new THREE.Vector3().copy(source.materialCopyU);
    const v = new THREE.Vector3().copy(source.materialCopyV);
    const shift = column(12);
    binding.materialCopy.y += u.dot(shift);
    binding.materialCopy.z += v.dot(shift);
    binding.materialCopyU.set(u.dot(column(0)), u.dot(column(4)), u.dot(column(8)), 0);
    binding.materialCopyV.set(v.dot(column(0)), v.dot(column(4)), v.dot(column(8)), 0);
    this.attributes(geometry, Array(geometry.getAttribute('position').count).fill(binding), false);

    const previous = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      previous.call(material, shader, renderer);
      this.shader(shader, true);
    };
    material.customProgramCacheKey = () => this.cacheKey;
    // Composition replaces the RGB color node, so carry diffuse-map alpha into opacity explicitly.
    // Three's materialOpacity includes alphaMap, but diffuse-map alpha normally comes from materialColor.
    const diffuseMap = (material as THREE.MeshStandardMaterial).map;
    const opacity = diffuseMap ? materialOpacity.mul(texture(diffuseMap).a) : materialOpacity;
    applyMaterialCopies(material, [this.nodes(undefined, undefined, undefined, positionGeometry)], {
      color: materialColor, opacity, normal: materialNormal,
      roughness: materialRoughness, metalness: materialMetalness,
    });
    material.needsUpdate = true;
    return source;
  }

  /** Installs matching WebGL uniforms and sampling functions. */
  shader(shader: {
    vertexShader: string; fragmentShader: string; uniforms: Record<string, unknown>;
  }, mesh: boolean): void {
    if ('isMaterial' in shader) this.trackMaterial(shader as unknown as THREE.Material);

    Object.assign(shader.uniforms, {
      copyPalette: { value: this.palette }, copySinglePalette: { value: this.singlePalette },
      copySize: { value: this.size },
      copyDefault: this.defaultID, copyMode: this.mode,
    });
    this.atlases.forEach((atlas, i) => { shader.uniforms[`copyMap${i}`] = { value: atlas.texture }; });

    // Pass the per-particle binding and birth-local frame to the fragment stage.
    shader.vertexShader = `
      attribute vec4 materialCopy;
      attribute vec4 materialCopyU;
      attribute vec4 materialCopyV;
      varying vec4 vMaterialCopy;
      varying vec4 vMaterialCopyU;
      varying vec4 vMaterialCopyV;
      varying vec3 vCopyOffset;
      varying vec3 vCopyViewPosition;
      varying vec2 vCopyUV;
      ${shader.vertexShader}`;
    shader.vertexShader = shader.vertexShader.replace(/void main\s*\(\s*\)\s*\{/, `void main() {
      vMaterialCopy = materialCopy;
      vMaterialCopyU = materialCopyU;
      vMaterialCopyV = materialCopyV;
      vCopyOffset = position;
      vCopyUV = ${mesh ? 'uv' : 'position.xy + 0.5'};
    `);

    if (mesh) {
      shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>',
        '#include <project_vertex>\nvCopyViewPosition = mvPosition.xyz;');
    } else {
      const end = shader.vertexShader.lastIndexOf('}');
      const viewPosition = `
        #ifdef USE_INSTANCING
          vCopyViewPosition = (modelViewMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
        #else
          vCopyViewPosition = (modelViewMatrix * vec4(position, 1.0)).xyz;
        #endif
      `;
      shader.vertexShader = shader.vertexShader.slice(0, end) + viewPosition + shader.vertexShader.slice(end);
    }

    if (this.configuration().materialComposite) {
      shader.fragmentShader = this.glsl(mesh) + shader.fragmentShader;
      this.compositeShader(shader, mesh);
      return;
    }

    // Multiply destination factors so neutral white/one values preserve the source.
    shader.fragmentShader = this.glsl(mesh) + shader.fragmentShader;
    if (mesh) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <color_fragment>', `#include <color_fragment>
          diffuseColor *= copyColor();`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor *= copyRoughness();`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
          metalnessFactor *= copyMetalness();`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          normal = copyBlendNormal(normal, copyNormal(), -vViewPosition, copyNormalUV(copyUV()));`);
    } else {
      shader.fragmentShader = shader.fragmentShader
        .replace('vec4 textureColor =', `
          copyFragmentOffset = vec3(rotatedLocalCoord - 0.5, 0.0);
          copyFragmentUV = rotatedLocalCoord;
          vec4 textureColor =`)
        .replace('vColor * textureColor;', 'vColor * textureColor * copyColor();')
        .replace('roughnessValue = clamp(', 'roughnessValue *= copyRoughness();\nroughnessValue = clamp(')
        .replace('metalnessValue = clamp(', 'metalnessValue *= copyMetalness();\nmetalnessValue = clamp(')
        .replace('vec3 viewDirection =', `
          normal = copyBlendNormal(normal, copyNormal(), -vViewPosition, copyNormalUV(copyUV()));
          vec3 viewDirection =`);
    }
  }

  private compositeShader(shader: { fragmentShader: string; uniforms: Record<string, unknown> }, mesh: boolean): void {
    const source = (channel: import('./Composite').MaterialChannel, point: string) => {
      if (channel === 'color') return `(copyRead(0.0).rgb * copySampleAt0(vec4(1.0), ${point}).rgb)`;

      if (channel === 'opacity') return `(copyRead(0.0).a * copySampleAt0(vec4(1.0), ${point}).a
        * copySampleAt4(vec4(1.0), ${point}).g)`;
      if (channel === 'roughness') return `(copyRead(1.0).x * copySampleAt2(vec4(1.0), ${point}).g)`;

      if (channel === 'metalness') return `(copyRead(1.0).y * copySampleAt3(vec4(1.0), ${point}).b)`;

      return `copyBlendNormal(compositeDestNormal,
        normalize((copySampleAt1(vec4(0.5,0.5,1.0,1.0), ${point}).xyz * 2.0 - 1.0)
          * vec3(copyRead(1.0).zw, 1.0)), ${viewPosition}, copyNormalUV(${point}))`;
    };
    const lit = mesh ? shader.fragmentShader.includes('#include <normal_fragment_maps>')
      : shader.fragmentShader.includes('vec3 viewDirection =');
    const physical = mesh && shader.fragmentShader.includes('#include <lights_physical_fragment>');
    const hasSurfaceParameters = lit && (!mesh || physical);
    const viewPosition = lit ? '-vViewPosition' : mesh ? 'vCopyViewPosition' : 'copyFragmentViewPosition';
    const baseNormal = lit ? 'normal' : mesh
      ? 'normalize(cross(dFdx(vCopyViewPosition), dFdy(vCopyViewPosition)))' : 'vec3(0.,0.,1.)';
    const color = mesh ? 'diffuseColor' : 'baseColor';
    const dest = { color: 'compositeDestColor', opacity: 'compositeDestOpacity', normal: 'compositeDestNormal',
      roughness: 'compositeDestRoughness', metalness: 'compositeDestMetalness' };
    const functions = new Map<string, string>();
    const destination = this.destinationSampler(shader, mesh, dest);
    const copy = Object.fromEntries(Object.keys(dest).map(channel => [channel,
      `(copyHasSource() ? ${source(channel as import('./Composite').MaterialChannel,
        'copyUV()')} : ${dest[channel as keyof typeof dest]})`])) as typeof dest;
    const output = this.configuration().materialComposite!(copy, dest, {
      sourceUV: 'copyUV()', destUV: mesh ? 'vCopyUV' : 'spriteCoord',
      geometricNormal: lit ? mesh ? 'nonPerturbedNormal' : 'normalize(vNormal)' : baseNormal,
      destMapAlpha: destination.alpha,
      sampleSource: (channel, coordinates) => `(copyHasSource() ? ${source(channel, coordinates)} : ${dest[channel]})`,
      sampleDest: (channel, coordinates) => destination.sample(channel, coordinates),
      function: (name, code) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /^(copy[A-Z]|compositeDest)/.test(name)) {
          throw new Error(`Invalid or reserved material composite function name: ${name}`);
        }
        if (functions.has(name) && functions.get(name) !== code) {
          throw new Error(`Conflicting material composite function: ${name}`);
        }
        functions.set(name, code);
      },
    });
    const opacityFactor = mesh && shader.fragmentShader.includes('varying float vInstanceAlpha;')
      ? ' * vInstanceAlpha' : '';
    let block = `compositeDestColor = ${color}.rgb; compositeDestOpacity = ${color}.a${opacityFactor};
      compositeDestNormal = ${baseNormal};
      compositeDestRoughness = ${hasSurfaceParameters ? mesh ? 'roughnessFactor' : 'roughnessValue' : '1.0'};
      compositeDestMetalness = ${hasSurfaceParameters ? mesh ? 'metalnessFactor' : 'metalnessValue' : '0.0'};`;
    if (!mesh && !lit) block += `
      #ifndef USE_POINT_SPRITE
        compositeDestNormal = normalize(cross(dFdx(vCopyViewPosition), dFdy(vCopyViewPosition)));
      #endif
    `;
    if (output.color !== undefined) block += `\n${color}.rgb = ${output.color};`;

    if (output.opacity !== undefined) block += `\n${color}.a = ${output.opacity};`;
    else if (opacityFactor) block += `\n${color}.a = compositeDestOpacity;`;
    if (lit && output.normal !== undefined) block += `\nnormal = normalize(${output.normal});`;

    if (hasSurfaceParameters && output.roughness !== undefined) {
      block += `\n${mesh ? 'roughnessFactor' : 'roughnessValue'} = ${output.roughness};`;
    }
    if (hasSurfaceParameters && output.metalness !== undefined) {
      block += `\n${mesh ? 'metalnessFactor' : 'metalnessValue'} = ${output.metalness};`;
    }
    shader.fragmentShader = shader.fragmentShader.replace('gl_FragColor.a *= vInstanceAlpha;', '');
    if (mesh) {
      const marker = lit ? physical ? '#include <lights_physical_fragment>' : '#include <lights_fragment_begin>'
        : '#include <alphatest_fragment>';
      if (lit) {
        shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', '')
          .replace('#include <alphahash_fragment>', '');
        block += '\n#include <alphatest_fragment>\n#include <alphahash_fragment>\n';
      }
      shader.fragmentShader = shader.fragmentShader.replace(marker, block + '\n' + marker);
    } else {
      shader.fragmentShader = shader.fragmentShader.replace('vec4 textureColor =', `
        copyFragmentOffset = vec3(rotatedLocalCoord - 0.5, 0.0);
        copyFragmentUV = rotatedLocalCoord;
        #ifdef USE_POINT_SPRITE
          copyFragmentViewPosition = copyFragmentOffset;
        #else
          copyFragmentViewPosition = vCopyViewPosition;
        #endif
        vec4 textureColor =`);
      const discard = /if \(baseColor\.a <= 0\.0\)\s*discard;/;
      if (lit) {
        shader.fragmentShader = shader.fragmentShader.replace(discard, '');
        shader.fragmentShader = shader.fragmentShader.replace('    float shininess =', block
          + '\nif (baseColor.a <= 0.0) discard;\n    float shininess =');
      } else {
        shader.fragmentShader = shader.fragmentShader.replace(/float finalAlpha\s*=/, block + '\nfloat finalAlpha =');
      }
    }
    shader.fragmentShader = `vec3 compositeDestColor; float compositeDestOpacity; vec3 compositeDestNormal;
      float compositeDestRoughness; float compositeDestMetalness;
      bool copyHasSource() {
        float id = vMaterialCopy.x > 0.0 ? vMaterialCopy.x : copyDefault;
        return id > 0.0 && id < copySize.y;
      }
      ${destination.declarations}\n${[...functions.values()].join('\n')}\n` + shader.fragmentShader;
    // Place declarations after shared sampling uniforms/functions, before main, preserving GLSL declaration order.
    const prefixEnd = shader.fragmentShader.indexOf('#ifdef copySingleMaterialEnabled');
    if (prefixEnd > 0) {
      const helper = shader.fragmentShader.slice(0, prefixEnd);
      shader.fragmentShader = shader.fragmentShader.slice(prefixEnd);
      shader.fragmentShader = shader.fragmentShader.replace(/void main/, helper + 'void main');
    }
  }

  private destinationSampler(shader: { uniforms: Record<string, unknown> }, mesh: boolean,
    dest: import('./Composite').MaterialChannels) {
    const definitions: string[] = [];
    const declaredTextures = new Set<string>();
    const channels = new Map<import('./Composite').MaterialChannel, string>();
    const texture = (name: string, point: string) => {
      // Helpers are inserted after the material uniforms, so they can reuse the original sampler.
      const matrix = `compositeDest_${name}Transform`;
      shader.uniforms[matrix] = shader.uniforms[`${name}Transform`] ?? { value: new THREE.Matrix3() };
      if (!declaredTextures.has(name)) {
        definitions.push(`uniform mat3 ${matrix};`);
        declaredTextures.add(name);
      }
      return `texture2D(${name}, (${matrix} * vec3(${point}, 1.0)).xy)`;
    };
    if (mesh && shader.uniforms.diffuse) {
      const map = texture('map', 'point');
      const alphaMap = texture('alphaMap', 'point');
      definitions.push(`vec3 compositeDestColorAt(vec2 point) {
        vec3 value = diffuse;
        #if defined(USE_COLOR) || defined(USE_COLOR_ALPHA)
          value *= vColor.rgb;
        #endif
        #ifdef USE_MAP
          value *= ${map}.rgb;
        #endif
        return value;
      }
      float compositeDestOpacityAt(vec2 point) {
        float value = opacity;
        #ifdef USE_COLOR_ALPHA
          value *= vColor.a;
        #endif
        #ifdef USE_MAP
          value *= ${map}.a;
        #endif
        #ifdef USE_ALPHAMAP
          value *= ${alphaMap}.g;
        #endif
        return value;
      }`);
      channels.set('color', 'compositeDestColorAt'); channels.set('opacity', 'compositeDestOpacityAt');
      for (const [channel, component] of [['roughness', 'g'], ['metalness', 'b']] as const) {
        if (!shader.uniforms[channel]) continue;

        const sample = texture(`${channel}Map`, 'point');
        const name = `compositeDest${channel === 'roughness' ? 'Roughness' : 'Metalness'}At`;
        definitions.push(`float ${name}(vec2 point) {
          float value = ${channel};
          #ifdef USE_${channel.toUpperCase()}MAP
            value *= ${sample}.${component};
          #endif
          return value;
        }`);
        channels.set(channel, name);
      }
    } else if (!mesh && shader.uniforms.pointTexture) {
      const map = texture('pointTexture', 'point');
      definitions.push(`vec3 compositeDestColorAt(vec2 point) { return vColor.rgb * ${map}.rgb; }
        float compositeDestOpacityAt(vec2 point) { return vColor.a * ${map}.a; }`);
      channels.set('color', 'compositeDestColorAt'); channels.set('opacity', 'compositeDestOpacityAt');
    }
    const alpha = ['normalMap', 'roughnessMap', 'metalnessMap'].map(name => {
      const sample = texture(name, 'point');
      return `#ifdef USE_${name.toUpperCase()}\nvalue *= ${sample}.a;\n#endif`;
    }).join('\n');
    definitions.push(`float compositeDestMapAlpha(vec2 point) {\nfloat value = 1.0;\n${alpha}\nreturn value;\n}`);
    return { declarations: definitions.join('\n'), alpha: `compositeDestMapAlpha(${mesh ? 'vCopyUV' : 'spriteCoord'})`,
      sample: (channel: import('./Composite').MaterialChannel, point: string) => channels.has(channel)
        ? `${channels.get(channel)}(${point})` : dest[channel] };
  }

  private glsl(mesh: boolean): string {
    const samplers = this.atlases.map((_, i) => `
      #ifdef copyMap${i}Enabled
        uniform sampler2D copyMap${i};
      #endif
    `).join('\n');

    const samples = this.atlases.map((_, i) => `
      vec4 copySampleAt${i}(vec4 fallback, vec2 coordinates) {
        #ifndef copyMap${i}Enabled
          return fallback;
        #else
        vec4 r = copyRead(${2 + i * 3}.0);
        if(r.z == 0.0) return fallback;
        vec3 p = vec3(coordinates, 1.0);
        vec4 u = copyRead(${3 + i * 3}.0);
        vec4 v = copyRead(${4 + i * 3}.0);
        vec2 point = vec2(copyWrap(dot(u.xyz, p), u.w), copyWrap(dot(v.xyz, p), v.w));
        return texture2D(copyMap${i}, r.xy + r.zw * point);
        #endif
      }
      vec4 copySample${i}(vec4 fallback) { return copySampleAt${i}(fallback, copyUV()); }
    `).join('\n');

    return `
      #ifdef copySingleMaterialEnabled
        uniform vec4 copySinglePalette[${columns}];
      #else
        uniform sampler2D copyPalette;
      #endif
      uniform vec2 copySize;
      uniform float copyDefault;
      uniform float copyMode;
      ${samplers}
      varying vec4 vMaterialCopy;
      varying vec4 vMaterialCopyU;
      varying vec4 vMaterialCopyV;
      varying vec3 vCopyOffset;
      varying vec3 vCopyViewPosition;
      varying vec2 vCopyUV;
      ${mesh ? '' : 'vec3 copyFragmentOffset; vec2 copyFragmentUV; vec3 copyFragmentViewPosition;'}
      vec4 copyRead(float column) {
        float id = vMaterialCopy.x > 0.0 ? vMaterialCopy.x : copyDefault;
        if (!(id > 0.0 && id < copySize.y)) id = 0.0;

        #ifdef copySingleMaterialEnabled
          if (id < 0.5) return column < 2.0 ? vec4(1.0) : vec4(0.0);
          return copySinglePalette[int(column)];
        #else
          return texture2D(copyPalette, vec2((column + 0.5) / copySize.x, (id + 0.5) / copySize.y));
        #endif
      }
      float copyWrap(float v, float mode) {
        if(mode == ${THREE.RepeatWrapping}.0) return fract(v);
        if(mode == ${THREE.MirroredRepeatWrapping}.0) return 1.0 - abs(mod(v, 2.0) - 1.0);
        return clamp(v, 0.0, 1.0);
      }
      vec2 copyUV() {
        float mode = vMaterialCopy.w != 0.0 ? max(vMaterialCopy.w, 0.0) : copyMode;
        if(mode == 1.0) return vMaterialCopy.x > 0.0 ? vMaterialCopy.yz : vec2(0.5);
        float extent = length(vMaterialCopyU.xyz) + length(vMaterialCopyV.xyz);
        if(mode == 2.0 || vMaterialCopy.x <= 0.0 || extent == 0.0) {
          return ${mesh ? 'vCopyUV' : 'copyFragmentUV'};
        }
        vec3 offset = ${mesh ? 'vCopyOffset' : 'copyFragmentOffset'};
        ${mesh ? `return vMaterialCopy.yz + vec2(
          dot(vMaterialCopyU.xyz, offset), dot(vMaterialCopyV.xyz, offset));`
    : `float uLength = max(length(vMaterialCopyU.xyz), 1e-8);
        float parallel = dot(vMaterialCopyU.xyz, vMaterialCopyV.xyz) / uLength;
        float perpendicular = sqrt(max(dot(vMaterialCopyV.xyz, vMaterialCopyV.xyz) - parallel * parallel, 0.0));
        return vMaterialCopy.yz + vec2(offset.x * uLength, offset.x * parallel + offset.y * perpendicular);`}
      }
      ${samples}
      vec2 copyNormalUV(vec2 point) {
        float mode = vMaterialCopy.w != 0.0 ? max(vMaterialCopy.w, 0.0) : copyMode;
        if (mode == 1.0) return ${mesh ? 'vCopyUV' : 'copyFragmentUV'};

        return vec2(dot(copyRead(6.0).xyz, vec3(point,1.0)), dot(copyRead(7.0).xyz, vec3(point,1.0)));
      }
      vec4 copyColor() {
        vec4 c = copyRead(0.0) * copySample0(vec4(1.0));
        c.a *= copySample4(vec4(1.0)).g;
        return c;
      }
      float copyRoughness() { return copyRead(1.0).x * copySample2(vec4(1.0)).g; }
      float copyMetalness() { return copyRead(1.0).y * copySample3(vec4(1.0)).b; }
      vec3 copyNormal() {
        vec3 n = copySample1(vec4(0.5, 0.5, 1.0, 1.0)).xyz * 2.0 - 1.0;
        return normalize(n * vec3(copyRead(1.0).zw, 1.0));
      }
      vec3 copyBlendNormal(vec3 base, vec3 detail, vec3 viewPosition, vec2 point) {
        vec3 q0 = dFdx(viewPosition), q1 = dFdy(viewPosition);
        vec2 st0 = dFdx(point), st1 = dFdy(point);
        vec3 t = q0 * st1.y - q1 * st0.y;
        vec3 b = -q0 * st1.x + q1 * st0.x;
        float scale = inversesqrt(max(max(dot(t, t), dot(b, b)), 1e-12));
        return normalize(t * (detail.x * scale) + b * (detail.y * scale) + base * detail.z);
      }
    `;
  }

  dispose(): void {
    for (const { dispose } of this.trackedMaterials.values()) dispose();
    this.trackedMaterials.clear();

    this.palette.dispose();
    this.atlases.forEach(atlas => atlas.dispose());
  }
}
