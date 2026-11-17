import path from 'node:path';
import { discoverBenchmarks } from '../catalog.mjs';

const moduleId = 'virtual:rzmps-benchmark-catalog';
const resolvedId = '\0' + moduleId;

/** Share root discovery with Vite without bundling Node-only workloads into the browser. */
export function browserCatalogPlugin(root) {
  return {
    name: 'rzmps-benchmark-catalog',
    resolveId(id) {
      if (id === moduleId) return resolvedId;
    },
    load(id) {
      if (id !== resolvedId) return;
      const entries = discoverBenchmarks(root).filter(entry => entry.runtime === 'browser');
      for (const entry of entries) this.addWatchFile(entry.absolute);
      return (
        entries
          .map(
            (entry, index) => `import entry${index} from ${JSON.stringify(entry.absolute.replaceAll(path.sep, '/'))};`,
          )
          .join('\n') +
        '\nexport default {' +
        entries.map((entry, index) => `${JSON.stringify(entry.path)}: entry${index}`).join(',') +
        '};'
      );
    },
    configureServer(server) {
      const refresh = file => {
        if (!/\.benchmark\.(js|mjs)$/.test(file)) return;
        const module = server.moduleGraph.getModuleById(resolvedId);
        if (module) server.moduleGraph.invalidateModule(module);
        server.ws.send({ type: 'full-reload' });
      };
      server.watcher.on('add', refresh).on('unlink', refresh);
      server.httpServer?.once('close', () => {
        server.watcher.off('add', refresh).off('unlink', refresh);
      });
    },
  };
}
