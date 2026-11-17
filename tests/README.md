# Test workspace

This private workspace gathers and runs tests from root `tests/` and each declared npm
workspace's `tests/` directory (including apps, packages and examples). Place tests with their owning app/package;
root tests cover repository automation and integration. Mirror feature directories where useful.
Tests for shared scripts live here under the matching responsibility (`dependencies/`, `preview/`,
`site/`, `benchmarks/`, `tooling/`). Documentation tests belong to `apps/docs/tests/`.

## Discovery and sets

```sh
npm test
npm test -- --skip-build --set benchmarks
npm test -- --set types --list
npm test -- --skip-build --workspace apps/demo
npm test -- --skip-build --set browser --path readback
```

`npm test` builds the core library once, then runs the discovered type and unit/integration tests.
Use `--skip-build` after a package build or in pipelines that already built packages.
`--list` prints selected paths without importing tests, building packages or opening browsers.
`--path`, `--name` and `--workspace` are case-insensitive regex filters; workspace is its
repository-relative directory. Runtime test cases themselves use Node's standard `node:test` API.
Type tests use the project's TypeScript compiler with strict checking.

Name normal Node tests `*.test.mjs`, type contracts `*.types.ts`, real-browser checks
`*.browser.test.mjs`, generated-artifact checks `*.generated.test.mjs`, and expensive/manual
investigations `*.manual.test.mjs`. Browser/manual/generated suffixes precede `.test.mjs`.
Helpers and fixtures do not use test suffixes. Discovery skips `fixtures/`, `config/`, `output/`,
`build/`, `dist/`, `coverage/`, hidden directories and `node_modules/`; it does not follow symlinks.
A fixture is fixed test input or a prepared scenario; keep it tracked.

`config/sets.json` defines sets using the same regex rules as benchmarks: fields are ANDed,
rules are ORed, exclusions remove matches, and `extends` unions selected parent sets.
The default set includes normal tests and type contracts, excluding browser, generated and
manual checks. `full` adds browser and generated checks; `manual` is explicitly opt-in.
`deployment` selects predeployment browser checks; `smoke` selects slower captures and assembled
site checks. Focused `types`, `unit`, `docs`, `site`, `media`, `diagnostics`, `dependencies`,
`source` and `benchmarks` sets support local work. Generated checks require prepared docs;
smoke checks may require an assembled site. Configuration uses one test process at a time by
default to avoid competing servers/GPUs. Override with positive `--concurrency` when suitable.

There is no separate PR/release correctness standard: both use the same default suite.
Hardware/media and generated-artifact prerequisites determine separate sets, not weaker assertions.

## Browser checks and output

Chrome profiles and launch/cleanup defaults live in `scripts/config/browser.json`. Tests use the
shared `scripts/browser/launch.utils.mjs` launcher. Install the pinned browser with
`npx puppeteer browsers install chrome`; audio/media checks may also require FFmpeg/FFprobe.
Readback checks exercise real WebGPU pixels, padded rows and orientation. Keep one canonical
readback implementation and test it rather than maintaining a second copy in tests.

Generated diagnostics, screenshots and temporary capture sites belong under ignored `tests/output/`
or an OS temporary directory. Tests must clean up servers/browsers and preserve the original
failure if cleanup also fails. General deadlines/cleanup helpers live in `scripts/process/`.

## Retained and retired checks

The previously unwired decal-editor regression now runs by discovery and checks scene traversal
and exported decal configuration. The destructive lifetime capture remains an explicitly manual
browser investigation. The obsolete Create React App starter test and duplicate readback test/helper
were removed; maintained pixel checks retain the relevant coverage. Performance experiments belong
in the benchmark workspace, not the test suite.

Run `npm run lint` for all maintained code, including tests. Workspace ESLint configs inherit shared
quote and spacing rules; lines over 120 characters are warnings. See [CONTRIBUTING](../CONTRIBUTING.md)
and the [benchmark workspace](../benchmarks/README.md) for adjacent responsibilities.
