import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createSiteServer } from '../../../scripts/site/serve.mjs';
import { validateBenchmark } from '../../../scripts/benchmark-payload.mjs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const host = '127.0.0.1';
const port = Number(process.env.RZMPS_BENCHMARK_PORT ?? 0);
const { values } = parseArgs({ options: {
  dist: { type: 'string' }, output: { type: 'string' },
  open: { type: 'boolean' }, headed: { type: 'boolean' }, vsync: { type: 'boolean' },
} });
const profile = process.env.RZMPS_BENCHMARK_PROFILE ?? 'default';
if (!['default', 'ci'].includes(profile)) throw new Error('Unknown benchmark profile');
const durationMs = Number(process.env.RZMPS_BENCHMARK_DURATION_MS ?? 4000);
const warmupMs = Number(process.env.RZMPS_BENCHMARK_WARMUP_MS ?? 1000);
const timeoutMs = Number(process.env.RZMPS_BENCHMARK_TIMEOUT_MS ?? 180_000);
const openBrowser = values.open || values.headed;
const useVsync = values.vsync;
const pacingMode = useVsync ? 'vsync' : 'uncapped';
const suite = process.env.RZMPS_BENCHMARK_SUITE ?? '';
const caseFilter = process.env.RZMPS_BENCHMARK_CASE ?? '';
const viewport = {
  width: Number(process.env.RZMPS_BENCHMARK_WIDTH ?? 1280),
  height: Number(process.env.RZMPS_BENCHMARK_HEIGHT ?? 720),
};
for (const [name, value] of Object.entries({ durationMs, warmupMs, timeoutMs, ...viewport })) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
}
const demoRoot = fileURLToPath(new URL('..', import.meta.url));
const directory = values.dist ? path.resolve(values.dist) : path.join(demoRoot, 'benchmark-dist');

function formatNumber(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function isExpectedWebGPUTeardownError(error) {
  const description = typeof error === 'string'
    ? error
    : `${error?.name ?? ''}: ${error?.message ?? String(error)}`;
  return description.includes('OperationError')
    && description.includes('Instance dropped in popErrorScope');
}

function getChromeArgs() {
  const args = [
    '--disable-dev-shm-usage',
    '--enable-precise-memory-info',
  ];

  if (process.env.CI === 'true') {
    args.push(
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--enable-unsafe-webgpu',
      '--use-webgpu-adapter=swiftshader',
      '--use-gpu-in-tests',
    );
  } else {
    args.push('--use-angle=default');
  }

  if (!useVsync) {
    args.push(
      '--disable-frame-rate-limit',
      '--disable-gpu-vsync',
    );
  }

  return args;
}

function collectNodeHardware() {
  const cpus = os.cpus();
  const firstCpu = cpus[0];

  return {
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: firstCpu?.model ?? 'unknown',
    logicalCores: cpus.length,
    totalMemoryGB: os.totalmem() / (1024 ** 3),
  };
}

async function collectBrowserHardware(page) {
  return page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    let webglVendor = 'unknown';
    let webglRenderer = 'unknown';

    if (gl) {
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        webglVendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
        webglRenderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
      } else {
        webglVendor = gl.getParameter(gl.VENDOR);
        webglRenderer = gl.getParameter(gl.RENDERER);
      }
    }

    const adapter = await navigator.gpu?.requestAdapter();
    const adapterInfo = adapter?.info;

    return {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGB: navigator.deviceMemory,
      devicePixelRatio: window.devicePixelRatio,
      webglVendor,
      webglRenderer,
      webgpuAdapter: adapterInfo ? {
        vendor: adapterInfo.vendor,
        architecture: adapterInfo.architecture,
        device: adapterInfo.device,
        description: adapterInfo.description,
      } : null,
      webgpuFeatures: adapter ? Array.from(adapter.features).sort() : [],
      webgpuLimits: adapter ? {
        maxBufferSize: adapter.limits.maxBufferSize,
        maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
        maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize,
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      } : null,
    };
  });
}

