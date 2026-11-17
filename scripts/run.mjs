import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const [task, ...args] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
if (!task || !Object.hasOwn(manifest.scripts, task)) {
  console.error(`Choose a scripts task: ${Object.keys(manifest.scripts).join(', ')}`);
  process.exitCode = 1;
} else {
  const child = spawn('npm', ['run', task, '--workspace', '@rzmps/scripts', '--', ...args], {
    cwd: path.resolve(import.meta.dirname, '..'),
    stdio: 'inherit',
  });
  child.once('error', error => {
    console.error(error);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
}
