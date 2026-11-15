import assert from 'node:assert/strict';
import test from 'node:test';
import { VolumeRenderer } from '../../build/index.mjs';

test('volume jitter ranks retain a full uniform stratum and suppress coarse spatial patterns', () => {
  const volume = new VolumeRenderer(), texture = volume.jitterTexture, ranks = texture.image.data;
  assert.equal(ranks.length, 1024);
  const counts = new Uint32Array(256);
  for (const rank of ranks) counts[rank]++;
  assert(counts.every(count => count === 4));
  assert.equal(volume.jitterStrength, 1);
  assert.equal(volume.interpolation, 'Linear');
  assert.equal(volume.webglMaterial.uniforms.jitterMap.value, texture);

  // White binary noise has expected non-DC Fourier energy N*p*(1-p).
  // Blue-noise threshold masks should suppress wavelengths that could reveal coarse ray blocks.
  for (const fraction of [0.25, 0.5, 0.75]) {
    let power = 0, frequencies = 0;
    for (let fy = -2; fy <= 2; fy++) for (let fx = -2; fx <= 2; fx++) {
      if (!fx && !fy) continue;
      let real = 0, imaginary = 0;
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
        const value = Number(ranks[x + y * 32] < fraction * 256) - fraction;
        const angle = 2 * Math.PI * (fx * x + fy * y) / 32;
        real += value * Math.cos(angle); imaginary += value * Math.sin(angle);
      }
      power += real ** 2 + imaginary ** 2; frequencies++;
    }
    assert(power / frequencies < 1024 * fraction * (1 - fraction) * 0.2);
  }
  let disposed = 0;
  texture.addEventListener('dispose', () => { disposed++; });
  volume.destroy();
  assert.equal(disposed, 1);
});
