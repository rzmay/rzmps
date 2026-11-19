import assert from 'node:assert/strict';
import test from 'node:test';
import { Box3, Vector3 } from 'three';
import { gasFieldMoments } from '../../apps/demo/benchmarks/fluids/gasQualityMetrics.utils.js';

test('gas quality diagnostics distinguish physical concentration from raw cell sums', () => {
  const fine = new Float32Array(32), coarse = new Float32Array([1, 0, 0, 0]);
  for (let i = 0; i < 8; i++) fine[i * 4] = 1;
  const layout = dimensions => ({ brickSide: 1, cellsPerBrick: 1,
    bounds: new Box3(new Vector3(), new Vector3(2, 2, 2)),
    brickCount: dimensions ** 3, brickDimensions: new Vector3().setScalar(dimensions) });
  const a = gasFieldMoments(fine, new Uint32Array([1, 2, 3, 4, 5, 6, 7, 8]), layout(2), 1, new Vector3());
  const b = gasFieldMoments(coarse, new Uint32Array([1]), layout(1), 2, new Vector3());
  assert.equal(a.mass, 8);
  assert.equal(b.mass, a.mass, 'averaged concentration must retain mass when physical cell volume grows');
  assert.deepEqual(a.center, [1, 1, 1]);
  assert.deepEqual(b.center, a.center);
  const empty = gasFieldMoments(fine, new Uint32Array(8), layout(2), 1, new Vector3());
  assert.equal(empty.mass, 0, 'nonresident backing must not be included in field mass');
});
