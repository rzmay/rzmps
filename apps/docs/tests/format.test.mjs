import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeGeneratedText } from '../scripts/skill-format.mjs';

test('generated Markdown ends with exactly one newline, including guides ending in components', () => {
  const guide = '# Example\n\n```js\nconst layers = [];\n```\n\n<ExampleCode region="system:connections" />';
  for (const trailing of ['', '\n', '\n\n\n', '\n  \n']) {
    const normalized = normalizeGeneratedText(guide + trailing);
    assert.equal(normalized, guide + '\n');
    assert.equal(normalizeGeneratedText(normalized), normalized);
  }
});
