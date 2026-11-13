import type { SurfaceExtractor } from './LiquidSurface';
import buildMarchingCubesPass from './buildMarchingCubesPass';

/** Marching Cubes with canonical asymptotic decisions on ambiguous faces. */
export const buildMarchingCubes: SurfaceExtractor = options => buildMarchingCubesPass(options);
