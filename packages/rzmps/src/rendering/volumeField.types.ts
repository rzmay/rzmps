import * as THREE from 'three';
import type { Node } from 'three/webgpu';

export interface VolumeField {
  data?: Float32Array | Uint8Array;
  texture?: THREE.Texture;
  resolution: THREE.Vector3;
  /** Optional backing texture extent; resolution describes the valid lower-origin logical region. */
  textureResolution?: THREE.Vector3;
  bounds: THREE.Box3;
  version: number;
  channels?: 1 | 3 | 4;
  /** Optional physical parameters packed alongside density in RGBA. Density always occupies R. */
  parameterChannels?: Partial<Record<'temperature' | 'speed' | 'vorticity', 1 | 2 | 3>>;
  /** Divide interpolated parameter channels by interpolated density when true. */
  parametersPremultiplied?: boolean;
  /** Optional native GPU velocity sampler, in the same simulation space as bounds; no derived field required.
   * Captured storage/layout bindings must stay current when the producer resizes or replaces resources.
   */
  sampleVelocityGPU?: (position: Node<'vec3'>) => Node<'vec3'>;
}


/** Supplies simulation-space volume fields independently of their production algorithm. */
export interface VolumeFieldProvider {
  getVolumeField(): VolumeField | undefined;
  getVolumeColorField?(): VolumeField | undefined;
}

