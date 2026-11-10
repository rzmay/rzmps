import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkLinks } from '../../docs/check-links.mjs';

test('docs validation recognizes real demo routes without a demo build and still rejects broken links', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rzmps-docs-links-'));
  const page = path.join(directory, 'index.html');
  try {
    fs.writeFileSync(
      path.join(directory, 'sitemap.xml'),
      '<urlset><url><loc>https://rzmps.rzmay.com/</loc></url>' +
        '<url><loc>https://rzmps.rzmay.com/docs/</loc></url></urlset>',
    );
    fs.writeFileSync(
      page,
      '<a href="/example/acid">Live demo</a><a href="/example/tags?renderer=webgl">Tags</a>' +
        '<a href="/">Homepage</a><a href="/docs/#heading">Docs</a><h1 id="heading">Title</h1>',
    );
    assert.deepEqual(checkLinks(directory), { count: 4, pages: 1 });
    for (const target of ['/example/not-a-preset', '/docs/missing', '/docs/#missing']) {
      fs.writeFileSync(page, `<a href="${target}">Broken link</a>`);
      assert.throws(() => checkLinks(directory), /missing target|missing anchor/);
    }
    fs.writeFileSync(page, '<h1>Docs</h1>');
    fs.writeFileSync(
      path.join(directory, 'sitemap.xml'),
      '<urlset><url><loc>https://unrelated.test/</loc></url></urlset>',
    );
    assert.throws(() => checkLinks(directory), /outside the configured documentation base/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
