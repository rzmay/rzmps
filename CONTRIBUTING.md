# Contributing to 🧅 RZMPS

The canonical contributor guide is [apps/docs/contributing.md](apps/docs/contributing.md).
It covers shared examples, source regions, authored explanations, TSDoc, generated agent
references, checks, and WebGL/WebGPU preview commands.

Start with `npm install`, `npm run build:modules`, and `npm test`.
Run `npm run docs:generate` after documentation or example changes and `npm run docs:check`
before submitting a pull request. Generated files carry a notice; authored guides are preserved.

Prepare your current working tree for a PR targeting `develop` with:

```bash
npm run pr:prepare
```

This runs the core tests, builds all packages, regenerates the published benchmark
reports in the READMEs, generates and validates documentation, and builds the demo.
It stops at the first failure and checks staged and unstaged whitespace at the end.
Install the browser once with `npx puppeteer browsers install chrome`.

Review and commit updated README benchmark tables and the published skill with your
source changes. Documentation pages and `apps/docs/public/previews/` captures are
ignored build artifacts. CI and deployment generate them before validation. The
GitHub runner's cross-branch PR benchmarks remain a separate process.

See the [code of conduct](.github/CODE_OF_CONDUCT.md).

## Architecture and ownership

Library sources in `packages/rzmps/src/` are grouped by feature. Place emission code
in `emission/`, frame conversion and GPU simulation in `simulation/`, event transport
in `events/`, spatial indexes in `spatial/structures/` and effects in `spatial/effects/`, and renderers, materials and grouping in
`rendering/`. Built-in behavior modules stay in `modules/`; DynamicValue evaluation
and sampling belong in `values/`. Put backend-specific implementations under the
owning feature's `gpu/` directory. Place shared storage and compute infrastructure in `utils/gpu/` and other small,
domain-independent helpers in `utils/`. Material sampling and compositing belong
in `rendering/compositing/`.

`core/ParticleSystem` owns public configuration, scene integration, component
registration, lifecycle entry points and update sequencing. It delegates GPU storage
and compute execution to `GPUSimulation`, emitter-instance scheduling and source
bindings to `EmissionRuntime`, event subscriptions and transport to `EventRuntime`,
spatial caches to `SpatialRuntime`, and source frames/rebasing to `SimulationFrames`.
Emitters retain emission configuration and emitter instances retain execution clocks.
Renderers own their output resources, grouping and child rendering state. Components
use `this.evaluateDynamicGPU.number/vector/color` (and parameter variants) for
persistent GPU DynamicValue bindings; evaluation does not depend on `ParticleSystem`.

Prefer dependencies from orchestration to feature implementations to shared
infrastructure and general types/utilities. Collaborate through explicit methods,
public configuration and narrow execution callbacks; avoid accessing another
feature's caches or introducing duplicate configuration. Keep allocation,
invalidation, synchronization and disposal with the resource or cache owner.

Tests live centrally in `packages/rzmps/tests/`, mirroring feature directories.
Put cross-feature lifecycle tests in `tests/integration/`; maintained browser checks and their fixtures live
in `scripts/tests/preview/`. All repository script tests mirror their owning script
directory under `scripts/tests/`. Update test runners when moving tests.

Run `npm run check:dependencies` from the repository root to inspect architectural
warnings, including import paths and rule names. The Test and build CI job compares
PR and base revisions using the same current rules. It uploads complete JSON results
and a trusted reporting workflow updates one PR comment with new, resolved and
existing warnings after CI completes. Full details remain in the Actions logs and
`dependency-report-<attempt>` artifact. The commenting workflow must first be merged
into the default branch to run. All architecture rules have warning severity;
configuration, parsing and execution failures still fail the analysis step.
Run `npm run test:dependencies` to test comparison and comment reporting. Inspect whether a warning exposes misplaced
ownership before adding an exception. For an intentional dependency, document the
reason beside the import or narrow the relevant rule in `.dependency-cruiser.cjs`;
avoid blanket exclusions or suppressing the command's exit status.

Use PascalCase filenames for exported classes. Name a single-function helper after
its function in camelCase; use `{category}.utils.ts` for helper collections and
`{category}.types.ts` for type-only contracts.

Process-wide tuning controls live in `core/GlobalSettings.ts`. Internal code imports
`GlobalSettings` directly; consumers use `ParticleSystem.Settings.SETTING`. Add new
settings there instead of adding individual aliases to `ParticleSystem`. Instance
configuration still belongs on the system or its owning component.

The root `benchmark/` directory is ignored scratch output, created only when needed.
Benchmark implementation lives in `scripts/` and `apps/demo/`; deterministic test data
lives in `scripts/tests/benchmark/fixtures/`. Fixtures are tracked test inputs, not
generated benchmark reports. See `scripts/README.md` for script ownership. Generated docs, builds and preview images are ignored.
The published `.agents/skills/rzmps` distribution remains tracked for GitHub installs.

Particle presets live in `examples/presets/`; scene presets and their shared helpers live in
`examples/scenes/`. The private `examples` workspace exports `examples/*`, so browser
code can import `examples/index.js`, `examples/scenes/index.js`, or an individual
scene directly. Run `npm install` after workspace changes to refresh local links.
Both catalog indexes discover factories automatically with `import.meta.glob`.
Attach metadata as `factory.metadata` (including `id`, `title` and `author`); preset
metadata also includes `description`, `tags` and `category`. Source URLs come from
the factory's filename. Shared media lives in `examples/assets/` and helpers in
`examples/utils/`. The demo consumes the catalogs directly.
