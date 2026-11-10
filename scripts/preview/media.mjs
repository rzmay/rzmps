import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export const containers = {
  mp4: { encoder: 'libx264', mime: 'video/mp4', flags: ['-preset', 'slow', '-movflags', '+faststart'] },
  webm: { encoder: 'libvpx-vp9', mime: 'video/webm', flags: ['-b:v', '0', '-deadline', 'good', '-cpu-used', '2'] },
};
export function toolVersions() {
  return Object.fromEntries(
    ['ffmpeg', 'ffprobe'].map(tool => [
      tool,
      execFileSync(tool, ['-version'], { encoding: 'utf8', timeout: 10000 }).split('\n')[0],
    ]),
  );
}
function run(tool, args) {
  return execFileSync(tool, args, { timeout: 180000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
export function encodingArguments(options) {
  const container = containers[options.format];
  if (!container) throw new Error(`Unsupported video format: ${options.format}; use mp4 or webm`);
  return [
    '-y',
    '-v',
    'error',
    '-framerate',
    String(options.fps),
    '-i',
    path.join(options.output, 'frame-%03d.png'),
    ...(options.audio
      ? [
          '-i',
          path.join(options.output, 'audio.wav'),
          '-c:a',
          options.format === 'mp4' ? 'aac' : 'libopus',
          '-b:a',
          '128k',
          '-shortest',
        ]
      : ['-an']),
    '-c:v',
    container.encoder,
    '-crf',
    String(options.crf),
    '-pix_fmt',
    'yuv420p',
    ...container.flags,
    '-f',
    options.format,
    path.join(options.output, `preview.${options.format}`),
  ];
}
export async function encodeVideo(options) {
  run('ffmpeg', encodingArguments(options));
  // FFmpeg's PNG encoder applies lossless compression to the retained poster.
  run('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-i',
    path.join(options.output, 'frame-000.png'),
    '-frames:v',
    '1',
    '-c:v',
    'png',
    '-compression_level',
    '9',
    path.join(options.output, 'poster.png'),
  ]);
  return inspectMedia(path.join(options.output, `preview.${options.format}`), options);
}
export async function inspectMedia(file, expected, { image = false } = {}) {
  const info = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
  const stream = info.streams.find(s => s.codec_type === 'video');
  if (!stream || stream.width !== expected.width || stream.height !== expected.height)
    throw new Error(`${file}: unexpected dimensions`);
  if (!image) {
    if (expected.audio && !info.streams.some(s => s.codec_type === 'audio'))
      throw new Error(`${file}: missing captured audio`);
    const duration = Number(info.format.duration ?? stream.duration);
    const [n, d] = stream.avg_frame_rate.split('/').map(Number);
    if (
      !Number.isFinite(duration) ||
      Math.abs(duration - expected.frames / expected.fps) > Math.max(0.1, 1 / expected.fps) ||
      !Number.isFinite(n / d) ||
      Math.abs(n / d - expected.fps) > 0.01
    )
      throw new Error(`${file}: unexpected duration or frame rate`);
    if (stream.pix_fmt !== 'yuv420p') throw new Error(`${file}: incompatible pixel format`);
    // Decode the complete output; ffprobe alone does not detect truncated/corrupt frames.
    run('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-']);
  }
  // Decode sampled pixels to reject blank, transparent, or near-uniform capture output.
  const pixels = run('ffmpeg', [
    '-v',
    'error',
    '-i',
    file,
    '-frames:v',
    '1',
    '-vf',
    'scale=64:64',
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    '-',
  ]);
  let min = 255,
    max = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    const luminance = Math.round((pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3);
    min = Math.min(min, luminance);
    max = Math.max(max, luminance);
  }
  if (max - min < 3) throw new Error(`${file}: blank or uniform preview; refusing to publish`);
  const stat = await fs.stat(file);
  if (!stat.size) throw new Error(`${file}: empty media`);
  return {
    width: stream.width,
    height: stream.height,
    duration: Number(info.format.duration ?? 0),
    bytes: stat.size,
    audio: info.streams.some(s => s.codec_type === 'audio'),
  };
}
