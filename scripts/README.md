# Repository scripts

- `benchmark/`: PR benchmark selection, execution, comparison and reporting.
- `dependencies/`: dependency analysis and PR warning comments.
- `docs/`: documentation and published skill generation and validation.
- `preview/`: canvas capture and its runtime validation helpers.
- `site/`: development server, static assembly and serving.
- `tests/`: script tests, mirroring those directories. Browser checks live here too.

A **fixture** is fixed test input or a prepared test scenario. It is not disposable
output. `tests/benchmark/fixtures/benchmark-result.json` supplies known measurements
for comparison, aggregation, validation and CLI lifecycle tests. The loader/runtime
fixtures replace Chrome and the server during those tests, so they run quickly
without a real benchmark. Keep these files tracked. They are not current performance
reports and should not be refreshed by benchmark CI.

`tests/preview/fixtures/` contains small particle scenes used to check event scopes,
GPU events and simulation frames through the preview capture tool.

Actual benchmark output belongs in ignored `benchmark-results/` or `benchmark/` at
the repository root. Generated previews also stay ignored. The one-off TextureAtlas
benchmark has been removed; regular benchmark CI uses the tools in `scripts/benchmark/`.

Run fast benchmark and dependency reporting tests with `npm run test:benchmarks`
and `npm run test:dependencies`. Documentation tests live in `tests/docs/` and run
through `npm run docs:check`. `npm run preview:smoke` runs the optional browser suite;
`npm run site:browser-check` checks the assembled site.

Preview media is generated only by explicit `preview`, `docs:previews`, or deployment
commands. `site:deploy` needs FFmpeg/FFprobe and the Chrome version shipped with the
pinned Puppeteer dependency. Source checks and `site:build` do not need these tools.
`npm run test:preview-media` runs focused metadata/encoding tests (tiny synthetic frames,
with encoding tests skipped if FFmpeg is absent). The separate
`node --test scripts/tests/preview/backend.test.mjs` checks real headless WebGPU
texture readback and runs as a required deployment gate.
Run `npm run lint` from the repository root to check library sources, the demo,
examples, and scripts. The shared `.eslintrc.cjs` warns about lines over 120 characters;
`scripts/.eslintrc.cjs` adds Node and browser-harness environments. Use
`npm run lint:scripts` for scripts alone. CI rejects lint errors; warnings remain advisory. JavaScript and TypeScript use
single quotes (double quotes are allowed to avoid escaping apostrophes), and JSX
attributes use double quotes.
Prettier uses the same 120-character target through `.prettierrc.json`.

Fluid WebGPU regressions and diagnostic harnesses live in `tests/preview/fluids/`,
with browser fixtures in its `fixtures/` directory.
