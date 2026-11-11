/** Algorithm used to extract triangles from a reconstructed particle field. */
export enum SurfaceExtraction {
  /** One shared vertex per crossing cell; the default. */
  SurfaceNets = 'SurfaceNets',
  /** Edge-interpolated triangles using the classic Marching Cubes lookup table. */
  MarchingCubes = 'MarchingCubes',
}
