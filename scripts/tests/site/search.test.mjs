import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'vite';
import { createServer } from 'node:http';
import { discoverExamples } from '../../docs/examples.mjs';
import puppeteer from 'puppeteer';
import { browserArguments } from '../../preview/browser.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
test(
  'example search opens only for typing, supports keyboard selection and dismisses on escape',
  { timeout: 30000 },
  async () => {
    // Bundle only this component and its real metadata, avoiding an optimizer or
    // renderer startup in a test concerned solely with accessible discovery.
    const bundle = await build({
      root: path.join(root, 'apps/demo'),
      configFile: path.join(root, 'apps/demo/vite.config.mjs'),
      logLevel: 'error',
      plugins: [
        {
          name: 'search-test',
          enforce: 'pre',
          resolveId(id) {
            if (id === 'search-test-entry' || id === 'examples/index.js') return '\0' + id;
          },
          load(id) {
            if (id === '\0examples/index.js') return `export const examples = ${JSON.stringify(discoverExamples())};`;
            if (id === '\0search-test-entry')
              return `import React from 'react';
            import { createRoot } from 'react-dom/client';
            import Search from ${JSON.stringify(path.join(root, 'apps/demo/src/components/ExampleSearch.jsx'))};
            createRoot(document.getElementById('root')).render(React.createElement(Search,
              {onSelect: name => window.selected = name}));`;
          },
        },
      ],
      build: { write: false, sourcemap: false, rollupOptions: { input: 'search-test-entry' } },
    });
    const entry = bundle.output.find(file => file.isEntry);
    const server = createServer((req, res) => {
      const file = bundle.output.find(file => '/' + file.fileName === req.url);
      res.setHeader('Content-Type', file ? 'text/javascript' : 'text/html');
      res.end(
        file
          ? file.code
          : `<button id="outside">Outside</button><div id="root"></div>
        <script type="module" src="/${entry.fileName}"></script>`,
      );
    });
    let browser;
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      browser = await puppeteer.launch({ headless: true, args: browserArguments() });
      const page = await browser.newPage();
      page.setDefaultTimeout(5000);
      page.on('pageerror', error => console.error(error.stack));
      page.on('console', message => {
        if (message.type() === 'error') console.error(message.text());
      });
      await page.goto(`http://127.0.0.1:${server.address().port}/__search-test`);
      await page.waitForSelector('[role="combobox"]');
      await page.focus('[role="combobox"]');
      assert.equal(await page.$('[role="listbox"]'), null);
      await page.type('[role="combobox"]', 'audio');
      await page.waitForSelector('[role="listbox"]');
      assert.ok((await page.$eval('[role="listbox"]', e => e.textContent)).includes('Metal Balls'));
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('[role="listbox"]'));
      await page.type('[role="combobox"]', 'metal balls');
      await page.waitForSelector('[role="option"]');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.selected === 'Metal Balls');
      await page.waitForFunction(() => !document.querySelector('[role="listbox"]'));
      await page.type('[role="combobox"]', 'fire');
      await page.waitForSelector('[role="listbox"]');
      await page.click('#outside');
      await page.waitForFunction(() => !document.querySelector('[role="listbox"]'));
    } finally {
      await browser?.close();
      await new Promise(resolve => server.close(resolve));
    }
  },
);
