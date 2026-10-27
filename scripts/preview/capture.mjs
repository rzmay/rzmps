import fs from 'node:fs/promises';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build, preview } from 'vite';
import puppeteer from 'puppeteer';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

export function parseOptions(args) {
  const names = [
    'example', 'backend', 'frames', 'interval', 'warmup', 'delta-time',
    'width', 'height', 'output', 'seed', 'scene',
    'camera-position', 'camera-target', 'camera-fov', 'example-options',
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
  if (exampleOptions !== undefined && (!exampleOptions || Array.isArray(exampleOptions)
    || typeof exampleOptions !== 'object')) throw new Error('--example-options must be a JSON object');
  const options = {
    ...(exampleOptions === undefined ? {} : { exampleOptions }),
    example: values.example ?? 'fire',
    backend: values.backend ?? 'webgl',
    frames: Number(values.frames ?? 6),
    interval: Number(values.interval ?? 20),
    warmup: Number(values.warmup ?? 60),
    deltaTime: Number(values['delta-time'] ?? 1 / 60),
    width: Number(values.width ?? 800),
    height: Number(values.height ?? 600),
    seed: Number(values.seed ?? 1),
    scene: values.scene ?? null,
    cameraPosition: vector('camera-position', [8, 6, 12]),
    cameraTarget: vector('camera-target', [0, 2, 0]),
    cameraFov: Number(values['camera-fov'] ?? 50),
    output: path.resolve(values.output ?? `previews/${values.example ?? 'fire'}`),
  };
  if (!['webgl', 'webgpu'].includes(options.backend)) throw new Error('--backend must be webgl or webgpu');
  for (const key of ['frames', 'interval', 'width', 'height']) {
    if (!Number.isSafeInteger(options[key]) || options[key] <= 0) throw new Error(`--${key} must be a positive integer`);
  }
  if (!Number.isSafeInteger(options.warmup) || options.warmup < 0) throw new Error('--warmup must be a nonnegative integer');
  if (!Number.isSafeInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff) throw new Error('--seed must be an unsigned 32-bit integer');
  if (!Number.isFinite(options.deltaTime) || options.deltaTime <= 0) throw new Error('--delta-time must be positive and finite');
  if (!Number.isFinite(options.cameraFov) || options.cameraFov <= 0 || options.cameraFov >= 180) throw new Error('--camera-fov must be between 0 and 180 degrees');
  if (options.cameraPosition.every((v, i) => v === options.cameraTarget[i])) throw new Error('Camera position and target must differ');
  if (options.frames > 60 || options.width > 4096 || options.height > 4096 || options.warmup + options.interval * (options.frames - 1) > 100000) {
    throw new Error('Preview exceeds limits: 60 captures, 4096px dimensions, 100000 total steps');
  }
  const columns = Math.min(3, options.frames);
  const sheetPixels = columns * options.width * Math.ceil(options.frames / columns) * (options.height + 30);
  if (sheetPixels > 64000000) throw new Error('Contact sheet exceeds 64 megapixels; reduce frame count or dimensions');
  return options;
}

let demoBuild;
export async function capturePreview(options) {
  const root = path.resolve(import.meta.dirname, '../..');
  const diagnostics = { warnings: [], errors: [] };
  await fs.mkdir(options.output, { recursive: true });
  // Replace artifacts owned by this tool, preserving unrelated user files.
  for (const file of await fs.readdir(options.output)) {
    if (/^frame-\d+\.png$|^contact-sheet\.png$/.test(file)) await fs.unlink(path.join(options.output, file));
  }
  let server, browser;
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
    })().catch(error => { demoBuild = undefined; throw error; });
    viteConfig = await demoBuild;
    server = await preview({ ...viteConfig, preview: { host: '127.0.0.1', port: 0 } });
    const address = server.httpServer.address();
    const args = ['--disable-dev-shm-usage', '--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required'];
    if (process.env.CI === 'true') {
      args.push('--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader');
    } else args.push('--use-angle=default');
    browser = await puppeteer.launch({
      headless: true,
      args,
      defaultViewport: { width: options.width, height: options.height, deviceScaleFactor: 1 },
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(180000);
    page.on('console', message => {
      if (['error', 'warn'].includes(message.type())) {
        diagnostics[message.type() === 'error' ? 'errors' : 'warnings'].push(message.text());
      }
    });
    page.on('pageerror', error => diagnostics.errors.push(error.message));
    page.on('requestfailed', request => diagnostics.errors.push(`${request.url()}: ${request.failure()?.errorText}`));
    page.on('response', response => {
      if (response.status() >= 400) diagnostics.errors.push(`${response.status()} ${response.url()}`);
    });
    await page.goto(`http://127.0.0.1:${address.port}/?preview=1`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.rzmpsPreview);
    let captureTimeout, result;
    try {
      result = await Promise.race([
        page.evaluate(options => window.rzmpsPreview.capture(options), options),
        new Promise((_, reject) => {
          captureTimeout = setTimeout(() => reject(new Error('Timed out capturing preview after 180 seconds')), 180000);
        }),
      ]);
    } finally { clearTimeout(captureTimeout); }
    async function png(file, data) {
      const buffer = Buffer.from(data.split(',')[1], 'base64');
      if (buffer.length < 100 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`Invalid PNG: ${file}`);
      await fs.writeFile(path.join(options.output, file), buffer);
    }
    for (const [index, frame] of result.frames.entries()) {
      await png(`frame-${String(index).padStart(3, '0')}.png`, frame.data);
    }
    await png('contact-sheet.png', result.contactSheet);
    Object.assign(metadata, {
      status: 'complete',
      captures: result.frames.map(({ data, ...rest }) => rest),
      camera: result.camera,
      rendererInfo: result.rendererInfo,
      childValidation: result.childValidation,
      shaderBindings: Object.values((result.shaderBindings ?? []).reduce((stages, entry) => {
        const key = `${entry.stage}:${entry.name}`;
        const stage = stages[key] ??= { stage: entry.stage, name: entry.name, pipelines: 0, maxStorageBuffers: 0 };
        stage.pipelines += 1;
        stage.maxStorageBuffers = Math.max(stage.maxStorageBuffers, entry.storageBuffers);
        return stages;
      }, {})),
      userAgent: result.userAgent,
    });
    if (diagnostics.errors.length) throw new Error(`Browser errors: ${diagnostics.errors.join('\n')}`);
    console.log(`Captured ${options.frames} ${options.backend} frames in ${options.output}`);
    return metadata;
  } catch (error) {
    metadata.status = 'failed';
    diagnostics.errors.push(error.message);
    throw error;
  } finally {
    try { await fs.writeFile(path.join(options.output, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n'); }
    finally { try { await browser?.close(); } finally { await server?.close(); } }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await capturePreview(parseOptions(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
