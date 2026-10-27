import * as THREE from 'three';
import {
  attribute, float, texture, uniform, uv, vec2, vec3, vec4,
} from 'three/tsl';
import type { Node, WebGPURenderer } from 'three/webgpu';
import TextureAtlas from '../TextureAtlas';
import { MaterialCopyRegistry, targetMaterial, type MaterialTarget } from './Surface';
import type Particle from '../Particle';

const maps = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'alphaMap'] as const;
const columns = 2 + maps.length * 3;

/** Per-renderer atlas/palette owner. Uses texture bindings, never storage-buffer bindings. */
export default class Appearance {
  readonly atlases = maps.map((_, i) => new TextureAtlas({
    colorSpace: i === 0 ? THREE.SRGBColorSpace : THREE.NoColorSpace,
  }));
  readonly palette = new THREE.DataTexture(
    new Float32Array(columns * 4), columns, 1, THREE.RGBAFormat, THREE.FloatType,
  );
  readonly size = new THREE.Vector2(columns, 1);
  readonly defaultID = uniform(0);
  readonly mode = uniform(0);
  private revision = '';
  private registeredCount = 0;

  constructor(readonly registry: MaterialCopyRegistry) {
    this.palette.magFilter = this.palette.minFilter = THREE.NearestFilter;
    this.palette.generateMipmaps = false;
    this.palette.needsUpdate = true;
  }