async function runBenchmark() {
  const server = createSiteServer(directory);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const url = `http://${host}:${server.address().port}/benchmark.html?benchmark=1&profile=${profile}&durationMs=${durationMs}&warmupMs=${warmupMs}${suite ? `&suite=${encodeURIComponent(suite)}` : ''}${caseFilter ? `&case=${encodeURIComponent(caseFilter)}` : ''}`;
  let browser;
  let pageError;
  let benchmarkValidated = false;
  const gpuValidationErrors = [];
  let page;

  try {
    browser = await puppeteer.launch({
      headless: openBrowser ? false : 'new',
      args: getChromeArgs(),
      defaultViewport: viewport,
      // waitForFunction keeps a CDP call open for the measurement window.
      protocolTimeout: timeoutMs + 15_000,
    });

    page = await browser.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') {
        const value = message.text();
        console.error(`[browser ${message.type()}] ${value}`);
        if (/GPUValidationError|Compute pipeline creation failed/.test(value)) {
          gpuValidationErrors.push(value);
        }
      }
    });
    page.on('error', (error) => {
      if (!isExpectedWebGPUTeardownError(error)) pageError = error;
    });
    page.on('pageerror', (error) => {
      if (isExpectedWebGPUTeardownError(error)) return;
      pageError = error;
      console.error(`[browser pageerror] ${error.stack ?? error.message}`);
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const browserHardware = await collectBrowserHardware(page);
    await page.waitForFunction(
      'window.__RZMPS_BENCHMARK_DONE__ === true',
      { timeout: timeoutMs, polling: 1000 },
    );

    const results = await page.evaluate(() => window.__RZMPS_BENCHMARK_RESULTS__ ?? []);
    if (pageError) throw pageError;
    if (gpuValidationErrors.length > 0) {
      throw new Error(`WebGPU validation failed: ${gpuValidationErrors[0]}`);
    }
    const expected = await page.evaluate(() => window.__RZMPS_BENCHMARK_CASES__);
    if (!expected?.length || JSON.stringify(expected) !== JSON.stringify(results.map(row => row.name))) {
      throw new Error('Benchmark returned an incomplete case list');
    }
    const browserVersion = await browser.version();
    const metadata = {
      browser: browserVersion,
      harnessVersion: 1,
      profile,
      viewport,
      durationMs,
      warmupMs,
      timeoutMs,
      measuredAt: new Date().toISOString(),
      mode: openBrowser ? 'visible browser' : 'headless browser',
      framePacing: pacingMode,
      hardware: {
        ...collectNodeHardware(),
        ...browserHardware,
      },
    };
    validateBenchmark({ metadata, results });
    benchmarkValidated = true;

    if (values.output) {
      await fs.mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
      await fs.writeFile(values.output, `${JSON.stringify({ metadata, results }, null, 2)}\n`);
      console.log(`RZMPS benchmark complete: wrote ${results.length} cases to ${path.resolve(values.output)}`);
      return;
    }
    console.log('RZMPS browser benchmark');
    console.log(`Browser: ${metadata.browser}`);
    console.log(`Viewport: ${viewport.width}x${viewport.height}`);
    console.log(`Mode: ${openBrowser ? 'visible browser' : 'headless browser'}`);
    console.log(`Frame pacing: ${pacingMode}`);
    console.log(`OS: ${metadata.hardware.os}`);
    console.log(`CPU: ${metadata.hardware.cpu} (${metadata.hardware.logicalCores} logical cores)`);
    console.log(`Memory: ${formatNumber(metadata.hardware.totalMemoryGB, 1)}GB system, ${metadata.hardware.deviceMemoryGB ?? 'n/a'}GB browser hint`);
    console.log(`GPU/WebGL: ${metadata.hardware.webglRenderer} (${metadata.hardware.webglVendor})`);
    if (metadata.hardware.webgpuAdapter) {
      const adapter = metadata.hardware.webgpuAdapter;
      console.log(`GPU/WebGPU: ${adapter.description || adapter.device || adapter.architecture || 'unknown'} (${adapter.vendor || 'unknown vendor'})`);
      console.log(`WebGPU features: ${metadata.hardware.webgpuFeatures.join(', ') || 'none reported'}`);
    }
    console.log(`Device pixel ratio: ${metadata.hardware.devicePixelRatio}`);
    console.log(`Duration: ${(durationMs / 1000).toFixed(1)}s measured per case after ${(warmupMs / 1000).toFixed(1)}s warmup`);
    if (suite) console.log(`Suite: ${suite}`);
    if (caseFilter) console.log(`Case filter: ${caseFilter}`);
    console.log('Metric notes: FPS and frame time include the real browser render loop; update ms is the measured ParticleSystem.update() slice.');

    results.forEach((result) => {
      console.log([
        result.name,
        `${result.particles.toLocaleString()} particles`,
        `${result.minSimulatedParticles.toLocaleString()}-${result.maxSimulatedParticles.toLocaleString()} simulated`,
        `cap ${result.maxParticlesLimit.toLocaleString()}`,
        `population LOD ${result.lodEnabled ? 'on' : 'off'}`,
        `renderer ${result.rendererType ?? 'unknown'}`,
        `gpu ${result.gpuProcessingRequested ? 'forced' : 'off'}`,
        `gpu active ${result.gpuActiveFrames ?? 0}/${result.gpuMeasuredFrames ?? 0}`,
        `${result.frames.toLocaleString()} rendered frames`,
        `avg ${formatNumber(result.avgFps)} fps`,
        `1% low ${formatNumber(result.onePercentLowFps)} fps`,
        `avg frame ${formatNumber(result.avgFrameMs, 2)}ms`,
        `p99 frame ${formatNumber(result.p99FrameMs, 2)}ms`,
        `max frame ${formatNumber(result.maxFrameMs, 2)}ms`,
        `avg update ${formatNumber(result.avgUpdateMs, 2)}ms`,
        `p95 update ${formatNumber(result.p95UpdateMs, 2)}ms`,
        `avg dispatches ${formatNumber(result.avgComputeDispatches, 2)}`,
        `sim dispatches ${formatNumber(result.avgSimulationDispatches, 2)}`,
        `render dispatches ${formatNumber(result.avgRenderOutputDispatches, 2)}`,
        `simulation node builds ${result.simulationNodeBuilds ?? 'n/a'}`,
        `pipeline builds ${result.gpuConfigurationStats?.pipelineBuilds ?? 'n/a'}`,
        `resource builds ${result.gpuConfigurationStats?.resourceBuilds ?? 'n/a'}`,
        `parameter uploads ${result.gpuConfigurationStats?.parameterUploads ?? 'n/a'}`,
        `max dispatches ${result.maxComputeDispatches ?? 'n/a'}`,
        `GPU buffer ${formatNumber(result.estimatedPersistentGPUBufferMB, 2)}MB`,
        `max heap ${result.maxHeapMB > 0 ? `${formatNumber(result.maxHeapMB, 1)}MB` : 'n/a'}`,
      ].join(' | '));
      if (result.dynamicSpatialDiagnostics) {
        const diagnostics = result.dynamicSpatialDiagnostics;
        console.log([
          '  dynamic spatial',
          `registry avg ${formatNumber(diagnostics.averageRegistryUpdateMs, 3)}ms`,
          `collision avg ${formatNumber(diagnostics.averageBackendUpdateMs, 3)}ms`,
          `updates ${diagnostics.updates}`,
          `stats ${JSON.stringify(diagnostics.registryStats ?? diagnostics.collisionStats ?? {})}`,
        ].join(' | '));
      }
    });

    console.log('RZMPS_BENCHMARK_JSON_START');
    console.log(JSON.stringify({ metadata, results }, null, 2));
    console.log('RZMPS_BENCHMARK_JSON_END');
  } catch (error) {
    if (benchmarkValidated && isExpectedWebGPUTeardownError(error)) return;

    const progress = await page?.evaluate(() => ({
      ...window.__RZMPS_BENCHMARK_PROGRESS__,
      activeCase: document.querySelector('.benchmark-status span')?.textContent,
      status: document.querySelector('.benchmark-status small')?.textContent,
      completedResults: window.__RZMPS_BENCHMARK_RESULTS__?.length ?? 0,
      lastCompletedCase: window.__RZMPS_BENCHMARK_RESULTS__?.at(-1)?.name,
    })).catch(() => null);

    if (progress) {
      console.error('Benchmark failed with page progress:');
      console.error(JSON.stringify(progress, null, 2));
    }

    if (values.output) {
      await fs.mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
      await fs.writeFile(`${values.output}.failure.json`, JSON.stringify({ url, progress, error: String(error), pageError: String(pageError ?? '') }, null, 2));
      await page?.screenshot({ path: `${values.output}.failure.png`, timeout: 5000 }).catch(() => {});
    }
    throw pageError ?? error;
  } finally {
    try {
      if (browser) {
        try {
          await browser.close();
        } catch (error) {
          // Chromium/SwiftShader can reject WebGPU error-scope cleanup after all
          // benchmark results have already been collected and validated.
          if (!isExpectedWebGPUTeardownError(error)) throw error;
        }
      }
    } finally {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
}

runBenchmark().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
