import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../site/dev.mjs';
import { openFixture } from './openFixture.mjs';
const output = process.argv[2] ?? '/tmp/rzmps-multigrid-transition'; await fs.mkdir(output, { recursive: true });
const site = await startSiteDev({ port: 0, host: '127.0.0.1' }); await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
  const fixture = path.resolve(import.meta.dirname, 'fixtures/topology-transition.html');
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`, errors);
  const results = [];
  const firstDifference = (a, b) => a.findIndex((value, i) => !Number.isFinite(value) || Math.abs(value - b[i]) > 1e-5);
  for (const warm of [false, true]) {
    const [a, b] = await page.evaluate(warm => window.transition(warm), warm);
    assert(a.inputs.every((values, i) => firstDifference(values, b.inputs[i]) < 0), 'fine physical inputs must match');
    let mismatch = null;
    const stages = [];
    for (let i = 0; i < a.trace.length; i++) {
      const expected = a.trace[i], actual = b.trace[i];
      assert.equal(expected.stage, actual.stage);
      const at = firstDifference(expected.values, actual.values);
      stages.push({ stage: expected.stage, level: expected.level,
        max: Math.max(...expected.values.map(Math.abs)), sum: expected.values.reduce((x, y) => x + y, 0) });
      if (at >= 0) {
        const channels = expected.values.length / expected.n ** 3, cell = Math.floor(at / channels), n = expected.n;
        mismatch = { stage: expected.stage, level: expected.level,
          coordinate: [cell % n, Math.floor(cell / n) % n, Math.floor(cell / (n * n))],
          component: at % channels, expected: expected.values[at], actual: actual.values[at] };
        break; // Downstream differences are consequences, not new diagnoses.
      }
    }
    results.push({ warmStart: warm, mismatch, stages });
  }
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ results, errors }, null, 2));
  console.log(JSON.stringify(results));
  assert.deepEqual(errors, []);
  assert(results.every(result => !result.mismatch), 'sparse topology transition diverges at the reported first stage');
} finally { await browser?.close(); await site.close(); }
