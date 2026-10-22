import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { startSiteDev } from './dev.mjs';

test('combined development serves the demo at root and proxies only docs paths', { timeout: 60000 }, async () => {
  const site = await startSiteDev({ port: 0, host: '127.0.0.1', prebundle: false });
  const origin = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
  try {
    for (const server of [site.demo, site.docs]) {
      assert.equal(server.config.optimizeDeps.noDiscovery, true);
      assert.deepEqual(server.config.optimizeDeps.include, []);
      assert.equal(server.config.server.preTransformRequests, false);
    }
    const demo = await fetch(origin + '/', { redirect: 'manual' });
    assert.equal(demo.status, 200);
    assert.equal(demo.headers.get('location'), null);
    assert.match(await demo.text(), /src\/index\.jsx/);
    for (const entry of ['/docs', '/docs/', '/docs?x=1']) {
      const docs = await fetch(origin + entry, { redirect: 'manual' });
      assert.equal(docs.status, 200, entry);
      assert.equal(docs.headers.get('location'), null, entry);
      assert.match(await docs.text(), /vitepress/);
    }
  } finally { await site.close(); }
});

test('Markdown hot updates and navigation dependency changes reload through the same docs proxy', { timeout: 60000 }, async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rzmps-docs-live-reload-')));
  let site;
  async function waitFor(check) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await check()) return;
      await setTimeout(100);
    }
    assert.fail('Timed out waiting for documentation live reload');
  }
  try {
    await fs.symlink(path.resolve(import.meta.dirname, '../../node_modules'), path.join(directory, 'node_modules'), 'dir');
    await fs.mkdir(path.join(directory, '.vitepress'));
    await fs.writeFile(path.join(directory, '.vitepress/config.mts'), `
import navigation from '../navigation.mjs';
export default {
  title: 'Test Docs', base: '/docs/',
  themeConfig: { sidebar: [{ text: navigation, items: [] }] },
};
`);
    const navigation = path.join(directory, 'navigation.mjs');
    const article = path.join(directory, 'index.md');
    await fs.writeFile(navigation, "export default 'Original Navigation';\n");
    await fs.writeFile(article, '# Original Article\n');
    site = await startSiteDev({ port: 0, host: '127.0.0.1', docsDirectory: directory, prebundle: false });
    const originalServer = site.docs;
    const privatePort = originalServer.httpServer.address().port;
    let reachedRestartGap;
    const restartGap = new Promise(resolve => { reachedRestartGap = resolve; });
    const originalClose = originalServer.close.bind(originalServer);
    originalServer.close = async () => {
      await originalClose();
      reachedRestartGap();
      await setTimeout(150);
    };
    const origin = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
    const moduleUrl = origin + '/docs/index.md?import';
    assert.match(await (await fetch(moduleUrl)).text(), /Original Article/);

    await fs.writeFile(article, '# Updated Article\n');
    await waitFor(async () => /Updated Article/.test(await (await fetch(moduleUrl)).text()));
    assert.equal(site.docs, originalServer, 'ordinary Markdown changes should use HMR');

    await fs.writeFile(navigation, "export default 'Updated Navigation';\n");
    await restartGap;
    const duringRestart = fetch(origin + '/docs/', { headers: { accept: 'text/x-vite-ping' } });
    await waitFor(() => site.docs !== originalServer);
    const ping = await duringRestart;
    assert.equal(ping.status, 204, 'HMR ping must wait for the restarted docs server instead of receiving a proxy error');
    await ping.text();
    assert.equal(site.docs.config.vitepress.site.themeConfig.sidebar[0].text, 'Updated Navigation');
    assert.equal(site.docs.httpServer.address().port, privatePort, 'proxy target port must remain stable');
    const response = await fetch(origin + '/docs/');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /vitepress/);
    assert.match(await (await fetch(moduleUrl)).text(), /Updated Article/);
  } finally {
    await site?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
