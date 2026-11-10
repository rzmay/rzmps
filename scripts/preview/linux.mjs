import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { previewBrowserArguments } from './browserSettings.mjs';
import { attachBrowserDiagnostics } from './browserDiagnostics.mjs';

async function runInLinux() {
  const puppeteer = createRequire('/home/pptruser/package.json')('puppeteer');
  const options = JSON.parse(await fs.readFile('/options.json', 'utf8'));
  const types = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.wasm': 'application/wasm',
  };
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const file = path.resolve('/site', '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith('/site/')) {
        res.writeHead(404).end();
        return;
      }
      const bytes = await fs.readFile(file);
      res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
      res.end(bytes);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser, diagnostics, timeout;
  try {
    const args = previewBrowserArguments({ platform: 'linux', ci: true });
    browser = await puppeteer.launch({
      headless: true,
      args,
      defaultViewport: { width: options.width, height: options.height, deviceScaleFactor: 1 },
    });
    const page = await browser.newPage();
    diagnostics = await attachBrowserDiagnostics(browser, page, options, args);
    await diagnostics.snapshot();
    page.on('console', message => {
      if (['warn', 'error'].includes(message.type())) console.warn(`[browser ${message.type()}] ${message.text()}`);
    });
    page.on('pageerror', error => diagnostics.report({ phase: 'page-error', message: error.stack }));
    diagnostics.report({ phase: 'page-navigation' });
    await page.goto(`http://127.0.0.1:${server.address().port}/?preview=1`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.rzmpsPreview);
    const result = await Promise.race([
      page.evaluate(options => window.rzmpsPreview.capture(options), options),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Capture exceeded 180 seconds')), 180000);
      }),
    ]);
    if (result.backend !== options.backend) throw new Error('Requested rendering backend was not used');
    for (const [index, frame] of result.frames.entries()) {
      await fs.writeFile(`/output/frame-${index}.png`, Buffer.from(frame.data.split(',')[1], 'base64'));
    }
    const { frames, contactSheet, ...metadata } = result;
    await fs.writeFile(
      '/output/result.json',
      JSON.stringify({ ...metadata, captures: frames.map(({ data, ...frame }) => frame) }, null, 2) + '\n',
    );
    console.log(`PASS: ${options.example}, ${result.backend}, ${frames.length} frame(s)`);
  } catch (error) {
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    await diagnostics?.save();
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}

async function reproduce() {
  const root = path.resolve(import.meta.dirname, '../..');
  const argv = process.argv.slice(2);
  let site;
  const siteIndex = argv.indexOf('--site');
  if (siteIndex >= 0) {
    if (!argv[siteIndex + 1]) throw new Error('--site requires a production bundle directory');
    site = path.resolve(argv.splice(siteIndex, 2)[1]);
  }
  const { parseOptions } = await import('./capture.mjs');
  const { discoverExamples } = await import('../docs/examples.mjs');
  const { previewArguments } = await import('../docs/preview-settings.mjs');
  const exampleIndex = argv.indexOf('--example');
  const example = discoverExamples().find(
    entry => entry.id === (exampleIndex >= 0 ? argv[exampleIndex + 1] : 'fireflies'),
  );
  if (!example) throw new Error('Unknown example');
  const defaults = parseOptions(previewArguments(example, path.join(root, 'benchmark-results/preview-linux')));
  // CLI options override metadata defaults; parseArgs rejects duplicate options, so merge option pairs first.
  const pairs = new Map(
    previewArguments(example, defaults.output).reduce((all, value, index, values) => {
      if (index % 2 === 0) all.push([value, values[index + 1]]);
      return all;
    }, []),
  );
  for (let index = 0; index < argv.length; index += 2) pairs.set(argv[index], argv[index + 1]);
  const options = parseOptions([...pairs].flat());
  await fs.mkdir(options.output, { recursive: true });
  if (!site) {
    const { build } = await import('vite');
    site = path.join(options.output, 'site');
    await build({
      root: path.join(root, 'apps/demo'),
      configFile: path.join(root, 'apps/demo/vite.config.mjs'),
      build: { outDir: site, emptyOutDir: true },
    });
  }
  await fs.access(path.join(site, 'index.html'));
  const configuration = path.join(options.output, 'options.json');
  await fs.writeFile(configuration, JSON.stringify({ ...options, output: '/output' }));
  const version = createRequire(import.meta.url)('puppeteer/package.json').version;
  const image = `ghcr.io/puppeteer/puppeteer:${version}`;
  const args = [
    'run',
    '--rm',
    '--platform',
    'linux/amd64',
    '--cpus',
    '2',
    '--memory',
    '7g',
    '--shm-size',
    '1g',
    '--user',
    '0',
    '--env',
    'PUPPETEER_CACHE_DIR=/home/pptruser/.cache/puppeteer',
    '--env',
    'CI=true',
    '--mount',
    `type=bind,source=${site},target=/site,readonly`,
    '--mount',
    `type=bind,source=${import.meta.dirname},target=/tools,readonly`,
    '--mount',
    `type=bind,source=${configuration},target=/options.json,readonly`,
    '--mount',
    `type=bind,source=${options.output},target=/output`,
    '--entrypoint',
    'node',
    image,
    '/tools/linux.mjs',
    '--inside-container',
  ];
  console.log(`Reproducing on Linux/amd64 with ${image}. Docker/emulation differs from a native GitHub runner.`);
  const child = spawn('docker', args, { stdio: 'inherit' });
  let timer;
  try {
    timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, 300000);
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    if (code !== 0) throw new Error(`Linux reproduction failed (exit ${code}); diagnostics: ${options.output}`);
  } finally {
    clearTimeout(timer);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--inside-container')) await runInLinux();
    else await reproduce();
  } catch (error) {
    console.error(error.stack);
    process.exitCode = 1;
  }
}
