import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { installWebGPUDiagnostics } from './webgpuDiagnostics.mjs';

export async function attachBrowserDiagnostics(browser, page, options, args) {
  const state = {
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      kernel: os.release(),
      browser: await browser.version(),
      args,
    },
    events: [],
    progress: null,
    chromium: '',
  };
  const report = event => {
    const entry = { elapsedMs: Date.now() - started, ...event };
    state.events.push(entry);
    if (state.events.length > 300) state.events.shift();
    if (entry.step !== undefined || entry.phase === 'capture-start') state.progress = entry;
    console.log(`[preview ${options.example}/${options.backend}] ${JSON.stringify(entry)}`);
  };
  const started = Date.now();
  let progressWrite = Promise.resolve();
  const shaders = new Set();
  await page.exposeFunction('rzmpsPreviewReport', async input => {
    let event = input;
    if (event.phase === 'shader-module' && typeof event.code === 'string') {
      const { code, ...details } = event;
      const hash = createHash('sha256').update(code).digest('hex');
      const file = `shaders/${hash}.wgsl`;
      if (shaders.has(hash) || shaders.size < 128) {
        if (!shaders.has(hash)) {
          shaders.add(hash);
          await fs.mkdir(path.join(options.output, 'shaders'), { recursive: true });
          await fs.writeFile(path.join(options.output, file), code.slice(0, 1024 * 1024));
        }
        event = { ...details, file, characters: code.length };
      } else event = { ...details, characters: code.length, omitted: 'shader limit reached' };
    }
    report(event);
    // Persist progress before acknowledging it, even if Chrome later crashes or hangs.
    const contents = JSON.stringify(state, null, 2) + '\n';
    progressWrite = progressWrite.then(() => fs.writeFile(path.join(options.output, 'diagnostics.json'), contents));
    await progressWrite;
  });
  await page.evaluateOnNewDocument(installWebGPUDiagnostics);
  const stderr = chunk => {
    state.chromium = (state.chromium + chunk.toString()).slice(-256 * 1024);
  };
  browser.process()?.stderr?.on('data', stderr);
  page.on('error', error => report({ phase: 'renderer-crash', message: error.message }));
  browser.on('disconnected', () => report({ phase: 'browser-disconnected' }));
  report({ phase: 'browser-ready', ...state.environment });
  await fs.writeFile(path.join(options.output, 'diagnostics.json'), JSON.stringify(state, null, 2) + '\n');
  async function snapshot() {
    let session, timer;
    const request = async () => {
      session = await browser.target().createCDPSession();
      state.systemInfo = await session.send('SystemInfo.getInfo');
    };
    try {
      await Promise.race([
        request(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('GPU snapshot timed out')), 5000);
        }),
      ]);
    } catch (error) {
      state.systemInfoError = error.message;
    } finally {
      clearTimeout(timer);
      // An unresponsive GPU must not make optional diagnostics hang the capture.
      void session?.detach().catch(() => {});
    }
  }
  return {
    state,
    report,
    snapshot,
    async save() {
      await progressWrite.catch(() => {});
      for (const file of ['memory.events', 'memory.current', 'memory.max']) {
        const contents = await fs.readFile('/sys/fs/cgroup/' + file, 'utf8').catch(() => null);
        if (contents) (state.memory ??= {})[file] = contents.trim();
      }
      await fs.writeFile(path.join(options.output, 'chromium.log'), state.chromium);
      await fs.writeFile(path.join(options.output, 'diagnostics.json'), JSON.stringify(state, null, 2) + '\n');
    },
  };
}
