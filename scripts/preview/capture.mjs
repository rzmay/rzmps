import fs from 'node:fs/promises';
import { previewBrowserArguments } from './browserSettings.mjs';
import { attachBrowserDiagnostics } from './browserDiagnostics.mjs';
import { encodeVideo, containers } from './media.mjs';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build, preview } from 'vite';
import puppeteer, { PUPPETEER_REVISIONS } from 'puppeteer';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

export function parseOptions(args) {
  const names = [
    'example',
    'backend',
    'frames',
    'interval',
    'warmup',
    'delta-time',
    'width',
    'height',
    'output',
    'seed',
    'scene',
    'scene-light-strength',
    'camera-position',
    'camera-target',
    'camera-fov',
    'example-options',
    'format',
    'duration',
    'fps',
    'crf',
  ];
  const { values } = parseArgs({
    args,
    options: Object.fromEntries(names.map(name => [name, { type: 'string' }])),
  });
  function vector(name, fallback) {
    if (values[name] === undefined) return fallback;
    const components = values[name].split(',');
    if (components.length !== 3 || components.some(c => !c.trim() || !Number.isFinite(Number(c)))) {
      throw new Error(`--${name} must contain three finite comma-separated coordinates`);
    }
    return components.map(Number);
  }
  const exampleOptions = values['example-options'] === undefined ? undefined : JSON.parse(values['example-options']);
  if (
    exampleOptions !== undefined &&
    (!exampleOptions || Array.isArray(exampleOptions) || typeof exampleOptions !== 'object')
  )
    throw new Error('--example-options must be a JSON object');
  const options = {
    ...(exampleOptions === undefined ? {} : { exampleOptions }),
    example: values.example ?? 'fire',
    format: values.format ?? 'png',
    fps: Number(values.fps ?? 30),
    crf: Number(values.crf ?? 28),
    backend: values.backend ?? 'webgl',
    frames: Number(values.frames ?? 6),
    interval: Number(values.interval ?? 20),
    warmup: Number(values.warmup ?? 60),
    deltaTime: Number(values['delta-time'] ?? 1 / 60),
    width: Number(values.width ?? 800),
    height: Number(values.height ?? 600),
    seed: Number(values.seed ?? 1),
    scene: values.scene ?? null,
    sceneLightStrength:
      values['scene-light-strength'] === undefined ? undefined : Number(values['scene-light-strength']),
    cameraPosition: vector('camera-position', [8, 6, 12]),
    cameraTarget: vector('camera-target', [0, 2, 0]),
    cameraFov: Number(values['camera-fov'] ?? 50),
    output: path.resolve(values.output ?? `benchmark-results/previews/${values.example ?? 'fire'}`),
  };
  if (options.format !== 'png' && !containers[options.format]) throw new Error('--format must be png, mp4 or webm');
  const video = options.format !== 'png';
  if (!Number.isFinite(options.fps) || options.fps <= 0 || options.fps > 120)
    throw new Error('--fps must be between 0 and 120');
  if (!Number.isFinite(options.crf) || options.crf < 0 || options.crf > 51)
    throw new Error('--crf must be between 0 and 51');
  if (video) {
    const duration = Number(values.duration ?? 4);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 30)
      throw new Error('--duration must be between 0 and 30 seconds');
    options.frames = Number(values.frames ?? Math.round(duration * options.fps));
    options.deltaTime = Number(values['delta-time'] ?? 1 / 60);
    options.interval = 1;
    options.duration = options.frames / options.fps;
    if (options.duration > 30) throw new Error('Video frame count exceeds 30 seconds at the requested fps');
    if (options.width % 2 || options.height % 2) throw new Error('Video dimensions must be even');
  }
  if (!['webgl', 'webgpu'].includes(options.backend)) throw new Error('--backend must be webgl or webgpu');
  if (
    options.sceneLightStrength !== undefined &&
    (!Number.isFinite(options.sceneLightStrength) || options.sceneLightStrength < 0)
  ) {
    throw new Error('--scene-light-strength must be a finite nonnegative number');
  }
  for (const key of ['frames', 'interval', 'width', 'height']) {
    if (!Number.isSafeInteger(options[key]) || options[key] <= 0)
      throw new Error(`--${key} must be a positive integer`);
  }
  if (!Number.isSafeInteger(options.warmup) || options.warmup < 0)
    throw new Error('--warmup must be a nonnegative integer');
  if (!Number.isSafeInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff)
    throw new Error('--seed must be an unsigned 32-bit integer');
  if (!Number.isFinite(options.deltaTime) || options.deltaTime <= 0)
    throw new Error('--delta-time must be positive and finite');
  if (!Number.isFinite(options.cameraFov) || options.cameraFov <= 0 || options.cameraFov >= 180)
    throw new Error('--camera-fov must be between 0 and 180 degrees');
  if (options.cameraPosition.every((v, i) => v === options.cameraTarget[i]))
    throw new Error('Camera position and target must differ');
  const totalSteps =
    options.warmup + (options.frames - 1) * (video ? Math.ceil(1 / options.fps / options.deltaTime) : options.interval);
  if (options.frames > (video ? 3600 : 60) || options.width > 4096 || options.height > 4096 || totalSteps > 100000) {
    throw new Error('Preview exceeds limits: capture count, 4096px dimensions, 100000 total steps');
  }
  const columns = Math.min(3, options.frames);
  const sheetPixels = columns * options.width * Math.ceil(options.frames / columns) * (options.height + 30);
  if (!video && sheetPixels > 64000000)
    throw new Error('Contact sheet exceeds 64 megapixels; reduce frame count or dimensions');
  return options;
}

