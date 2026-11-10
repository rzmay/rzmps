import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assembleSite } from '../../site/assemble.mjs';
import { createSiteServer } from '../../site/serve.mjs';
test('one static output serves demo and both docs entry paths, assets and deep links', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rzmps-site-test-'));
  let server;
  try {
    const demoDirectory = path.join(temp, 'demo'),
      docsDirectory = path.join(temp, 'documentation'),
      output = path.join(temp, 'site');
    await fs.mkdir(demoDirectory);
    await fs.mkdir(path.join(docsDirectory, 'guides'), { recursive: true });
    await fs.mkdir(path.join(docsDirectory, 'previews'));
    for (const [file, body] of [
      ['index.html', '<html><head><title>Demo</title></head><body>demo</body></html>'],
      ['asset.js', 'demo asset'],
    ])
      await fs.writeFile(path.join(demoDirectory, file), body);
    for (const [file, body] of [
      ['index.html', '🧅 docs'],
      ['guides/start.html', 'guide'],
      ['previews/fire.png', 'PNG'],
      ['llms.txt', 'discovery'],
      ['llms-full.txt', 'full docs'],
    ])
      await fs.writeFile(path.join(docsDirectory, file), body);
    await assembleSite({ demoDirectory, docsDirectory, output });
    server = createSiteServer(output);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const [url, body] of [
      ['/', 'demo'],
      ['/example/fire', 'demo'],
      ['/example/fire/', 'demo'],
      ['/example/fire.html', 'demo'],
      ['/docs', '🧅 docs'],
      ['/docs/', '🧅 docs'],
      ['/docs?x=1', '🧅 docs'],
      ['/docs/guides/start', 'guide'],
      ['/docs/guides/start.html', 'guide'],
      ['/docs/previews/fire.png', 'PNG'],
      ['/llms.txt', 'discovery'],
      ['/docs/llms-full.txt', 'full docs'],
    ]) {
      const response = await fetch(origin + url, { redirect: 'manual' });
      assert.equal(response.status, 200, url);
      assert.equal(response.headers.get('location'), null, url);
      const html = await response.text();
      if (body === 'demo') {
        assert.match(html, /<body>demo<\/body>/, url);
        assert.match(html, /property="og:title"/, url);
        if (url.startsWith('/example/'))
          assert.ok(html.includes('href="https://rzmps.rzmay.com/docs/examples/fire.html"'));
      } else assert.equal(html, body, url);
    }
    assert.equal((await fetch(origin + '/docs/absent')).status, 404);
    assert.equal((await fetch(origin + '/docs/previews/missing.png')).status, 404);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('deployment SEO validation rejects missing social media targets and incorrect canonicals', async () => {
  const { checkSiteSEO } = await import('../../site/check-seo.mjs');
  const { demoPageHTML } = await import('../../docs/seo.mjs');
  const { discoverExamples } = await import('../../docs/examples.mjs');
  const example = discoverExamples().find(entry => entry.id === 'fire');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rzmps-seo-site-'));
  try {
    for (const directory of ['docs/examples', 'docs/previews', 'example/fire'])
      await fs.mkdir(path.join(temp, directory), { recursive: true });
    const source = '<html><head><title>Demo</title></head><body>Demo</body></html>';
    const html = demoPageHTML(source, example);
    await fs.writeFile(path.join(temp, 'index.html'), demoPageHTML(source));
    for (const file of ['docs/examples/fire.html', 'example/fire/index.html', 'example/fire.html'])
      await fs.writeFile(path.join(temp, file), html);
    await fs.writeFile(
      path.join(temp, 'robots.txt'),
      'User-agent: *\nAllow: /\nSitemap: https://rzmps.rzmay.com/docs/sitemap.xml\n',
    );
    await fs.writeFile(
      path.join(temp, 'docs/sitemap.xml'),
      '<urlset>' +
        ['https://rzmps.rzmay.com/', 'https://rzmps.rzmay.com/docs/', 'https://rzmps.rzmay.com/docs/examples/fire.html']
          .map(url => `<url><loc>${url}</loc></url>`)
          .join('') +
        '</urlset>',
    );
    await fs.writeFile(path.join(temp, 'docs/previews/fire.png'), 'poster');
    await assert.rejects(checkSiteSEO(temp, [example]), /missing or empty og:video/);
    await fs.writeFile(path.join(temp, 'docs/previews/fire.mp4'), 'video');
    assert.equal(await checkSiteSEO(temp, [example]), 1);
    await fs.writeFile(path.join(temp, 'docs/examples/fire.html'), html.replace('rel="canonical"', 'rel="alternate"'));
    await assert.rejects(checkSiteSEO(temp, [example]), /canonical/);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
