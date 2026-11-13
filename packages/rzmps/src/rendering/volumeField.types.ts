import * as THREE from 'three';

export interface VolumeField {
  data?: Float32Array | Uint8Array;
  texture?: THREE.Texture;
  resolution: THREE.Vector3;
  bounds: THREE.Box3;
  version: number;
  channels?: 1 | 3 | 4;
  /** Optional physical parameters packed alongside density in RGBA. Density always occupies R. */
  parameterChannels?: Partial<Record<'temperature' | 'speed' | 'vorticity', 1 | 2 | 3>>;
  /** Divide interpolated parameter channels by interpolated density when true. */
  parametersPremultiplied?: boolean;
}


/** Supplies simulation-space volume fields independently of their production algorithm. */
export interface VolumeFieldProvider {
  getVolumeField(): VolumeField | undefined;
  getVolumeColorField?(): VolumeField | undefined;
}

