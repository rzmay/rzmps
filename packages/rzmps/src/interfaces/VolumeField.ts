import * as THREE from 'three';

export interface VolumeField {
  data?: Float32Array | Uint8Array;
  texture?: THREE.Texture;
  resolution: THREE.Vector3;
  bounds: THREE.Box3;
  version: number;
  channels?: 1 | 3 | 4;
}
