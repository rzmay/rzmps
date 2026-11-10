# Contributing

Install workspace dependencies with `npm install`, then build packages with `npm run build:modules`. Run `npm test` for the library regression suite and `npm run build --workspace demo` for the interactive application.

## Preparing a pull request

From the repository root, run:

```bash
npm run pr:prepare
```

Install Puppeteer's browser once with `npx puppeteer browsers install chrome`. The
command follows the PR checklist and stops at the first failure:

1. Run core regression and TypeScript tests.
2. Build all publishable packages.
3. Run `benchmark:update-report` to measure and regenerate the root and package
   README benchmark tables.
4. Generate documentation, API references, the skill from
   the updated source and benchmark reports, then run documentation/link checks.
5. Build the demo and check staged and unstaged whitespace.

Benchmark regeneration precedes documentation generation so the published docs and
agent references include the new README measurements. Review and commit README and
published skill updates alongside source changes. Generated documentation and preview
media are ignored; deployment generates and validates them separately from source checks.

Cross-branch PR benchmarks remain exclusively in the existing GitHub runner
workflow, where both revisions are measured on the same runner. Routine PR comparisons run
16 selected CPU/GPU cases (including TrailRenderer) and update one comment after each
ABBAAB pair. Add the `benchmark:full` label or use manual workflow dispatch for all
33 cases. PR comparisons use a fixed simulation interval; manual wall-clock runs
remain available for catch-up investigations. This local command
does not export PR comparison results, modify that workflow, merge, commit, push,
or open a PR. Full benchmark/report generation can take several minutes. The report
command streams build logs and shows the active browser case, timing settings, and
an elapsed-time update every ten seconds while measurements run. The final
whitespace checks run with Git paging disabled, so they exit directly without
opening an interactive pager.

## Adding or updating an example

Keep the implementation in `examples/presets/<id>.js` (TypeScript is also supported by the generator). Export its existing async default factory and attach a literal `factory.metadata` object containing id, title, author, description, tags, and category. Keep configuration inside the factory; the registry discovers files automatically. Preserve factory author information and return a normal ParticleSystem so the demo GUI and serializer continue to work.

Mark actual source using balanced `// #region docs:system`, `docs:emitters`, `docs:modules`, and `docs:renderers` comments, closing each with the matching `// #endregion docs:...`. Named suffixes select individual systems or setup blocks. Nested regions are supported; interleaved closures are errors. Repeated region names concatenate their source blocks. If an optional module list is absent, mark a relevant system declaration and explain its absence.

Run `npm run docs:generate`. It discovers the example, updates the registry and indexes, and creates a missing Markdown guide in `apps/docs/examples`. It preserves every existing guide. Replace the four TODO explanations with the purpose of each component and the observable consequences of important values: rate, lifetime, speed, capacity, curves, material, blending, and renderer costs. Keep the four required sections in order. Update the explanations whenever the configuration changes.

Use `<ExampleCode region="system" />` and the equivalent emitter/module/renderer references. Code is extracted from the canonical source during the site build. Never paste a second implementation into the guide. A named reference such as `modules:rocket` selects only that region; the base name selects all its named regions.

## Documentation and API comments

Write conceptual guides in `apps/docs/guides`. Write concise TSDoc on public source declarations describing defaults, lifecycle, mutation, side effects, units, constraints, and performance. Use `@remarks`, `@defaultValue`, `@example`, and `@see` where useful. Avoid repeating the TypeScript signature in prose. Keep tutorials in Markdown.

Use a properly capitalized H1 as each article's title. Add new guides to the appropriate reading
order in `scripts/docs/navigation.mjs`: Getting Started, Core Concepts, Feature Guides, or
Project Guides. The sidebar and guide overview read titles directly from the articles;
generation rejects guides missing from this structure. The API overview and sidebar are generated
from actual TypeDoc pages and public export sources by `scripts/docs/api-structure.mjs`. Keep
core classes first and place new API classes in a suitable feature group. Supporting signature
types belong under Types, while Modules contains actual particle modifiers.

