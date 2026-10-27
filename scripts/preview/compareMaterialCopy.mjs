import assert from 'node:assert/strict';
import path from 'node:path';
import { capturePreview, parseOptions } from './capture.mjs';

const output = path.resolve(process.argv[2] ?? '/tmp/rzmps-material-copy-modes');

// The first capture precedes impact; the second must contain collision-only debris.
for (const backend of ['webgl', 'webgpu']) {
  for (const sprites of [false, true]) {
    for (const [sampleMode, mode] of ['UVPatch', 'Color', 'Texture'].entries()) {
      const variant = `${backend}-${sprites ? 'sprites' : 'meshes'}-${mode}`;
      const options = parseOptions([
        '--example', 'materialCopy', '--scene', 'UV Debug Surfaces', '--backend', backend,
        '--frames', '2', '--warmup', '20', '--interval', '120',
        '--width', '800', '--height', '600',
        '--camera-position', '3,3,5', '--camera-target', '0,1,0',
        '--example-options', JSON.stringify({ sprites, sampleMode }),
        '--output', path.join(output, variant),
      ]);
      const result = await capturePreview(options);
      const child = frame => frame.systems.find(system => system.name.startsWith('Surface '));
      assert.equal(child(result.captures[0]).simulated, 0, `${variant}: debris before collision`);
      assert.ok(child(result.captures[1]).simulated > 0, `${variant}: no collision debris`);
      if (backend === 'webgpu') {
        assert.ok(result.captures[1].systems.every(system => system.gpuProcessingActive));
        assert.ok(result.shaderBindings.every(stage => stage.maxStorageBuffers <= 8));
      }
    }
  }
}
