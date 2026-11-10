import assert from 'node:assert/strict';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../site/dev.mjs';

const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('console', message => {
    if (message.type() === 'error') {
      errors.push(message.text());
      console.error(message.text());
    }
  });
  await page.goto(`http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${
    path.resolve(import.meta.dirname, 'fixtures/subsystem-predicate.html')}`);
  await page.waitForFunction(() => window.ready);
  const continuous = await page.evaluate(() => window.runPredicateCase('continuous'));
  console.log('GPU continuous spray:', JSON.stringify(continuous));
  assert(continuous.parentGPU && continuous.childGPU && continuous.supported);
  assert.equal(continuous.children.length, 1, 'only the fast isolated source should emit');
  assert(continuous.children[0].position[0] > 1);
  assert.equal(continuous.disabled, 0, 'false must override the GPU predicate');
  assert.equal(continuous.replaced.length, 1);
  assert.equal(continuous.sameSourceClosure.length, 3, 'callback identity, not toString, invalidates pipelines');
  const spawn = await page.evaluate(() => window.runPredicateCase('spawn'));
  console.log('GPU captured spawn predicates:', JSON.stringify(spawn));
  assert(spawn.parentGPU && spawn.childGPU && spawn.supported);
  assert.equal(spawn.children.length, 3, 'spawn must use captured fast velocities despite the live velocity reset');
  assert(spawn.children.every(child => child.velocity[0] > 1));
  assert.equal(spawn.disabled, 0);
  const age = await page.evaluate(() => window.runPredicateCase('continuous', 'age'));
  assert.equal(age.children.length, 0, 'minimumAge is seconds, not the stored millisecond age');
  const eventNeighbors = await page.evaluate(() => window.runPredicateCase('spawn', 'spray-neighbors'));
  assert.equal(eventNeighbors.children.length, 1, 'event predicates can query current parent neighborhoods');
  assert(eventNeighbors.children[0].position[0] > 1);
  assert.deepEqual(errors, []);
} finally { await browser?.close(); await site.close(); }
