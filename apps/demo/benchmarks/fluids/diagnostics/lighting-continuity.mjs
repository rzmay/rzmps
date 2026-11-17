// Opt-in benchmark. Results stay in /tmp and never update public/PR benchmark reports.
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['--test', 'apps/demo/tests/fluids/lighting-continuity.browser.test.mjs'], {
  stdio: 'inherit', env: { ...process.env, LIGHTING_FEATURES: '1',
    LIGHTING_EXTENT: process.env.LIGHTING_EXTENT ?? '3',
    LIGHTING_FRAMES: process.env.LIGHTING_FRAMES ?? '64',
    LIGHTING_WIDTH: process.env.LIGHTING_WIDTH ?? '800',
    LIGHTING_DPR: process.env.LIGHTING_DPR ?? '2' },
});
child.on('exit', code => { process.exitCode = code ?? 1; });
