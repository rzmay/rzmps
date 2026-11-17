import fs from 'node:fs';
import path from 'node:path';

/** Discover only declared workspace test/benchmark roots; never walk dependencies or generated output. */
export function discoverFiles(root, directory, pattern) {
  const result = [];
  const owners = [
    '',
    'examples',
    ...['apps', 'packages'].flatMap(parent =>
      fs
        .readdirSync(path.join(root, parent))
        .filter(name => fs.existsSync(path.join(root, parent, name, 'package.json')))
        .map(name => `${parent}/${name}`),
    ),
  ];
  function walk(folder, owner) {
    if (!fs.existsSync(folder)) return;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['node_modules', 'output', 'config', 'fixtures'].includes(entry.name)) continue;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file, owner);
      else if (pattern.test(entry.name)) {
        const relative = path.relative(root, file).replaceAll(path.sep, '/');
        result.push({ path: relative, name: entry.name, workspace: owner || '.', absolute: file });
      }
    }
  }
  for (const owner of owners) walk(path.join(root, owner, directory), owner);
  return result;
}
