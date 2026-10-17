import test from 'node:test';
import assert from 'node:assert/strict';
import { startSiteDev } from './dev.mjs';

test('combined development serves the demo at root and proxies only docs paths', { timeout: 60000 }, async () => {
  const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
  const origin = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
  try {
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
