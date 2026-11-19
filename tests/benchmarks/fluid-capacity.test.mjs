import assert from 'node:assert/strict';
import test from 'node:test';
import { Vector3 } from 'three';
import {
  maximumFluidResidentCapacity,
  coarsenedResidentCapacity,
  refinementResidentCapacity,
} from '../../packages/rzmps/src/simulation/gpu/fluidCapacity.utils.ts';

test('coarsening caps reservations at the geometric tier covering every possible capped brick', () => {
  const max = new Vector3(10, 10, 10);
  assert.equal(maximumFluidResidentCapacity(max, 2, 1023), 128);
  assert.equal(maximumFluidResidentCapacity(max, 1, 1023), 1023);
  assert.equal(maximumFluidResidentCapacity(new Vector3(10, 6, 4), 2, 1023), 32);
  assert.equal(maximumFluidResidentCapacity(new Vector3(Infinity, 10, 10), 2, 1023), 1023);
  assert.equal(
    maximumFluidResidentCapacity(new Vector3(20, 20, 20), 2, 1023),
    1023,
    'raising maxBounds must permit ordinary future growth again',
  );
});

test('refinement reserves nested support and rejects unrepresentable support instead of dropping it', () => {
  assert.equal(refinementResidentCapacity(128, 31, 2, 1000, 1023), 256);
  assert.equal(refinementResidentCapacity(128, 8, 2, 1000, 1023), 128);
  assert.equal(refinementResidentCapacity(512, 31, 1, 125, 128), 128);
  assert.throws(() => refinementResidentCapacity(512, 500, 2, 8000, 1023), /exceeds/);
});

test('coarsening reserves actual support and a complete receiver ring instead of inherited fine capacity', () => {
  const source = new Vector3(8, 8, 8),
    target = new Vector3(4, 4, 4),
    origin = new Vector3();
  // The fine brick at (3,3,3) maps to one coarse brick plus a full 3x3x3 receiver shell.
  const slot = 1 + 3 + 8 * (3 + 8 * 3);
  assert.equal(coarsenedResidentCapacity(new Uint32Array([slot]), source, origin, 1, target, origin, 2, 512), 32);
  // A boundary corner has only 2x2x2 representable receiver positions.
  assert.equal(coarsenedResidentCapacity(new Uint32Array([1]), source, origin, 1, target, origin, 2, 512), 8);
  assert.equal(coarsenedResidentCapacity(new Uint32Array([slot, slot]), source, origin, 1, target, origin, 2, 512), 32);
});