`npm run docs:generate` regenerates TypeDoc Markdown, registry/index data, the complete agent skill,
and `llms.txt`/`llms-full.txt`. Edit canonical guides, source comments, and templates; never edit
their generated outputs. The skill's metadata and workflow come from the marked regions in
[AI Coding Assistants](guides/ai-coding-assistants.md#canonical-skill-definition).

| Artifact | Git policy | Source |
| --- | --- | --- |
| `.agents/skills/rzmps/SKILL.md` and `references/` | Generated and committed for GitHub installation | Canonical guides, examples, and API declarations |
| Root and npm README guidance blocks | Generated and committed for direct GitHub/npm readers | AI Coding Assistants guide |
| `apps/docs/public/previews/` and manifest | Generated, ignored, and validated during deployment | Example factories and capture settings |
| `apps/docs/api/`, guide/example index pages, navigation JSON | Generated and ignored | Source declarations, guides, and examples |
| `apps/docs/public/llms.txt` and `llms-full.txt` | Generated and ignored | Canonical docs and skill installation guidance |
| `examples/index.js` and `examples/scenes/index.js` | Authored automatic discovery | `factory.metadata` on each factory |
| `packages/rzmps/AGENTS.md` | Generated, committed for GitHub discovery, and included in npm | `scripts/docs/templates/npm-agents.md` |

Commit updated `.agents` files, README guidance, alongside their
source changes. Other artifacts are rebuilt before documentation/demo builds; package builds
also regenerate npm `AGENTS.md`. No consumer installation hook runs any of this generation.
TypeDoc validates comment syntax and links; generation fails on warnings.

Run `npm run docs:check` to validate source regions, metadata, complete explanations, local links,
generated artifact consistency, and the VitePress build. Check mode rebuilds ignored artifacts
and verifies committed skill/README outputs without rewriting them; stale committed outputs
fail CI and require `npm run docs:generate`. Use `npm run docs:dev` to read the site locally.
Static output is `apps/docs/.vitepress/dist`; `npm run site:build` combines it with the demo in
root `dist`, with documentation under `/docs/`.

## Visual inspection

```bash
npm run preview -- --example fireworks --backend webgl --frames 6 --interval 20 --warmup 60 --delta-time 0.0166667 --width 800 --height 600 --output ./previews/fireworks
npm run preview -- --example fire --backend webgpu --output ./previews/fire-webgpu
npm run preview -- --example collision --scene 'Collision (builtin/Octree)' --backend webgl
```

The preview builds and serves the production demo from an isolated temporary directory with Puppeteer, reusing the benchmark infrastructure and Vite configuration. Concurrent preview processes keep separate build assets. Build packages first. If Puppeteer's browser is missing, install it with `npx puppeteer browsers install chrome`. It captures PNGs directly from the rendering canvas, labels a contact sheet with fixed simulation times, and writes diagnostics to metadata.json even on runtime failure. Backend unavailability is a failure and never triggers a silent fallback.

Inspect the contact sheet after changing effect configuration. Try longer warmup for delayed emission and shorter intervals for flashes. For elevated fireworks, use `--camera-position 8,15,32 --camera-target 0,12,0`; camera settings and `--camera-fov` are recorded in metadata. A neutral scene is the default; select a demo scene to validate geometry-dependent effects. Preview output is ignored by git. `npm run preview:smoke` exercises representative sprite and mesh examples on both backends without pixel-perfect snapshots; it is an optional CI workflow because renderer availability and costs vary.

## Review

Include the example checklist in pull requests adding or substantially changing presets. Describe relevant test and preview results. Report benchmark impact for performance changes.


## Author credits and generated posters

Keep author attribution in the existing factory's literal `.metadata.author` property (a GitHub
username or an object with `name` and optional `url`). `<ExampleAttribution />` resolves that
source at build time; changing the author updates the site and generated agent Markdown.
Use `<ExamplePreview />` for the generated video and poster without copying its URL into authored prose.

After adding or changing an example, run `npm run docs:generate` to update documentation
source and the published skill. This never launches a browser or generates media.
Ordinary `site:build`, `docs:check`, and local development also avoid media generation.

For an explicit local video capture, install FFmpeg/FFprobe and Puppeteer's browser,
then run `npm run preview -- --example fire --format mp4 --duration 4 --fps 30`.
Use `--format webm`, `--crf`, `--width`, and `--height` to configure encoding. PNG
contact sheets remain the default for the preview command. Video frames are written
incrementally to disk and deleted after successful encoding; a PNG poster is retained.

Deployment runs `npm run site:deploy`: validate source, restore the optional cache,
generate stale/missing videos and posters, validate decoded media, build and assemble,
and validate the published copies. GitHub Actions caches the ignored preview directory;
Render can restore hash-checked assets from the previous public deployment. The manifest
includes source hashes, encoder configuration, FFmpeg/FFprobe versions, and pinned Chrome.
Media, manifests, and all intermediate captures remain ignored.

Set per-example overrides on `metadata.previewSettings` in the example itself. Use
camelCase fields such as `warmup`, `cameraPosition: [8, 6, 12]` and `cameraTarget`.
For a preferred scene, import its factory and set `scene: checkerboardScene`; do not
store its display name. Omitted fields use shared defaults from
`scripts/docs/preview-settings.mjs`, including the neutral scene and WebGL backend.
An explicit `preview --scene` selection overrides the example's preferred scene.
`docs:assets:check` rejects missing, modified, stale, blank, or undecodable media.
Source CI uses `docs:generate -- --check` without Chrome, FFmpeg, or preview assets.
Documentation players load near the viewport, pause offscreen, and show a poster until
explicit playback when reduced motion is enabled. Category and tags are visible and
indexed by VitePress local search; the demo sidebar filters the same metadata.

The canonical agent installation guide is [AI Coding Assistants](guides/ai-coding-assistants.md).
It supplies generated README guidance blocks. The full skill stays in `.agents/skills/rzmps`;
only the short template-derived `AGENTS.md` is included in npm. Run `npm run agents:check`
to validate format, reference links, temporary skill installs, and package contents.

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

Interactive example links also support `/example/<id>`, for example `/example/fire`.
These initialize the preset with its imported `previewSettings.scene` and preferred
backend. Explicit `?scene=` and `?renderer=` selections take precedence. The lil-gui
preset and scene controls remain available, and legacy `?preset=` links still work.
Each interactive route points its canonical URL at the corresponding documentation page.
