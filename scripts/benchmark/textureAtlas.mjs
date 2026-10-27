import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const root = path.resolve(import.meta.dirname, '../..');
const server = await createServer({
  configFile: path.join(root, 'apps/demo/vite.config.mjs'),
  root: path.join(root, 'apps/demo'),
  server: { host: '127.0.0.1', port: 0, headers: {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  } },
  plugins: [{
    name: 'atlas-benchmark-page',
    configureServer(server) {
      server.middlewares.use('/atlas-benchmark', async (_request, response) => {
        const entry = `/@fs/${root}/scripts/benchmark/textureAtlas.browser.js`;
        const html = `<link rel="icon" href="data:,"><script type="module" src="${entry}"></script>`;
        response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        response.setHeader('Content-Type', 'text/html');
        response.end(await server.transformIndexHtml('/atlas-benchmark', html));
      });
    },
  }],
});

let browser;
try {
  await server.listen();
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=default'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/atlas-benchmark`);
  await page.waitForFunction(() => window.runAtlasBenchmark);
  const results = [];

  for (const backend of ['webgl', 'webgpu']) {
    const result = await page.evaluate(backend => window.runAtlasBenchmark(backend), backend);
    results.push(result);
    console.log(JSON.stringify(result, null, 2));
  }

  if (errors.length) throw new Error(errors.join('\n'));
  const output = path.resolve(process.argv[2] ?? '/tmp/rzmps-texture-atlas-benchmark.json');
  await fs.writeFile(output, JSON.stringify({ date: new Date().toISOString(), results }, null, 2) + '\n');
  console.log(`Saved ${output}`);
} finally {
  await browser?.close();
  await server.close();
}
