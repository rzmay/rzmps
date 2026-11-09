import { readBenchmarkOptions } from '../../../scripts/benchmark-selection.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createSiteServer } from '../../../scripts/site/serve.mjs';
import { validateBenchmark, validateBenchmarkCompletion } from '../../../scripts/benchmark-payload.mjs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { isExpectedWebGPUTeardownError, runBenchmarkWithRetry, withBenchmarkTimeout, cleanupBenchmark } from '../../../scripts/benchmark-failures.mjs';

const host = '127.0.0.1';
const port = Number(process.env.RZMPS_BENCHMARK_PORT ?? 0);
const { values } = parseArgs({ options: {
  dist: { type: 'string' }, output: { type: 'string' },
  selection: { type: 'string', default: 'full' }, 'simulation-clock': { type: 'string', default: 'wall' },
  open: { type: 'boolean' }, headed: { type: 'boolean' }, vsync: { type: 'boolean' },
} });
const { selection, simulationClock } = readBenchmarkOptions(new URLSearchParams({
  selection: values.selection, simulationClock: values['simulation-clock'],
}).toString());
const profile = process.env.RZMPS_BENCHMARK_PROFILE ?? 'default';
if (!['default', 'ci'].includes(profile)) throw new Error('Unknown benchmark profile');
const durationMs = Number(process.env.RZMPS_BENCHMARK_DURATION_MS ?? 4000);
const warmupMs = Number(process.env.RZMPS_BENCHMARK_WARMUP_MS ?? 1000);
const timeoutMs = Number(process.env.RZMPS_BENCHMARK_TIMEOUT_MS ?? 300_000);
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


