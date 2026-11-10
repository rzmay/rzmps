import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { browserArguments } from '../../preview/browser.mjs';

test('offline audio follows simulation time, crops warmup and retains stereo cues', { timeout: 20000 }, async () => {
  const module = await fs.readFile(new URL('../../preview/audioCapture.mjs', import.meta.url));
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/' ? 'text/html' : 'text/javascript');
    res.end(req.url === '/' ? '<title>Offline audio test</title>' : module);
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await puppeteer.launch({ headless: true, args: browserArguments() });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const result = await page.evaluate(async () => {
      const { createAudioCapture } = await import('/audio.mjs');
      const capture = createAudioCapture({ warmup: 6, deltaTime: 1 / 60, duration: 0.3 });
      // Warmup-only tone must disappear from the final clip.
      const warmup = capture.context.createOscillator();
      warmup.connect(capture.context.destination);
      warmup.start();
      warmup.stop(0.09);
      for (let i = 0; i < 12; i++) await capture.advance(1 / 60);
      const cue = capture.context.createOscillator();
      const pan = capture.context.createStereoPanner();
      pan.pan.value = -1;
      cue.connect(pan).connect(capture.context.destination);
      cue.start(capture.context.currentTime);
      cue.stop(0.3);
      for (let i = 0; i < 6; i++) await capture.advance(1 / 60);
      const bytes = Uint8Array.from(atob(await capture.finish()), c => c.charCodeAt(0));
      const view = new DataView(bytes.buffer);
      const peak = (start, end, channel) => {
        let value = 0;
        for (let i = Math.round(start * 48000); i < Math.round(end * 48000); i++)
          value = Math.max(value, Math.abs(view.getInt16(44 + (i * 2 + channel) * 2, true)));
        return value;
      };
      return {
        channels: view.getUint16(22, true),
        length: bytes.length,
        warmup: peak(0, 0.08, 0),
        left: peak(0.12, 0.18, 0),
        right: peak(0.12, 0.18, 1),
      };
    });
    assert.equal(result.channels, 2);
    assert.equal(result.length, 44 + 14400 * 4);
    assert.equal(result.warmup, 0);
    assert.ok(result.left > 1000);
    assert.equal(result.right, 0);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
