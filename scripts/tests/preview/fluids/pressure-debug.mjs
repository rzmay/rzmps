import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../site/dev.mjs';
import { openFixture } from './openFixture.mjs';
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') { errors.push(m.text()); console.log(m.text()); } });
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${
    path.resolve(import.meta.dirname, 'fixtures/corrective.html')}?bricks=2&cells=3&obstacle=sphere&sources=32`,
  errors);
  await page.evaluate(() => window.testPreparation());
  await page.evaluate(() => window.testGrowth());
  await page.evaluate(() => window.testProjection('Multigrid'));
  console.log(JSON.stringify(await page.evaluate(() => window.traceMultigrid())));
} finally { await browser?.close(); await site.close(); }
