# Repository automation

This private workspace owns shared automation, not test suites or benchmark workloads.
Run a task from the repository root with `npm run scripts <task> -- <options>`.
Common root entry points (`dev`, `build`, `test`, `lint`, `preview`, `benchmarks`) remain available.

- `browser/` and `config/browser.json`: shared Puppeteer launch profiles for native and Linux CI execution.
- `process/`: shared bounded cleanup and deadline helpers.
- `dependencies/`: dependency analysis and PR warning comments.
- `preview/`: capture, encoding, readback and diagnostics shared by the demo and documentation.
- `site/`: combined development server, assembly, serving and deployment validation.
- `workspaces.utils.mjs`: npm workspace resolution shared by build, dev, tests and benchmarks.
- `discover.utils.mjs` and `selection.utils.mjs`: common file discovery and JSON regex selection.
- `processes.mjs`: explicit build, check, deployment and PR preparation pipelines.

Documentation-specific generation, templates, validation and media manifests belong to
`apps/docs/scripts/`, invoked through `@rzmps/docs`. Test and benchmark runners and their
configuration belong to the [tests](../tests/README.md) and [benchmarks](../benchmarks/README.md)
workspaces. Add automation tests under the relevant directory in root `tests/`, mirroring
this workspace's ownership; do not place executable tests in `scripts/`.

Workspace enumeration uses npm's `@npmcli/map-workspaces` resolver against root `package.json`.
Only declared directories containing a package manifest qualify; dependencies, unrelated files
and folders without manifests do not. Package builds and watchers select the resolved `packages/`
workspaces. Test/benchmark collection then walks only each owner's named `tests/` or `benchmarks/`
subtree, skipping hidden folders, symlinks, fixtures, config, dependencies and generated
`output/`, `build/`, `dist/` and `coverage/`. It never scans the whole repository for test files.
Keep workspace patterns narrow; a manifest-bearing directory explicitly matched by a pattern is
an intended workspace under npm's rules.

## Named processes

`npm run scripts pr:prepare` builds packages in dependency order once, runs the discovered
unit and type tests, measures the reported browser benchmark set, updates README tables from
that artifact, checks documentation freshness, checks generated docs and
links, builds the demo and checks whitespace. Steps log their activity and stop on failure.
It does not create commits or open an editor. Cross-branch ABBAAB comparisons run separately in CI.
After a successful preparation, an ignored local receipt fingerprints source files and build outputs.
Repeating preparation with identical inputs and outputs exits before builds, tests or benchmarks.
A clean worktree alone does not skip preparation: committed changes can still need preparation.
Documentation uses CI's `generate --check` first and regenerates documentation and the published skill
only when that check reports stale output (exit code 2). An up-to-date check skips regeneration;
other validation failures stop preparation. The check still runs TypeDoc in a temporary directory to
compare expected output and restores ignored build artifacts required by the docs build.

`build:site` builds packages, generates source documentation, validates it, builds the demo and
assembles `dist/`. `deploy:site` additionally restores/generates preview media and validates assets
and SEO. Neither ordinary development nor `build:site` captures media. Deployment needs FFmpeg,
FFprobe and Puppeteer's pinned Chrome. `--skip-build` reuses existing package builds;
`--check-generated` reuses documentation prepared by an earlier stage.

Use `check:source`, `check:dependencies`, `check:site`, `check:docs` or `check:agents` for focused
checks. `check:docs:prepared` checks generated artifacts after a pipeline has already validated
source. `build:packages`, `build:demo` and `build:docs` expose individual build stages.

## Formatting and configuration

Run `npm run lint` for maintained source, scripts, tests and benchmarks. Shared ESLint rules
use single quotes (double quotes may avoid escaping), double quotes for JSX attributes, and
warnings for lines over 120 characters. Prettier shares that 120-character target. Errors fail CI;
line-length warnings are advisory. Workspace configs inherit these rules rather than duplicate them.

`config/browser.json` owns launch flags, timeouts and preview cleanup defaults. Profiles retain
purpose-specific settings, including Linux software rendering. Benchmark lifecycle deadlines and
measurement settings live separately in `benchmarks/config/`; do not duplicate them in callers.

## Headless WebGPU diagnostics

`npm run scripts preview:linux -- --example fireflies` builds the preview entry and captures
that example in the matching Puppeteer Docker image, using Linux/amd64, SwiftShader,
two CPUs and 7 GB RAM. Docker must be running. On ARM hosts this uses x86 emulation;
it is useful for reproducing Linux failures but is not identical to native Ubuntu CI.
It does not generate documentation or install dependencies. Build the packages first.
Use `--site /path/to/production/demo` to reuse a bundle. Standard capture options such
as `--width`, `--height`, `--warmup`, `--backend` and `--output` override example metadata.
Default output is ignored `tests/output/preview-linux/`.

