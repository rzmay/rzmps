import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { parse, compileScript } from '@vue/compiler-sfc';
import puppeteer from 'puppeteer';
import { browserArguments } from '../../preview/browser.mjs';

test(
  'documentation player stays on its poster for reduced motion, plays explicitly, and pauses offscreen',
  { timeout: 20000 },
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rzmps-player-test-'));
    const source = await fs.readFile(
      new URL('../../../apps/docs/.vitepress/theme/ExampleVideo.vue', import.meta.url),
      'utf8',
    );
    const { descriptor } = parse(source);
    const component = compileScript(descriptor, { id: 'preview', inlineTemplate: true }).content;
    let requests = 0,
      browser;
    const server = createServer(async (req, res) => {
      try {
        if (req.url === '/' || req.url === '/?offscreen')
          res.end(
            '<script type="importmap">{"imports":{"vue":"/vue.js","vitepress":"/base.js"}}</script' +
              '><div id="app"></div><script type="module">import {createApp} from "vue";import Playe' +
              'r from "/player.js";if(location.search)document.body.style.paddingTop="2000px";' +
              'createApp(Player,{source:"/preview.mp4",poster:"/poster.png",labe' +
              'l:"Test preview",width:64,height:48}).mount("#app");</script>',
          );
        else if (req.url === '/player.js') {
          res.setHeader('Content-Type', 'text/javascript');
          res.end(component);
        } else if (req.url === '/base.js') {
          res.setHeader('Content-Type', 'text/javascript');
          res.end('export const withBase = path => path;');
        } else if (req.url === '/vue.js') {
          res.setHeader('Content-Type', 'text/javascript');
          res.end(await fs.readFile(new URL('../../../node_modules/vue/dist/vue.esm-browser.js', import.meta.url)));
        } else if (req.url === '/preview.mp4') {
          requests++;
          res.setHeader('Content-Type', 'video/mp4');
          res.end(await fs.readFile(path.join(directory, 'preview.mp4')));
        } else if (req.url === '/poster.png') {
          res.setHeader('Content-Type', 'image/png');
          res.end(await fs.readFile(path.join(directory, 'poster.png')));
        } else res.writeHead(404).end();
      } catch (error) {
        res.writeHead(500).end(error.message);
      }
    });
    try {
      execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'testsrc=size=64x48:rate=6',
          '-t',
          '1',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
          path.join(directory, 'preview.mp4'),
        ],
        { timeout: 10000 },
      );
      execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-i',
          path.join(directory, 'preview.mp4'),
          '-frames:v',
          '1',
          path.join(directory, 'poster.png'),
        ],
        { timeout: 10000 },
      );
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      browser = await puppeteer.launch({ headless: true, args: browserArguments() });
      const page = await browser.newPage();
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle0' });
      assert.equal(requests, 0);
      assert.equal(await page.$eval('video', v => v.paused && !v.hasAttribute('autoplay')), true);
      assert.equal(await page.$('button'), null, 'native controls replace the redundant preview button');
      assert.equal(await page.$eval('video', v => v.controls && v.muted), true);
      // The source must exist even in reduced-motion mode so the native play control works.
      assert.ok(await page.$eval('video', v => v.src.endsWith('/preview.mp4')));
      await page.$eval('video', v => v.play());
      await page.waitForFunction(
        () => !document.querySelector('video').paused && document.querySelector('video').currentTime > 0,
      );
      assert.ok(requests > 0);
      await page.evaluate(() => {
        document.body.style.paddingTop = '2000px';
        window.scrollTo(0, 0);
      });
      await page.waitForFunction(() => document.querySelector('video').paused);
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
      await page.$eval('video', v => v.scrollIntoView());
      await page.waitForFunction(() => !document.querySelector('video').paused);
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.waitForFunction(() => document.querySelector('video').paused);
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
      const previousRequests = requests;
      await page.goto(`http://127.0.0.1:${server.address().port}/?offscreen`, { waitUntil: 'networkidle0' });
      assert.equal(requests, previousRequests, 'an initially offscreen video must not fetch media');
      assert.equal(await page.$eval('video', v => v.paused && !v.hasAttribute('autoplay')), true);
      await page.$eval('video', v => v.scrollIntoView());
      await page.waitForFunction(() => !document.querySelector('video').paused);
      assert.ok(requests > previousRequests);
    } finally {
      await browser?.close();
      await new Promise(resolve => server.close(resolve));
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
