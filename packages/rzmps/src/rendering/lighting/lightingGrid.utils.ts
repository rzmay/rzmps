import * as THREE from 'three';
import type { Node } from 'three/webgpu';
import { cubeTexture, float, vec3 } from 'three/tsl';

/** Equal-area, deterministic directions with no samples directly at the poles. */
export function fibonacciDirections(count: number): THREE.Vector3[] {
  if (!Number.isInteger(count) || count < 2) throw new RangeError('Lighting directions must be an integer >= 2.');
  return Array.from({ length: count }, (_, i) => {
    const y = 1 - 2 * (i + 0.5) / count;
    const radius = Math.sqrt(1 - y * y), angle = i * Math.PI * (3 - Math.sqrt(5));
    return new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
  });
}

/** L2 radiance, matching SphericalHarmonics3.getAt rather than surface cosine-convolved irradiance. */
export function shBasisGPU(direction: Node<'vec3'>): Node<'float'>[] {
  const { x, y, z } = direction;
  return [float(0.282095), y.mul(0.488603), z.mul(0.488603), x.mul(0.488603), x.mul(y).mul(1.092548),
    y.mul(z).mul(1.092548), z.mul(z).mul(3).sub(1).mul(0.315392), x.mul(z).mul(1.092548),
    x.mul(x).sub(y.mul(y)).mul(0.546274)];
}

export function shRadianceGPU(coefficients: readonly Node<'vec3'>[], direction: Node<'vec3'>): Node<'vec3'> {
  const basis = shBasisGPU(direction);
  return coefficients.reduce((sum, coefficient, i) => sum.add(coefficient.mul(basis[i])), vec3(0)).max(vec3(0));
}

/** Cache scene membership, not transforms. Object add/remove events invalidate discovery. */
export class SceneLightingCollection {
  readonly lights: THREE.Light[] = [];
  private scene?: THREE.Scene;
  private dirty = true;
  private readonly objects = new Set<THREE.Object3D>();
  private readonly invalidate = () => { this.dirty = true; };

  update(scene: THREE.Scene): void {
    if (scene !== this.scene) { this.dispose(); this.scene = scene; this.dirty = true; }
    if (!this.dirty) return;
    for (const object of this.objects) {
      object.removeEventListener('childadded', this.invalidate);
      object.removeEventListener('childremoved', this.invalidate);
    }
    this.objects.clear(); this.lights.length = 0;
    scene.traverse(object => {
      this.objects.add(object);
      object.addEventListener('childadded', this.invalidate);
      object.addEventListener('childremoved', this.invalidate);
      if ((object as THREE.Light).isLight) this.lights.push(object as THREE.Light);
    });
    this.dirty = false;
  }

  dispose(): void {
    for (const object of this.objects) {
      object.removeEventListener('childadded', this.invalidate);
      object.removeEventListener('childremoved', this.invalidate);
    }
    this.objects.clear(); this.lights.length = 0; this.scene = undefined; this.dirty = true;
  }
}

export function lightVisible(light: THREE.Light): boolean {
  for (let object: THREE.Object3D | null = light; object; object = object.parent) if (!object.visible) return false;
  return true;
}

/** Positive angular interpolation balanced to preserve constant fields AND integrated directional energy. */
export function directionTransfer(fine: readonly THREE.Vector3[], coarse: readonly THREE.Vector3[]): number[][] {
  const weights = fine.map(a => coarse.map(b => Math.max(1e-8, Math.exp(12 * (a.dot(b) - 1)))));
  const target = fine.length / coarse.length;
  for (let iteration = 0; iteration < 320; iteration++) {
    for (let column = 0; column < coarse.length; column++) {
      const sum = weights.reduce((total, row) => total + row[column], 0);
      for (const row of weights) row[column] *= target / sum;
    }
    for (const row of weights) {
      const sum = row.reduce((a, b) => a + b, 0);
      for (let column = 0; column < row.length; column++) row[column] /= sum;
    }
  }
  return weights;
}

/** CubeTextureNode normally reads material/scene rotation, which is unavailable in a compute dispatch. */
export function sampleCubeRadianceGPU(cube: THREE.CubeTexture, direction: Node<'vec3'>): Node<'vec3'> {
  const node = cubeTexture(cube, direction, float(0));
  // Rotation is supplied by LightingGrid; retain Three's WebGPU cube-coordinate X flip only.
  Object.assign(node, { setupUV: (_builder: unknown, uv: Node<'vec3'>) => vec3(uv.x.negate(), uv.yz) });
  return node.xyz;
}