Captures record the browser version and flags, adapter/device features and limits,
GPU errors and device loss, shader/pipeline timings, the last simulation/render phase,
Chrome's stderr, and Linux cgroup memory/OOM counters. WGSL sources are saved in
`shaders/`. GPU-info snapshots are bounded and may fail without blocking capture.

Documentation captures preserve these files for every failed retry under
`tests/output/preview-diagnostics/<example>/attempt-<n>/`. Override that root
with `RZMPS_PREVIEW_DIAGNOSTICS_DIR`. CI uploads the directory even when generation
fails. A missing image is still a failure; WebGPU never falls back to WebGL.

WebGPU image capture reads an explicit render target rather than the headless canvas
swap chain. Readback strips WebGPU's padded rows and uses an sRGB target. The separate
`node --test tests/preview/readback.browser.test.mjs` preflight checks actual colors,
orientation, and an unaligned width before CI attempts the example collection.
`npm test -- --skip-build --set diagnostics` tests logging and row packing without a browser.

Linux software captures disable Chrome's GPU watchdog because software shader work
can exceed its hardware-oriented deadline. The capture retains its own 180-second
timeout. This follows the mitigation in
[Three.js PR #33650](https://github.com/mrdoob/three.js/pull/33650).
[Chromium's SwiftShader documentation](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/gpu/swiftshader.md)
and [Chrome's headless WebGPU guide](https://developer.chrome.com/blog/supercharge-web-ai-testing)
explain the graphics backend configuration. Additional Vulkan flags alone are not
proof of a working capture; use the pixel preflight and a complete example capture.

### Investigation results

Using Puppeteer 25.12.0 / Chrome 154.0.8037.57 in the cached Debian Linux/amd64
container on an ARM Mac, the original fireflies capture reproduced the exact
`A valid external Instance reference no longer exists` exception. Immediately
before it, Chromium reported failure to create a `WebGPUSwapBufferProvider` shared
image. Disabling the watchdog alone reproduced the same failure. Enabling Vulkan
avoided that immediate exception but the particle capture subsequently timed out.

Explicit render-target readback passed the Linux two-color pixel probe, including
orientation and padded rows. The next full-scene attempt reached all 360 warmup
steps but stalled while building the populated scene's materials. A standalone
17-light PBR scene passed, so the apparent lighting stall was investigated with
V8 CPU sampling rather than treated as a GPU rendering timeout.

The profile recorded 40,487 samples (93.1% of total time) inside Maglev-compiled
`NodeBuilder._toFloat`, called by shader constant generation. Disabling only Maglev
with `--js-flags=--no-maglev` made the unchanged full fireflies capture complete in
about 17 seconds. Two more fresh Linux/amd64 containers using the final code passed
in about 18 seconds each, at 1920x1080 after 360 steps. Both recorded 96 GPU-simulated
fireflies, attached glow pulses, active lights, and valid source attachments. The
images were inspected. Native Mac WebGPU also passed. No preset or light renderer
was removed or reduced in the final code.

The workaround is limited to Linux CI automation browsers; baseline/TurboFan JIT,
WebAssembly, and WebGPU remain enabled. Interactive rendering is unchanged. Both revisions in benchmark comparisons use the same
automation browser profile. The pixel preflight additionally exercises the
actual Three.js shader constant formatter repeatedly. Ubuntu runner and Puppeteer
versions are pinned, and failure diagnostics remain uploaded for native CI results.

Documentation media lives in `apps/docs/public/previews/` and is ignored by Git.
`npm run generate:previews --workspace @rzmps/docs` generates the complete set; use
`npm run generate:previews --workspace @rzmps/docs -- --example collisionSubEmitters` for one example (repeat
`--example` to select several). Source/docs generation alone does not capture media.
Manual CLI and smoke-test captures live under `tests/output/previews/`.

Examples tagged `audio` capture the actual Three.js listener mix through an
OfflineAudioContext. Its clock advances alongside simulation steps, and warmup is
trimmed from the stereo PCM before FFmpeg encodes AAC (MP4) or Opus (WebM). Native
video controls allow unmuting; autoplay always starts muted and respects reduced
motion. PNG/contact-sheet captures retain their existing behavior.

Shared documentation quality is configured in `apps/docs/scripts/preview-settings.mjs`:
1920×1080 for both PNG posters and video frames, 30 fps, and CRF 18 video encoding.
Each factory's `metadata.previewSettings.duration` sets its clip length. It normally
matches the root ParticleSystem duration; Fireflies samples 10 seconds of its
120-second ambient cycle, and Fireball captures two 1.25-second bursts. Individual
presets can also override width, height, fps, format, or crf in `previewSettings`.
