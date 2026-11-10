import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseOptions } from '../../preview/capture.mjs';
import { browserArguments } from '../../preview/browser.mjs';
import { encodeVideo, encodingArguments, inspectMedia } from '../../preview/media.mjs';

const toolsAvailable = ['ffmpeg', 'ffprobe'].every(tool => spawnSync(tool, ['-version']).status === 0);
test('video options retain PNG compatibility and validate bounds', () => {
  assert.equal(parseOptions([]).frames, 6);
  assert.equal(parseOptions([]).format, 'png');
  const options = parseOptions(['--format', 'mp4', '--duration', '4', '--fps', '24']);
  assert.equal(options.frames, 96);
  assert.equal(options.duration, 4);
  assert.equal(parseOptions(['--format', 'webm', '--frames', '10', '--fps', '5']).duration, 2);
  for (const args of [
    ['--fps', '0'],
    ['--duration', 'NaN'],
    ['--format', 'unknown'],
    ['--width', '801'],
    ['--crf', '-1'],
  ]) {
    assert.throws(() => parseOptions(['--format', 'mp4', ...args]));
  }
  assert.ok(encodingArguments(options).includes('+faststart'));
});
test('CI flags explicitly select SwiftShader without changing macOS graphics backend', () => {
  assert.ok(browserArguments({ ci: true, platform: 'linux' }).includes('--use-webgpu-adapter=swiftshader'));
  assert.ok(!browserArguments({ ci: true, platform: 'darwin' }).includes('--enable-features=Vulkan'));
});
for (const format of ['mp4', 'webm'])
  test(`${format}: encode and fully decode tiny deterministic frames`, { skip: !toolsAvailable }, async () => {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'rzmps-media-test-'));
    try {
      execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'testsrc=size=64x48:rate=6',
          '-frames:v',
          '6',
          '-start_number',
          '0',
          path.join(output, 'frame-%03d.png'),
        ],
        { timeout: 10000 },
      );
      const options = parseOptions([
        '--format',
        format,
        '--frames',
        '6',
        '--fps',
        '6',
        '--width',
        '64',
        '--height',
        '48',
        '--output',
        output,
      ]);
      execFileSync(
        'ffmpeg',
        ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', path.join(output, 'audio.wav')],
        { timeout: 10000 },
      );
      options.audio = true;
      const info = await encodeVideo(options);
      assert.equal(info.audio, true);
      assert.equal(info.width, 64);
      assert.ok(Math.abs(info.duration - 1) < 0.1);
      await inspectMedia(path.join(output, 'poster.png'), options, { image: true });
      await assert.rejects(
        inspectMedia(path.join(output, `preview.${format}`), { ...options, width: 66 }),
        /dimensions/,
      );
      await fs.writeFile(path.join(output, 'bad.mp4'), 'corrupt');
      await assert.rejects(inspectMedia(path.join(output, 'bad.mp4'), options));
      execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=black:size=64x48',
          '-frames:v',
          '1',
          path.join(output, 'blank.png'),
        ],
        { timeout: 10000 },
      );
      await assert.rejects(inspectMedia(path.join(output, 'blank.png'), options, { image: true }), /blank/);
    } finally {
      await fs.rm(output, { recursive: true, force: true });
    }
  });

test('WebGPU readback removes padded rows, including non-aligned resolutions', async () => {
  const { packedPixels } = await import('../../preview/readTargetPNG.mjs');
  const pixels = new Uint8Array(256 + 8);
  pixels.set([1, 2, 3, 4, 5, 6, 7, 8]);
  pixels.set([9, 10, 11, 12, 13, 14, 15, 16], 256);
  assert.deepEqual(
    [...packedPixels(pixels, 2, 2)],
    Array.from({ length: 16 }, (_, i) => i + 1),
  );
  assert.throws(() => packedPixels(new Uint8Array(3), 2, 2), /Incomplete/);
});
