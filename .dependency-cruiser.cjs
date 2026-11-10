/** Architectural diagnostics are warnings; parser/configuration failures still fail the command. */
module.exports = {
  forbidden: [
    { name: 'no-circular-imports', severity: 'warn', comment: 'Review cycles, including their type-only edges, and prefer explicit feature interfaces.', from: {}, to: { circular: true, dependencyTypesNot: ['type-only'] } },
    { name: 'shared-infrastructure-stays-independent', severity: 'warn', from: { path: '^packages/rzmps/src/utils/' }, to: { path: '^packages/rzmps/src/(core|emission|simulation|events|spatial|rendering|modules)/' } },
    { name: 'values-do-not-depend-on-system', severity: 'warn', from: { path: '^packages/rzmps/src/values/' }, to: { path: '^packages/rzmps/src/(core/ParticleSystem|modules|rendering)/' } },
    { name: 'events-do-not-own-emission', severity: 'warn', from: { path: '^packages/rzmps/src/events/' }, to: { path: '^packages/rzmps/src/emission/(Emitter|gpu/)', dependencyTypesNot: ['type-only'] } },
    { name: 'spatial-indexing-independent-of-behaviors', severity: 'warn', from: { path: '^packages/rzmps/src/spatial/' }, to: { path: '^packages/rzmps/src/modules/', dependencyTypesNot: ['type-only'] } },
    { name: 'feature-runtime-internals', severity: 'warn', comment: 'Core coordinates runtimes; other features should use explicit interfaces. Review intentional integration dependencies locally.', from: { path: '^packages/rzmps/src/', pathNot: '^packages/rzmps/src/(core|simulation|emission|events|spatial)/' }, to: { path: '^packages/rzmps/src/(simulation/(GPUSimulation|SimulationFrames)|emission/EmissionRuntime|events/EventRuntime|spatial/structures/SpatialRuntime)\\.ts$' } },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(build|tests|assets)/' },
    tsConfig: { fileName: 'packages/rzmps/tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { extensions: ['.ts', '.js', '.json'] },
  },
};
