import { EventEmitter } from 'node:events';
import fs from 'node:fs';

const scenario = process.env.RZMPS_BENCHMARK_TEST_SCENARIO;
const snapshot = JSON.parse(fs.readFileSync(new URL('../../benchmark/result.json', import.meta.url), 'utf8'));
const log = message => console.error(`[fixture] ${message}`);

export function createSiteServer() {
  return Object.assign(new EventEmitter(), {
    listen(_port, _host, ready) { queueMicrotask(ready); },
    address() { return { port: 1234 }; },
    closeAllConnections() {},
    close(done) { log('server closed'); done(); },
  });
}

export default {
  async launch() {
    const page = Object.assign(new EventEmitter(), {
      async goto() {
        if (scenario === 'early-crash') this.emit('error', new Error('fixture early crash'));
      },
      async waitForFunction() {},
      async evaluate(operation) {
        const code = operation.toString();
        if (code.includes('document.createElement')) return { webglVendor: 'fixture', webglRenderer: 'fixture' };
        if (code.includes('document.querySelector')) return { activeCase: 'fixture', phase: 'failed' };
        if (code.includes('__RZMPS_BENCHMARK_ERROR__')) return {
          expected: snapshot.results.map(row => row.name), results: snapshot.results,
          error: scenario.startsWith('page-error') ? { message: 'fixture application failure' } : undefined,
        };
        if (code.includes('__RZMPS_BENCHMARK_SHUTDOWN__')) { log('renderer drained'); return; }
        throw new Error(`Unexpected fixture browser operation: ${code}`);
      },
      async screenshot() { throw new Error('fixture screenshot unavailable'); },
    });
    return {
      async newPage() { return page; },
      async version() { return 'fixture browser'; },
      async close() {
        log('browser closed');
        if (scenario === 'late-validation') page.emit('console', {
          type: () => 'error', text: () => 'GPUValidationError: fixture late shader failure',
        });
        if (scenario === 'page-error-close-error') throw new Error('fixture close failure');
        if (scenario === 'teardown-error') throw new Error('OperationError: Instance dropped in popErrorScope');
      },
      process() { return { kill() { log('browser killed'); } }; },
    };
  },
};
