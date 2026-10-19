import { spawn } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const host = '127.0.0.1';
const port = Number(process.env.RZMPS_BENCHMARK_PORT ?? 4173);
const durationMs = Number(process.env.RZMPS_BENCHMARK_DURATION_MS ?? 4000);
const warmupMs = Number(process.env.RZMPS_BENCHMARK_WARMUP_MS ?? 1000);
const timeoutMs = Number(process.env.RZMPS_BENCHMARK_TIMEOUT_MS ?? 180_000);
const openBrowser = process.argv.includes('--open') || process.argv.includes('--headed');
const useVsync = process.argv.includes('--vsync');
const pacingMode = useVsync ? 'vsync' : 'uncapped';
const suite = process.env.RZMPS_BENCHMARK_SUITE ?? '';
const caseFilter = process.env.RZMPS_BENCHMARK_CASE ?? '';
const viewport = {
  width: Number(process.env.RZMPS_BENCHMARK_WIDTH ?? 1280),
  height: Number(process.env.RZMPS_BENCHMARK_HEIGHT ?? 720),
};
const demoRoot = fileURLToPath(new URL('..', import.meta.url));
const viteBin = fileURLToPath(new URL('../../../node_modules/.bin/vite', import.meta.url));
const url = `http://${host}:${port}/?benchmark=1&durationMs=${durationMs}&warmupMs=${warmupMs}${suite ? `&suite=${encodeURIComponent(suite)}` : ''}${caseFilter ? `&case=${encodeURIComponent(caseFilter)}` : ''}`;

function formatNumber(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForServer(serverUrl, timeoutMs = 30_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(serverUrl);
      if (response.ok) return;
    } catch {
      await wait(250);
    }
  }

  throw new Error(`Timed out waiting for benchmark server at ${serverUrl}`);
}

function startServer() {
  const child = spawn(
    viteBin,
    [
      'preview',
      '--host',
      host,
      '--port',
      String(port),
      '--strictPort',
    ],
    {
      cwd: demoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  child.stdout.on('data', (data) => process.stderr.write(data));
  child.stderr.on('data', (data) => process.stderr.write(data));

  return child;
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
  const server = startServer();
  let browser;
  let pageError;
  const gpuValidationErrors = [];

  try {
    await waitForServer(`http://${host}:${port}/`);

    browser = await puppeteer.launch({
      headless: openBrowser ? false : 'new',
      args: getChromeArgs(),
      defaultViewport: viewport,
    });

    const page = await browser.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') {
        const value = message.text();
        console.error(`[browser ${message.type()}] ${value}`);
        if (/GPUValidationError|Compute pipeline creation failed/.test(value)) {
          gpuValidationErrors.push(value);
        }
      }
    });
    page.on('pageerror', (error) => {
      pageError = error;
      console.error(`[browser pageerror] ${error.stack ?? error.message}`);
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const browserHardware = await collectBrowserHardware(page);
    try {
      await page.waitForFunction(
        'window.__RZMPS_BENCHMARK_DONE__ === true',
        { timeout: timeoutMs },
      );
    } catch (error) {
      if (pageError) {
        throw pageError;
      }

      const progress = await page.evaluate(() => ({
        activeCase: document.querySelector('.benchmark-status span')?.textContent,
        status: document.querySelector('.benchmark-status small')?.textContent,
        results: window.__RZMPS_BENCHMARK_RESULTS__ ?? [],
      })).catch(() => null);

      if (progress) {
        console.error('Benchmark timed out with page progress:');
        console.error(JSON.stringify(progress, null, 2));
      }

      throw error;
    }

    const results = await page.evaluate(() => window.__RZMPS_BENCHMARK_RESULTS__ ?? []);
    if (pageError) throw pageError;
    if (gpuValidationErrors.length > 0) {
      throw new Error(`WebGPU validation failed: ${gpuValidationErrors[0]}`);
    }
    const browserVersion = await browser.version();
    const metadata = {
      browser: browserVersion,
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
        `update LOD ${result.updateLODEnabled ? 'on' : 'off'}`,
        `count LOD ${result.countLODEnabled ? 'on' : 'off'}`,
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
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}

runBenchmark().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
