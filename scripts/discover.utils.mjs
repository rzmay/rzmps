import fs from 'node:fs';
import path from 'node:path';
import { discoverWorkspaces } from './workspaces.utils.mjs';

/** Discover only declared workspace test/benchmark roots; never walk dependencies or generated output. */
export async function discoverFiles(root, directory, pattern) {
  const result = [];
  const owners = ['', ...(await discoverWorkspaces(root)).map(workspace => workspace.location)];
  function walk(folder, owner) {
    if (!fs.lstatSync(folder, { throwIfNoEntry: false })?.isDirectory()) return;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (
        entry.name.startsWith('.') ||
        ['node_modules', 'output', 'config', 'fixtures', 'build', 'dist', 'coverage'].includes(entry.name)
      )
        continue;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file, owner);
      else if (entry.isFile() && pattern.test(entry.name)) {
        const relative = path.relative(root, file).replaceAll(path.sep, '/');
        result.push({ path: relative, name: entry.name, workspace: owner || '.', absolute: file });
      }
    }
  }
  for (const owner of owners) walk(path.join(root, owner, directory), owner);
  return result;
}
