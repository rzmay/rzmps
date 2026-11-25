import { discoverWorkspaces } from './workspaces.utils.mjs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { prepareDocumentation, preparationIsCurrent, rememberPreparation } from './prepare.utils.mjs';
import { buildArtifacts } from '../apps/docs/scripts/artifacts.mjs';

const root = path.resolve(import.meta.dirname, '..');
const [task, ...flags] = process.argv.slice(2);
const skipBuild = flags.includes('--skip-build');
const checkGenerated = flags.includes('--check-generated');
async function run(command, args, allowedExitCodes = []) {
  console.log(`[${task}] ${command} ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0 || allowedExitCodes.includes(code)
        ? resolve(code)
        : reject(new Error(`${command} failed (${signal ?? code})`)),
    );
  });
}
const npm = (...args) => run('npm', args);
const node = (...args) => run(process.execPath, args);
async function buildPackages() {
  const packages = (await discoverWorkspaces(root)).filter(p => p.location.startsWith('packages/') && p.scripts?.build);
  const built = new Set();
  while (built.size < packages.length) {
    const next = packages.find(
      p =>
        !built.has(p.name) &&
        Object.keys({ ...p.dependencies, ...p.devDependencies }).every(
          name => !packages.some(candidate => candidate.name === name) || built.has(name),
        ),
    );
    if (!next) throw new Error('Cyclic package build dependencies');
    await npm('run', 'build', '--workspace', next.name);
    built.add(next.name);
  }
}
const tests = (set = 'default') => node('tests/run.mjs', '--skip-build', '--set', set);
const docs = name => npm('run', name, '--workspace', '@rzmps/docs');
async function checkDocs(prepared = false) {
  await docs('build');
  await tests(prepared ? 'generated' : 'docs');
  await node('apps/docs/scripts/check-links.mjs');
}
if (task === 'build:packages') await buildPackages();
else if (task === 'check:dependencies')
  await npm(
    'exec',
    '--',
    'depcruise',
    '--config',
    '.dependency-cruiser.cjs',
    '--output-type',
    'err-long',
    'packages/rzmps/src',
  );
else if (task === 'check:docs' || task === 'check:docs:prepared') await checkDocs(task.endsWith(':prepared'));
else if (task === 'check:site') await tests('site');
else if (task === 'build:site' || task === 'deploy:site' || task === 'pr:prepare') {
  const artifacts =
    task === 'pr:prepare'
      ? [
          ...buildArtifacts.filter(file => !file.startsWith('apps/docs/public/previews/')),
          ...(await discoverWorkspaces(root))
            .filter(p => p.location.startsWith('packages/'))
            .map(p => `${p.location}/build`),
          'apps/docs/.vitepress/dist',
          'apps/demo/dist',
        ]
      : [];
  if (task === 'pr:prepare' && preparationIsCurrent(root, artifacts)) {
    // Staging may change independently of working-file contents recorded in the receipt.
    await run('git', ['--no-pager', 'diff', '--check']);
    await run('git', ['--no-pager', 'diff', '--cached', '--check']);
    console.log('[pr:prepare] Inputs and outputs match the last successful preparation; nothing to prepare.');
    process.exit(0);
  }
  if (!skipBuild) await buildPackages();
  if (task === 'pr:prepare') {
    await tests();
    await node('benchmarks/run.mjs', '--set', 'reported', '--runtime', 'browser', '--skip-build');
    await npm('run', 'update-report', '--workspace', '@rzmps/benchmarks');
  }
  if (!checkGenerated) {
    if (task === 'pr:prepare') await prepareDocumentation(run);
    else await docs('generate');
  }
  if (task === 'deploy:site') {
    await docs('restore:previews');
    await docs('generate:previews');
    await docs('check:assets');
  }
  await checkDocs(task === 'pr:prepare');
  await npm('run', 'build', '--workspace', 'demo');
  if (task === 'pr:prepare') {
    await run('git', ['--no-pager', 'diff', '--check']);
    await run('git', ['--no-pager', 'diff', '--cached', '--check']);
    rememberPreparation(root, artifacts);
  } else {
    await node('scripts/site/assemble.mjs');
    if (task === 'deploy:site') {
      await node('apps/docs/scripts/validate-assets.mjs', 'dist/docs/previews');
      await node('scripts/site/check-seo.mjs');
    }
  }
} else if (task === 'dev') {
  await docs('generate');
  await buildPackages();
  const watches = (await discoverWorkspaces(root))
    .filter(p => p.location.startsWith('packages/') && p.scripts?.dev)
    .map(p => `npm run dev --workspace ${JSON.stringify(p.name)}`);
  await npm('exec', '--', 'concurrently', '-k', ...watches, 'node scripts/site/dev.mjs');
} else throw new Error(`Unknown process: ${task}`);
