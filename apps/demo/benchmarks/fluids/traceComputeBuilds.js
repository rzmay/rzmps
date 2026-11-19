/** Measure synchronous graph stages separately from asynchronous compilation/driver wall time. */
export default function traceComputeBuilds(renderer, report, label = node => node.name || 'compute') {
  const previous = renderer.debug.onNodeBuilderCreated;
  const pending = new Set();

  const hook = (builder, node) => {
    previous?.(builder, node);
    if (!node.isComputeNode) return;

    const originals = [], family = label(node) || 'compute';
    const origin = family === 'compute' ? new Error('Compute preparation origin').stack : undefined;
    let depth = 0;
    const wrap = (owner, name, phase) => {
      const original = owner[name];
      const measured = function (...args) {
        // A compute node can also be visited by another concurrently prepared builder.
        if (owner === node && args[0] !== builder) return original.apply(this, args);
        const outer = depth++ === 0, start = performance.now();
        const stage = phase ?? builder.getBuildStage();
        try { return original.apply(this, args); } finally {
          depth--;
          if (outer) {
            const cpuMs = performance.now() - start;
            report({ family, stage, start, cpuMs, origin: cpuMs > 8 ? origin : undefined });
          }
        }
      };
      owner[name] = measured;
      originals.push(() => { if (owner[name] === measured) owner[name] = original; });
    };
    wrap(node, 'build');
    wrap(builder, 'flowNode', 'generate');
    wrap(builder, 'prebuild', 'prebuild');
    wrap(builder, 'buildCode', 'code');
    wrap(builder, 'buildUpdateNodes', 'updates');

    const cleanup = () => { originals.forEach(restore => restore()); pending.delete(cleanup); };
    pending.add(cleanup);
    const asyncBuild = builder.buildAsync;
    const measuredAsync = async function (...args) {
      try { return await asyncBuild.apply(this, args); } finally { cleanup(); }
    };
    builder.buildAsync = measuredAsync;
    originals.push(() => { if (builder.buildAsync === measuredAsync) builder.buildAsync = asyncBuild; });
    const build = builder.build;
    const measuredBuild = function (...args) {
      try { return build.apply(this, args); } finally { cleanup(); }
    };
    builder.build = measuredBuild;
    originals.push(() => { if (builder.build === measuredBuild) builder.build = build; });
  };
  renderer.debug.onNodeBuilderCreated = hook;
  return () => {
    if (renderer.debug.onNodeBuilderCreated === hook) renderer.debug.onNodeBuilderCreated = previous;
    pending.forEach(cleanup => cleanup());
  };
}