let demoBuild;
export async function capturePreview(options) {
  const root = path.resolve(import.meta.dirname, '../..');
  const diagnostics = { warnings: [], errors: [] };
  await fs.mkdir(options.output, { recursive: true });
  // Replace artifacts owned by this tool, preserving unrelated user files.
  for (const file of await fs.readdir(options.output)) {
    if (/^frame-\d+\.png$|^(contact-sheet|poster)\.png$|^preview\.(mp4|webm)$|^audio\.wav$/.test(file))
      await fs.unlink(path.join(options.output, file));
  }
  let server, browser, browserDiagnostics;
  const metadata = {
    ...options,
    status: 'initializing',
    determinism: {
      seededMathRandom: true,
      limitations: [
        'Particle IDs use crypto randomness; ID-seeded renderer choices can vary.',
        'Device/backend shader output and external scene inputs can vary.',
      ],
    },
    ...diagnostics,
  };
  try {
    let viteConfig = {
      root: path.join(root, 'apps/demo'),
      configFile: path.join(root, 'apps/demo/vite.config.mjs'),
    };
    // Production serving reuses benchmark infrastructure and avoids hot-reload races.
    demoBuild ??= (async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rzmps-preview-build-'));
      process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
      const isolatedConfig = { ...viteConfig, build: { outDir: directory, emptyOutDir: true } };
      try {
        await build(isolatedConfig);
        return isolatedConfig;
      } catch (error) {
        await fs.rm(directory, { recursive: true, force: true });
        throw error;
      }
    })().catch(error => {
      demoBuild = undefined;
      throw error;
    });
    viteConfig = await demoBuild;
    server = await preview({ ...viteConfig, preview: { host: '127.0.0.1', port: 0 } });
    const address = server.httpServer.address();
    const args = previewBrowserArguments();
    browser = await puppeteer.launch({
      headless: true,
      args,
      defaultViewport: { width: options.width, height: options.height, deviceScaleFactor: 1 },
    });
    metadata.browserVersion = await browser.version();
    if (process.env.CI === 'true' && !metadata.browserVersion.endsWith('/' + PUPPETEER_REVISIONS.chrome)) {
      throw new Error(`Expected pinned Chrome ${PUPPETEER_REVISIONS.chrome}; found ${metadata.browserVersion}`);
    }
    const page = await browser.newPage();
    page.setDefaultTimeout(180000);
    console.log(
      `Capturing ${options.example}: requested ${options.backend}, ${options.format}, ` +
        `${options.frames} frames at ${options.width}x${options.height}`,
    );
    browserDiagnostics = await attachBrowserDiagnostics(browser, page, options, args);
    await browserDiagnostics.snapshot();
    page.on('console', message => {
      if (['error', 'warn'].includes(message.type())) {
        diagnostics[message.type() === 'error' ? 'errors' : 'warnings'].push(message.text());
        console.warn(`[preview ${options.example}/${options.backend}] ${message.type()}: ${message.text()}`);
      }
    });
    page.on('pageerror', error => diagnostics.errors.push(error.message));
    page.on('requestfailed', request => diagnostics.errors.push(`${request.url()}: ${request.failure()?.errorText}`));
    page.on('response', response => {
      if (response.status() >= 400) diagnostics.errors.push(`${response.status()} ${response.url()}`);
    });
    const streamedFrames = [];
    await page.exposeFunction('rzmpsWriteFrame', async (index, observation, data) => {
      const bytes = Buffer.from(data.split(',')[1], 'base64');
      if (bytes.length < 100 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
        throw new Error('Invalid captured PNG');
      await fs.writeFile(path.join(options.output, `frame-${String(index).padStart(3, '0')}.png`), bytes);
      streamedFrames.push(observation);
      if (index === 0 || (index + 1) % 30 === 0 || index + 1 === options.frames)
        console.log(`  ${options.example} [${options.backend}]: frame ${index + 1}/${options.frames}`);
    });
    browserDiagnostics.report({ phase: 'page-navigation' });
    await page.goto(`http://127.0.0.1:${address.port}/?preview=1`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.rzmpsPreview);
    let captureTimeout, result;
    try {
      result = await Promise.race([
        page.evaluate(options => window.rzmpsPreview.capture({ ...options, streamFrames: true }), options),
        new Promise((_, reject) => {
          captureTimeout = setTimeout(() => reject(new Error('Timed out capturing preview after 180 seconds')), 180000);
        }),
      ]);
    } finally {
      clearTimeout(captureTimeout);
    }
    async function png(file, data) {
      const buffer = Buffer.from(data.split(',')[1], 'base64');
      if (buffer.length < 100 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
        throw new Error(`Invalid PNG: ${file}`);
      await fs.writeFile(path.join(options.output, file), buffer);
    }
    for (const [index, frame] of result.frames.entries()) {
      if (frame.data) await png(`frame-${String(index).padStart(3, '0')}.png`, frame.data);
    }
    if (result.contactSheet) await png('contact-sheet.png', result.contactSheet);
    if (result.audio) await fs.writeFile(path.join(options.output, 'audio.wav'), Buffer.from(result.audio, 'base64'));
    if (options.format !== 'png') metadata.video = await encodeVideo({ ...options, audio: !!result.audio });
    Object.assign(metadata, {
      status: 'complete',
      scene: result.scene ?? options.scene,
      actualBackend: result.backend,
      audio: !!result.audio,
      captures: (streamedFrames.length ? streamedFrames : result.frames).map(({ data, ...rest }) => rest),
      camera: result.camera,
      rendererInfo: result.rendererInfo,
      childValidation: result.childValidation,
      frameValidation: result.frameValidation,
      shaderBindings: Object.values(
        (result.shaderBindings ?? []).reduce((stages, entry) => {
          const key = `${entry.stage}:${entry.name}`;
          const stage = (stages[key] ??= { stage: entry.stage, name: entry.name, pipelines: 0, maxStorageBuffers: 0 });
          stage.pipelines += 1;
          stage.maxStorageBuffers = Math.max(stage.maxStorageBuffers, entry.storageBuffers);
          return stages;
        }, {}),
      ),
      userAgent: result.userAgent,
    });
    if (diagnostics.errors.length) throw new Error(`Browser errors: ${diagnostics.errors.join('\n')}`);
    if (options.format !== 'png')
      for (const file of await fs.readdir(options.output)) {
        if (/^frame-\d+\.png$/.test(file)) await fs.unlink(path.join(options.output, file));
      }
    console.log(`Captured ${options.frames} ${options.backend} frames in ${options.output}`);
    return metadata;
  } catch (error) {
    metadata.status = 'failed';
    diagnostics.errors.push(error.stack ?? error.message);
    console.error(
      `[preview ${options.example}/${options.backend}] FAILED at ${JSON.stringify(browserDiagnostics?.state.progress)}`,
    );
    console.error(browserDiagnostics?.state.chromium.slice(-12000) ?? 'No Chromium stderr was captured.');
    throw error;
  } finally {
    try {
      if (browserDiagnostics) {
        metadata.browserDiagnostics = browserDiagnostics.state;
        await browserDiagnostics.save();
      }
      await fs.writeFile(path.join(options.output, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
    } finally {
      try {
        await browser?.close();
      } finally {
        await server?.close();
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await capturePreview(parseOptions(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
