import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../scripts/site/dev.mjs';

const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${site.demo.httpServer.address().port}/`
    + '?preset=FLIP%20Fluid&scene=Fluid%20Teapot&renderer=webgpu');
  await page.waitForFunction(() => [...document.querySelectorAll('.lil-gui .lil-controller')]
    .some(element => element.textContent.includes('Automatic Tipping')));
  const controls = await page.evaluate(async () => {
    [...document.querySelectorAll('.lil-gui .lil-title')]
      .find(element => element.textContent === 'Scene Settings')?.click();
    const find = name => [...document.querySelectorAll('.lil-gui .lil-controller')]
      .find(element => element.querySelector('.lil-name')?.textContent === name);
    const defaults = {
      automatic: find('Automatic Tipping').querySelector('input').checked,
      angle: Number(find('Automatic Tip Angle').querySelector('input').value),
      period: Number(find('Tip Period (Seconds)').querySelector('input').value),
    };
    const slider = find('Tip (Degrees)').querySelector('input');
    slider.value = '40';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const auto = find('Automatic Tipping').querySelector('input[type="checkbox"]');
    const initial = auto.checked;
    auto.click();
    const enabled = auto.checked;
    auto.click();
    return { defaults, initial, enabled, value: Number(slider.value), disabled: !auto.checked,
      angle: Boolean(find('Automatic Tip Angle')), period: Boolean(find('Tip Period (Seconds)')) };
  });
  assert.deepEqual(controls, {
    defaults: { automatic: true, angle: 45, period: 10 },
    initial: false, enabled: true, value: 40, disabled: true, angle: true, period: true,
  });
  await page.waitForFunction(() => {
    const row = [...document.querySelectorAll('.lil-controller')]
      .find(element => element.querySelector('.lil-name')?.textContent === 'Tip Period (Seconds)');
    const title = [...document.querySelectorAll('.lil-title')].find(element => element.textContent === 'System');
    return row && title && row.getBoundingClientRect().bottom <= title.getBoundingClientRect().top;
  });
  await new Promise(resolve => setTimeout(resolve, 500));
  await page.screenshot({ path: '/tmp/rzmps-teapot-gui.png' });
  assert.deepEqual(errors, []);
  console.log('Teapot Scene Settings controls:', JSON.stringify(controls));
} finally { await browser?.close(); await site.close(); }
