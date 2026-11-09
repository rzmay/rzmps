import assert from 'node:assert/strict';
import path from 'node:path';
import { capturePreview, parseOptions } from './capture.mjs';

const output = path.resolve(process.argv[2] ?? '/tmp/rzmps-destruction-lifetime');

// The old GPU run pool exhausted permanently after about 45 seconds of repeated impacts.
for (const backend of ['webgl', 'webgpu']) {
  for (const scene of ['Checkerboard', 'UV debug']) {
    const variant = `${backend}-${scene === 'Checkerboard' ? 'checkerboard' : 'uv-debug'}`;
    const options = parseOptions([
      '--example', 'destruction', '--scene', scene, '--backend', backend,
      '--frames', '7', '--warmup', '120', '--interval', '600',
      '--width', '600', '--height', '400',
      '--camera-position', '3,3,5', '--camera-target', '0,1,0',
      '--output', path.join(output, variant),
    ]);
    const result = await capturePreview(options);
    for (const frame of result.captures) {
      const child = frame.systems.find(system => system.name === 'Surface Fragments');
      assert.ok(child?.simulated > 0, `${variant}: no debris at ${frame.time}s`);
      if (backend === 'webgpu') {
        assert.ok(frame.systems.every(system => system.gpuProcessingActive));
      }
    }
    assert.ok(result.shaderBindings.every(stage => stage.maxStorageBuffers <= 8));
  }
}
