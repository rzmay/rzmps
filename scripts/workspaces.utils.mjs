import fs from 'node:fs';
import path from 'node:path';
import mapWorkspaces from '@npmcli/map-workspaces';

/** Resolve declared, manifest-bearing workspaces using the same resolver as npm. */
export async function discoverWorkspaces(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const workspaces = await mapWorkspaces({ cwd: root, pkg });
  return [...workspaces].map(([name, directory]) => ({
    ...JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')),
    name,
    directory,
    location: path.relative(root, directory).replaceAll(path.sep, '/'),
  }));
}
