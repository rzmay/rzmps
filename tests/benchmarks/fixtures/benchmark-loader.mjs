import { registerHooks } from 'node:module';

const fixture = new URL('./benchmark-runtime.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'puppeteer' || specifier.endsWith('/scripts/site/serve.mjs')) {
      return { url: fixture, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
