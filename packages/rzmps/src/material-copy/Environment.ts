import type * as THREE from 'three';

/** Environment textures stay borrowed, including live render-target textures. */
export interface MaterialEnvironment {
  envMap?: THREE.Texture | null;
  envMapIntensity?: number;
  envMapRotation?: THREE.Euler;
}

/** Copies supported reflection inputs without changing the destination material class. */
export function copyMaterialEnvironment(destination: THREE.Material, source?: MaterialEnvironment): void {
  if (!source || !('envMap' in destination)) return;

  const target = destination as THREE.Material & MaterialEnvironment;
  const map = source.envMap ?? null;
  const intensity = source.envMapIntensity ?? 1;
  let changed = target.envMap !== map || target.envMapIntensity !== intensity;

  // Keep orientation consistent with the surface's reflection chart.
  if (target.envMapRotation && source.envMapRotation && !target.envMapRotation.equals(source.envMapRotation)) {
    target.envMapRotation.copy(source.envMapRotation);
    changed = true;
  }

  if (!changed) return;

  target.envMap = map;
  target.envMapIntensity = intensity;
  destination.needsUpdate = true;
}
