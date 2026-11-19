/** Integrate physical concentration, not the unweighted sum of texel values. */
export async function gasMoments(gas, renderer, sourceGrid = gas.volumeGrid,
  fieldNode = gas.densityCurrent, channel = 0) {
  const grid = { cellSize: sourceGrid.cellSize, bounds: sourceGrid.bounds.clone(),
    brickSide: sourceGrid.brickSide, brickDimensions: sourceGrid.brickDimensions.clone(),
    brickCount: sourceGrid.brickCount, cellsPerBrick: sourceGrid.cellsPerBrick };
  const h = grid.cellSize, minimum = grid.bounds.min.clone();
  const [field, pageBuffer] = await Promise.all([
    renderer.getArrayBufferAsync(fieldNode.value), renderer.getArrayBufferAsync(sourceGrid.pagesAttribute),
  ]);
  return gasFieldMoments(new Float32Array(field), new Uint32Array(pageBuffer), grid, h, minimum, channel);
}

/** Density-weighted world cell-center moments; mass includes the physical cell volume. */
export function gasFieldMoments(values, pages, grid, h, minimum, channel = 0) {
  let mass = 0, second = 0, maximum = 0;
  const first = [0, 0, 0], side = grid.brickSide, dims = grid.brickDimensions;
  for (let key = 0; key < grid.brickCount; key++) {
    const page = pages[key];
    if (!page) continue;
    const brick = [key % dims.x, Math.floor(key / dims.x) % dims.y, Math.floor(key / (dims.x * dims.y))];
    for (let cell = 0; cell < grid.cellsPerBrick; cell++) {
      const density = values[((page - 1) * grid.cellsPerBrick + cell) * 4 + channel];
      const dm = density * h ** 3;
      if (!dm) continue;
      const local = [cell % side, Math.floor(cell / side) % side, Math.floor(cell / side ** 2)];
      const p = local.map((v, a) => minimum.getComponent(a) + (brick[a] * side + v + 0.5) * h);
      mass += dm; maximum = Math.max(maximum, density);
      for (let a = 0; a < 3; a++) first[a] += p[a] * dm;
      second += p.reduce((sum, v) => sum + v * v, 0) * dm;
    }
  }
  const center = first.map(v => v / (mass || 1));
  return { mass, maximum, center, variance: second / (mass || 1) - center.reduce((s, v) => s + v * v, 0),
    cellWidth: h, bounds: [...grid.bounds.min.toArray(), ...grid.bounds.max.toArray()] };
}