  sync(target?: MaterialTarget, mode = 0, renderer?: THREE.WebGLRenderer | WebGPURenderer): void {
    this.mode.value = mode;
    this.defaultID.value = this.registry.register(targetMaterial(target));

    // Add only new snapshots; atlas updates separately detect revised source pixels.
    for (let id = this.registeredCount; id < this.registry.sources.length; id++) {
      const material = this.registry.sources[id] as THREE.MeshStandardMaterial;
      if (id) maps.forEach((key, channel) => {
        const source = material[key];
        if (source) this.atlases[channel].add(source);
      });
    }

    this.registeredCount = this.registry.sources.length;
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
        const rect = this.atlases[channel].rect(this.atlases[channel].add(source));
        put(2 + channel * 3, rect.toArray());
        const e = this.registry.transforms[id][key] ?? [...source.matrix.elements, source.wrapS, source.wrapT];
        put(3 + channel * 3, [e[0], e[3], e[6], e[9]]);
        put(4 + channel * 3, [e[1], e[4], e[7], e[10]]);
      });
    });

    // Three.js allocates immutable texture storage. A new palette height needs fresh GPU storage,
    // including when a previously empty collision subsystem receives its first material.
    if (this.palette.image.height !== this.registry.sources.length) this.palette.dispose();
    this.palette.image = { data, width: columns, height: this.registry.sources.length };
    this.size.set(columns, this.registry.sources.length);
    this.palette.needsUpdate = true;
  }

  /** Instance attributes are allocated only when copying is enabled. */
  attributes(geometry: THREE.BufferGeometry, particles: Particle[], instanced: boolean): void {
    for (const name of ['materialCopy', 'materialCopyU', 'materialCopyV'] as const) {
      let attr = geometry.getAttribute(name) as THREE.BufferAttribute;
      if (!attr || attr.count < particles.length) {
        const values = new Float32Array(Math.max(1, particles.length) * 4);
        attr = instanced ? new THREE.InstancedBufferAttribute(values, 4) : new THREE.BufferAttribute(values, 4);
        geometry.setAttribute(name, attr);
      }

      particles.forEach((particle, i) => {
        const value = particle[name];
        attr.setXYZW(i, value.x, value.y, value.z, value.w);
      });
      attr.needsUpdate = true;
    }
  }

  nodes(
    binding: Node<'vec4'> = attribute('materialCopy', 'vec4'),
    rowU: Node<'vec4'> = attribute('materialCopyU', 'vec4'),
    rowV: Node<'vec4'> = attribute('materialCopyV', 'vec4'),
    offset?: Node<'vec3'>,
  ) {
    const id = binding.x.greaterThan(0).select(binding.x, this.defaultID);
    const read = (column: number) => texture(this.palette, vec2(
      float(column + 0.5).div(columns), id.add(0.5).div(uniform(this.size).y),
    ));

    // Meshes retain the birth-local frame. Billboards retain chart density and shear.
    const localOffset = offset ?? vec3(uv().sub(0.5), 0);
    const uLength = rowU.xyz.length().max(1e-8);
    const parallel = rowU.xyz.dot(rowV.xyz).div(uLength);
    const perpendicular = rowV.xyz.dot(rowV.xyz).sub(parallel.mul(parallel)).max(0).sqrt();
    const delta = offset ? vec2(rowU.xyz.dot(localOffset), rowV.xyz.dot(localOffset))
      : vec2(localOffset.x.mul(uLength), localOffset.x.mul(parallel).add(localOffset.y.mul(perpendicular)));
    const patchUV = binding.yz.add(delta);
    const hasPatch = rowU.xyz.length().add(rowV.xyz.length()).greaterThan(0);
    const mode = binding.w.greaterThan(0).select(binding.w, this.mode);
    const impactUV = binding.x.greaterThan(0).select(binding.yz, vec2(0.5));
    const sampleUV = mode.equal(1).select(impactUV,
      mode.equal(2).or(binding.x.lessThanEqual(0)).or(hasPatch.not()).select(uv(), patchUV));

    // Apply the source transform and wrapping within its atlas tile.
    const wrap = (value: Node<'float'>, mode: Node<'float'>) => mode.equal(THREE.RepeatWrapping).select(
      value.fract(), mode.equal(THREE.MirroredRepeatWrapping).select(
        float(1).sub(value.mod(2).sub(1).abs()), value.clamp(0, 1),
      ),
    );

    const sample = (channel: number, fallback: Node<'vec4'>) => {
      const rect = read(2 + channel * 3);
      const u = read(3 + channel * 3);
      const v = read(4 + channel * 3);
      const input = vec3(sampleUV, 1);
      const coord = vec2(wrap(u.xyz.dot(input), u.w), wrap(v.xyz.dot(input), v.w));
      const value = texture(this.atlases[channel].texture, rect.xy.add(coord.mul(rect.zw)));
      return rect.z.greaterThan(0).select(value, fallback);
    };

    // Normal derivatives use the same chart as the copied normal map.
    const normalU = read(6);
    const normalV = read(7);
    const effectiveMode = binding.w.greaterThan(0).select(binding.w, this.mode);
    const normalUV = effectiveMode.equal(1).select(uv(), vec2(
      normalU.xyz.dot(vec3(sampleUV, 1)), normalV.xyz.dot(vec3(sampleUV, 1)),
    ));
    const color = read(0);
    const parameters = read(1);

    return {
      normalUV,
      color: sample(0, vec4(1)).rgb.mul(color.rgb),
      alpha: sample(0, vec4(1)).a.mul(sample(4, vec4(1)).g).mul(color.a),
      roughness: sample(2, vec4(1)).g.mul(parameters.x),
      metalness: sample(3, vec4(1)).b.mul(parameters.y),
      normal: sample(1, vec4(0.5, 0.5, 1, 1)).xyz.mul(2).sub(1)
        .mul(vec3(parameters.zw, 1)).normalize(),
    };
  }

  /** Installs matching WebGL uniforms and sampling functions. */
  shader(shader: {
    vertexShader: string; fragmentShader: string; uniforms: Record<string, unknown>;
  }, mesh: boolean): void {
    Object.assign(shader.uniforms, {
      copyPalette: { value: this.palette }, copySize: { value: this.size },
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
      varying vec2 vCopyUV;
      ${shader.vertexShader}`;
    shader.vertexShader = shader.vertexShader.replace(/void main\s*\(\s*\)\s*\{/, `void main() {
      vMaterialCopy = materialCopy;
      vMaterialCopyU = materialCopyU;
      vMaterialCopyV = materialCopyV;
      vCopyOffset = position;
      vCopyUV = ${mesh ? 'uv' : 'position.xy + 0.5'};
    `);

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
          normal = copyBlendNormal(normal, copyNormal(), -vViewPosition, copyUV());`);
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
          normal = copyBlendNormal(normal, copyNormal(), -vViewPosition, copyUV());
          vec3 viewDirection =`);
    }
  }

  private glsl(mesh: boolean): string {
    const samplers = this.atlases.map((_, i) => `uniform sampler2D copyMap${i};`).join('\n');

    const samples = this.atlases.map((_, i) => `
      vec4 copySample${i}(vec4 fallback) {
        vec4 r = copyRead(${2 + i * 3}.0);
        if(r.z == 0.0) return fallback;
        vec3 p = vec3(copyUV(), 1.0);
        vec4 u = copyRead(${3 + i * 3}.0);
        vec4 v = copyRead(${4 + i * 3}.0);
        vec2 point = vec2(copyWrap(dot(u.xyz, p), u.w), copyWrap(dot(v.xyz, p), v.w));
        return texture2D(copyMap${i}, r.xy + r.zw * point);
      }
    `).join('\n');

    return `
      uniform sampler2D copyPalette;
      uniform vec2 copySize;
      uniform float copyDefault;
      uniform float copyMode;
      ${samplers}
      varying vec4 vMaterialCopy;
      varying vec4 vMaterialCopyU;
      varying vec4 vMaterialCopyV;
      varying vec3 vCopyOffset;
      varying vec2 vCopyUV;
      ${mesh ? '' : 'vec3 copyFragmentOffset; vec2 copyFragmentUV;'}
      vec4 copyRead(float column) {
        float id = vMaterialCopy.x > 0.0 ? vMaterialCopy.x : copyDefault;
        return texture2D(copyPalette, vec2((column + 0.5) / copySize.x, (id + 0.5) / copySize.y));
      }
      float copyWrap(float v, float mode) {
        if(mode == ${THREE.RepeatWrapping}.0) return fract(v);
        if(mode == ${THREE.MirroredRepeatWrapping}.0) return 1.0 - abs(mod(v, 2.0) - 1.0);
        return clamp(v, 0.0, 1.0);
      }
      vec2 copyUV() {
        float mode = vMaterialCopy.w > 0.0 ? vMaterialCopy.w : copyMode;
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
    this.palette.dispose();
    this.atlases.forEach(atlas => atlas.dispose());
  }
}
