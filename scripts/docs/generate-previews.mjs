import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { toolVersions } from '../preview/media.mjs';
import { PUPPETEER_REVISIONS } from 'puppeteer';
import { fileURLToPath } from 'node:url';
import { discoverExamples, root } from './examples.mjs';
import { previewArguments } from './preview-settings.mjs';
import {
  checksum,
  previewDirectory,
  previewInputs,
  readPreviewManifest,
  previewIsCurrent,
} from './preview-manifest.mjs';
export async function generatePreviews({ force = false } = {}) {
  const examples = discoverExamples();
  const tools = { ...toolVersions(), chrome: PUPPETEER_REVISIONS.chrome };
  const inputs = previewInputs(examples, tools);
  const manifest = readPreviewManifest();
  await fs.mkdir(previewDirectory, { recursive: true });
  const diagnosticRoot = path.resolve(
    process.env.RZMPS_PREVIEW_DIAGNOSTICS_DIR ?? 'benchmark-results/preview-diagnostics',
  );
  let capture;
  for (const example of examples) {
    const destination = path.join(previewDirectory, example.id + '.png');
    const entry = manifest.examples[example.id];
    const cachedFiles = Object.fromEntries(
      await Promise.all(
        Object.keys(entry?.files ?? {}).map(async name => [
          name,
          path.basename(name) === name ? await fs.readFile(path.join(previewDirectory, name)).catch(() => null) : null,
        ]),
      ),
    );
    if (!force && previewIsCurrent(entry, inputs.get(example.id), cachedFiles)) {
      console.log(`${example.id}: preview is current`);
      continue;
    }
    if (!capture) {
      // Capture local source changes, including a clean checkout with no package build artifacts.
      execFileSync('npm', ['run', 'build:modules'], { cwd: root, stdio: 'inherit' });
      capture = await import('../preview/capture.mjs');
    }
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'rzmps-doc-preview-'));
    try {
      const options = capture.parseOptions(previewArguments(example, output));
      let result;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          console.log(`${example.id}: capturing ${options.backend}, attempt ${attempt}/3`);
          result = await capture.capturePreview(options);
          break;
        } catch (error) {
          const saved = path.join(diagnosticRoot, example.id, `attempt-${attempt}`);
          await fs.mkdir(saved, { recursive: true });
          for (const file of ['metadata.json', 'diagnostics.json', 'chromium.log']) {
            await fs.copyFile(path.join(output, file), path.join(saved, file)).catch(() => {});
          }
          await fs.cp(path.join(output, 'shaders'), path.join(saved, 'shaders'), { recursive: true }).catch(() => {});
          console.error(`${example.id}: ${error.stack ?? error.message}\nDiagnostics: ${saved}`);
          if (
            options.backend !== 'webgpu' ||
            attempt === 3 ||
            !/external Instance reference|WebGPU device lost|Instance dropped/i.test(error?.message ?? '')
          )
            throw error;
          // capturePreview closes its browser before rejecting, so every retry starts fresh.
          console.warn(`${example.id}: WebGPU device lost; retrying preview (${attempt + 1}/3) in a fresh browser.`);
        }
      }
      if (result.actualBackend !== options.backend)
        throw new Error(`${example.id}: requested ${options.backend}, captured ${result.actualBackend}`);
      const image = await fs.readFile(path.join(output, 'poster.png'));
      const videoName = `${example.id}.${options.format}`;
      const video = await fs.readFile(path.join(output, `preview.${options.format}`));
      await fs.writeFile(path.join(previewDirectory, videoName), video);
      await fs.writeFile(destination, image);
      manifest.examples[example.id] = {
        inputHash: inputs.get(example.id),
        files: { [example.id + '.png']: checksum(image), [videoName]: checksum(video) },
        format: options.format,
        fps: options.fps,
        frames: options.frames,
        duration: options.duration,
        tools,
        browserVersion: result.browserVersion,
        actualBackend: result.actualBackend,
        backend: options.backend,
        width: options.width,
        height: options.height,
        capture: result.captures[0],
        camera: result.camera,
        warnings: result.warnings.map(w => w.replace(/http:\/\/127\.0\.0\.1:\d+/g, 'http://localhost')),
      };
    } finally {
      await fs.rm(output, { recursive: true, force: true });
    }
    // Save progress so a failed example never discards completed captures.
    manifest.examples = Object.fromEntries(
      Object.entries(manifest.examples).sort(([a], [b]) => a.localeCompare(b, 'en')),
    );
    await fs.writeFile(path.join(previewDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
  for (const id of Object.keys(manifest.examples))
    if (!inputs.has(id)) {
      delete manifest.examples[id];
      for (const extension of ['png', 'mp4', 'webm'])
        await fs.rm(path.join(previewDirectory, id + '.' + extension), { force: true });
    }
  for (const id of Object.keys(manifest.examples))
    if (!inputs.has(id)) {
      delete manifest.examples[id];
      await fs.rm(path.join(previewDirectory, id + '.png'), { force: true });
    }
  await fs.writeFile(path.join(previewDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generatePreviews({ force: process.argv.includes('--force') });
}
