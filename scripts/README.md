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
