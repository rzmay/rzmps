# Contributing to 🧅 RZMPS

The canonical contributor guide is [apps/docs/contributing.md](apps/docs/contributing.md).
It covers shared examples, source regions, authored explanations, TSDoc, generated agent
references, checks, and WebGL/WebGPU preview commands.

Start with `npm install`, `npm run build`, and `npm test`.
Run `npm run generate --workspace @rzmps/docs` after documentation or example changes and `npm run scripts check:docs`
before submitting a pull request. Generated files carry a notice; authored guides are preserved.

Prepare your current working tree for a PR targeting `develop` with:

```bash
npm run scripts pr:prepare
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

Tests and benchmarks live in the owning workspace's `tests/` and `benchmarks/` directories.
Root [tests](tests/README.md) and [benchmarks](benchmarks/README.md) are private workspaces that
collect and run them automatically by filename. Shared automation checks live under root `tests/`;
documentation-specific automation lives in `apps/docs/scripts/` and its checks in `apps/docs/tests/`.
Do not add tests or benchmark workloads under `scripts/`. Use the documented suffixes and JSON
selection sets; moving or adding tests does not require editing a hardcoded runner list.

Run `npm run scripts check:dependencies` from the repository root to inspect architectural
warnings, including import paths and rule names. The Test and build CI job compares
PR and base revisions using the same current rules. It uploads complete JSON results
and a trusted reporting workflow updates one PR comment with new, resolved and
existing warnings after CI completes. Full details remain in the Actions logs and
`dependency-report-<attempt>` artifact. The commenting workflow must first be merged
into the default branch to run. All architecture rules have warning severity;
configuration, parsing and execution failures still fail the analysis step.
Run `npm test -- --skip-build --set dependencies` to test comparison and comment reporting. Inspect whether a warning exposes misplaced
ownership before adding an exception. For an intentional dependency, document the
reason beside the import or narrow the relevant rule in `.dependency-cruiser.cjs`;
avoid blanket exclusions or suppressing the command's exit status.

## Filenames and API conventions

- A file with one primary class or interface uses PascalCase matching that export: `ParticleSystem.ts`,
  `GasModule.ts`, `InitialParticleValues.ts`.
- A file with one primary function uses camelCase matching that function: `evaluateDynamic.ts`.
- Related helper collections use `categoryOfHelpers.utils.ts`, such as `geometry.utils.ts`.
- Collections of type contracts may use `category.types.ts`. Supporting exports can accompany a primary export;
  the filename follows the primary export. Prefer one identifiable primary export, preserving named exports.
  Do not add a default export just to satisfy a filename rule.

Derive optional input configurations with `Partial<T>`, `Partial<Pick<T, Keys>>`, `Omit` and intersections when a
canonical contract already exists. Preserve property documentation and input constraints. A genuinely optional
property remains optional; do not invent a required base interface merely to spell `Partial`.

Colors use Three.js `ColorRepresentation` (`Color | string | number`), also re-exported from RZMPS. Dynamic colors
wrap it in `DynamicValue<ColorRepresentation>` or `ValueByParameter<ColorRepresentation>`; scalar color input and
dynamic containers are distinct contracts. RGB arrays are not scalar color inputs: a two-element dynamic array is a
range, and a `Set` is a random choice. Scalar/vector shortcuts remain described separately by `Vector3Input`.

Closed API choices use string-valued enum members, rather than raw strings or independently maintained string unions:

```ts
export enum SolverType {
  Auto = 'auto',
  Multigrid = 'multigrid',
}
const solver = SolverType.Auto;
```

Reuse an existing enum when its contract matches. `GeometryUpdatePolicy` covers geometry mutation for both collision
and spatial effects. Serialized values remain the enum's string values; configuration APIs use the enum type.
Numeric priorities, GPU/storage ABI offsets and `MaterialCopySampleMode` retain their numeric contracts. Shader type
tokens, property-key unions, user event names, identifiers and tags are not configuration enums.

These are contributor design guidelines, not additional CI style gates. Existing linting, type checking, functional
tests and import-casing validation remain in place. Architectural dependency checks remain warning-only.

Process-wide tuning controls live in `core/GlobalSettings.ts`. Internal code imports
`GlobalSettings` directly; consumers use `ParticleSystem.Settings.SETTING`. Add new
settings there instead of adding individual aliases to `ParticleSystem`. Instance
configuration still belongs on the system or its owning component.

Generated benchmark artifacts belong in ignored `benchmarks/output/<set>/`, with one JSON
format per runtime and an index listing outputs. Reports consume these artifacts instead of
rerunning benchmarks. Test diagnostics belong in ignored `tests/output/`. Tracked fixtures are
fixed test inputs, not generated reports. Shared browser profiles are in `scripts/config/browser.json`;
benchmark measurement/deadline/selection configuration is in `benchmarks/config/` and test sets
in `tests/config/`. Keep defaults at their owner rather than copying them between commands.

Use `npm run scripts <task>` for named automation processes; see [scripts/README.md](scripts/README.md).
`pr:prepare` builds packages once, runs discovered tests, measures and consumes one reported
benchmark artifact, then generates/checks docs and builds the demo. Root `dev`, `build`, `test`
and `lint` remain convenient common entry points. Generated docs, builds and preview media are
ignored. The published `.agents/skills/rzmps` and library `AGENTS.md` remain tracked for discovery.
Keep guidance in each workspace README; a nested README needs a distinct audience or independently
vendored/license information, rather than duplicating workspace setup or commands.

Particle presets live in `examples/presets/`; scene presets live in
`examples/scenes/`. The private `examples` workspace exports `examples/*`, so browser
code can import `examples/index.js`, `examples/scenes/index.js`, or an individual
scene directly. Run `npm install` after workspace changes to refresh local links.
Both catalog indexes discover factories automatically with `import.meta.glob`.
Attach metadata as `factory.metadata` (including `id`, `title` and `author`); preset
metadata also includes `description` and `tags`. Source URLs come from
the factory's filename. Shared media lives in `examples/assets/` and helpers in
`examples/utils/`. The demo consumes the catalogs directly.

Particle presets must be self-contained: keep construction and example-specific setup in their own factory, with
balanced documentation regions covering the relevant setup. Shared scene infrastructure may import helpers. Presets
may import RZMPS, Three.js, normal external dependencies, media, and scene factories used only by metadata.
See [examples/README.md](examples/README.md) for the contribution contract. Existing source-region tests check that documentation references valid source blocks.