function getChromeArgs() {
  const args = [
    '--disable-dev-shm-usage',
    '--enable-precise-memory-info',
  ];

  if (process.env.CI === 'true') {
    // Software shader compilation can trip Chromium's GPU watchdog before warmup finishes.
    // Three.js uses the same workaround: https://github.com/mrdoob/three.js/pull/33650
    // The sample timeout still bounds hangs, and device/validation failures remain fatal.
    args.push(
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu-watchdog',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--enable-unsafe-webgpu',
      '--use-webgpu-adapter=swiftshader',
      '--use-gpu-in-tests',
    );

    if (process.platform === 'linux') {
      // ANGLE and WebGPU must share Vulkan-backed images for the canvas swapchain on software CI.
      args.push('--enable-features=Vulkan', '--use-vulkan=swiftshader', '--disable-vulkan-surface');
    }
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

async function runBenchmark(attempt = 1) {
  const server = createSiteServer(directory);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const url = `http://${host}:${server.address().port}/benchmark.html?benchmark=1&profile=${profile}&durationMs=${durationMs}&warmupMs=${warmupMs}&selection=${selection}&simulationClock=${simulationClock}${suite ? `&suite=${encodeURIComponent(suite)}` : ''}${caseFilter ? `&case=${encodeURIComponent(caseFilter)}` : ''}`;
  let browser;
  let pageError;
  let benchmarkValidated = false;
  let outputWritten = false;
  let primaryError;
  let closing = false;
  let rejectMeasurement;
  const measurementFailure = new Promise((_resolve, reject) => { rejectMeasurement = reject; });
  // A browser can fail during navigation, before the completion waiter has been attached.
  void measurementFailure.catch(() => {});
  const failMeasurement = error => {
    pageError ??= error;
    rejectMeasurement(pageError);
  };
  const observe = operation => Promise.race([Promise.resolve().then(operation), measurementFailure]);
  // One deadline covers launch, navigation, hardware probes and measurement. It
  // does not depend on a responsive page or an attached waitForFunction call.
  const deadline = setTimeout(() => {
    failMeasurement(new Error(`Benchmark attempt timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  const deviceLossChecks = [];
  const gpuValidationErrors = [];
  let page;
  const startedAt = performance.now();
  let stage = 'Launching browser';
  const logProgress = message => console.error(`[benchmark attempt ${attempt}] ${message}`);
  logProgress(`${stage} (${profile} profile; ${(warmupMs / 1000).toFixed(1)}s warmup + ${
    (durationMs / 1000).toFixed(1)}s measurement per case; timeout ${timeoutMs / 1000}s)`);
  const heartbeat = setInterval(() => {
    logProgress(`${stage}; ${Math.round((performance.now() - startedAt) / 1000)}s elapsed`);
  }, 10_000);
  heartbeat.unref();

  try {
    await observe(async () => {
      browser = await puppeteer.launch({
        headless: openBrowser ? false : 'new',
        args: getChromeArgs(),
        defaultViewport: viewport,
        // waitForFunction keeps a CDP call open for the measurement window.
        protocolTimeout: timeoutMs + 15_000,
      });
      // If launch completed after the deadline, cleanup may already have run.
      if (primaryError) {
        browser.process()?.kill('SIGKILL');
        throw primaryError;
      }
    });

    page = await observe(() => browser.newPage());
    page.on('console', (message) => {
      if (message.text().startsWith('[benchmark] Case ')) {
        stage = message.text().slice('[benchmark] '.length);
        logProgress(stage);
      }
      if (message.type() === 'error') {
        const value = message.text();
        console.error(`[browser ${message.type()}] ${value}`);
        if (/GPUValidationError|Compute pipeline creation failed/.test(value)) {
          gpuValidationErrors.push(value);
          if (!closing) failMeasurement(new Error(`WebGPU validation failed: ${value}`));
        }
        if (/WebGPU.*Device Lost/i.test(value) && !closing) {
          // Completion is recorded in the page before Chromium may report shutdown-related device loss.
          const check = page.evaluate(() => window.__RZMPS_BENCHMARK_DONE__ === true).then(done => {
            if (!done) failMeasurement(new Error(value));
          }).catch(error => { if (!closing) failMeasurement(error); });
          deviceLossChecks.push(check);
        }
      }
    });
    page.on('error', (error) => {
      if (!closing || !isExpectedWebGPUTeardownError(error)) failMeasurement(error);
    });
    page.on('pageerror', (error) => {
      if (closing && isExpectedWebGPUTeardownError(error)) return;
      failMeasurement(error);
      console.error(`[browser pageerror] ${error.stack ?? error.message}`);
    });
    stage = 'Loading benchmark page';
    logProgress(stage);
    await observe(() => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }));
    const browserHardware = await observe(() => collectBrowserHardware(page));
    await Promise.race([
      page.waitForFunction('window.__RZMPS_BENCHMARK_DONE__ === true || !!window.__RZMPS_BENCHMARK_ERROR__',
        { timeout: timeoutMs, polling: 1000 }),
      measurementFailure,
    ]);
    await observe(() => Promise.all(deviceLossChecks));

    const completion = await observe(() => page.evaluate(() => ({
      error: window.__RZMPS_BENCHMARK_ERROR__,
      expected: window.__RZMPS_BENCHMARK_CASES__,
      results: window.__RZMPS_BENCHMARK_RESULTS__,
    })));
    if (pageError) throw pageError;
    if (gpuValidationErrors.length > 0) {
      throw new Error(`WebGPU validation failed: ${gpuValidationErrors[0]}`);
    }
    const results = validateBenchmarkCompletion(completion);
    const browserVersion = await observe(() => browser.version());
    const metadata = {
      browser: browserVersion,
      harnessVersion: 1,
      selection, simulationClock, suite, caseFilter,
      simulationDeltaTime: simulationClock === 'fixed' ? 1 / 60 : undefined,
      sampleAttempts: attempt,
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
    clearTimeout(deadline);
    logProgress(`Validated ${results.length} cases in ${((performance.now() - startedAt) / 1000).toFixed(1)}s`);

    if (values.output) {
      await fs.mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
      await fs.writeFile(values.output, `${JSON.stringify({ metadata, results }, null, 2)}\n`);
      outputWritten = true;
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
        result.minSimulatedParticles === result.maxSimulatedParticles
          ? `${result.maxSimulatedParticles.toLocaleString()} particles`
          : `${result.minSimulatedParticles.toLocaleString()}–${result.maxSimulatedParticles.toLocaleString()} particles`,
        `cap ${result.maxParticlesLimit.toLocaleString()}`,
        `LOD ${result.lodEnabled ? 'on' : 'off'}`,
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
    primaryError = error;
    clearTimeout(deadline);

    const progress = await withBenchmarkTimeout(() => page?.evaluate(() => ({
      ...window.__RZMPS_BENCHMARK_PROGRESS__,
      activeCase: document.querySelector('.benchmark-status span')?.textContent,
      status: document.querySelector('.benchmark-status small')?.textContent,
      completedResults: window.__RZMPS_BENCHMARK_RESULTS__?.length ?? 0,
      lastCompletedCase: window.__RZMPS_BENCHMARK_RESULTS__?.at(-1)?.name,
    })), 5000, 'Reading failure progress').catch(() => null);

    if (progress) {
      console.error('Benchmark failed with page progress:');
      console.error(JSON.stringify(progress, null, 2));
    }

    if (values.output) {
      try {
        await fs.mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
        const failureOutput = `${values.output}.attempt-${attempt}`;
        const diagnostics = { url, attempt, progress, error: String(error),
          pageError: String(pageError ?? ''), gpuValidationErrors };
        await fs.writeFile(`${failureOutput}.failure.json`, JSON.stringify(diagnostics, null, 2));
        await withBenchmarkTimeout(() => page?.screenshot({ path: `${failureOutput}.failure.png`, timeout: 5000 }),
          5000, 'Saving failure screenshot').catch(() => {});
      } catch (diagnosticError) {
        logProgress(`Could not save failure diagnostics: ${diagnosticError.message ?? diagnosticError}`);
      }
    }
    throw error;
  } finally {
    clearTimeout(deadline);
    clearInterval(heartbeat);
    logProgress('Closing browser and test server');
    closing = true;
    let cleanupError;
    try {
      await cleanupBenchmark([
        { name: 'Draining browser work', run: () => withBenchmarkTimeout(() => page?.evaluate(async () => {
          await window.__RZMPS_BENCHMARK_SHUTDOWN__?.();
        }), 3000, 'Draining browser work').catch(error => {
          logProgress(`Browser drain incomplete: ${error.message ?? error}`);
        }) },
        { name: 'Closing browser', run: async () => {
          if (!browser) return;
          try { await withBenchmarkTimeout(() => browser.close(), 5000, 'Closing browser'); }
          catch (error) {
            browser.process()?.kill('SIGKILL');
            if (!isExpectedWebGPUTeardownError(error)) throw error;
          }
        } },
        { name: 'Closing test server', run: () => withBenchmarkTimeout(() => {
          server.closeAllConnections();
          return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }, 5000, 'Closing test server') },
      ], primaryError, (name, error) => logProgress(`${name}: ${error.message ?? error}`));
    } catch (error) { cleanupError = error; }
    // GPU errors can arrive while draining the final submitted work. They remain
    // fatal even if a results snapshot was already read and saved.
    const lateError = primaryError ? undefined : gpuValidationErrors.length
      ? new Error(`WebGPU validation failed: ${gpuValidationErrors[0]}`) : pageError ?? cleanupError;
    if (lateError) {
      if (outputWritten) await fs.rm(values.output, { force: true }).catch(error => {
        logProgress(`Could not remove invalid output: ${error.message ?? error}`);
      });
      throw lateError;
    }
  }
}

runBenchmarkWithRetry(runBenchmark, error => {
  console.warn(`Discarding failed sample and retrying once in a fresh browser: ${error.message ?? error}`);
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
