# Headless WebGPU diagnostics

`npm run preview:linux -- --example fireflies` builds the preview entry and captures
that example in the matching Puppeteer Docker image, using Linux/amd64, SwiftShader,
two CPUs and 7 GB RAM. Docker must be running. On ARM hosts this uses x86 emulation;
it is useful for reproducing Linux failures but is not identical to native Ubuntu CI.
It does not generate documentation or install dependencies. Build the packages first.
Use `--site /path/to/production/demo` to reuse a bundle. Standard capture options such
as `--width`, `--height`, `--warmup`, `--backend` and `--output` override example metadata.
Default output is ignored `benchmark-results/preview-linux/`.

Captures record the browser version and flags, adapter/device features and limits,
GPU errors and device loss, shader/pipeline timings, the last simulation/render phase,
Chrome's stderr, and Linux cgroup memory/OOM counters. WGSL sources are saved in
`shaders/`. GPU-info snapshots are bounded and may fail without blocking capture.

Documentation captures preserve these files for every failed retry under
`benchmark-results/preview-diagnostics/<example>/attempt-<n>/`. Override that root
with `RZMPS_PREVIEW_DIAGNOSTICS_DIR`. CI uploads the directory even when generation
fails. A missing image is still a failure; WebGPU never falls back to WebGL.

WebGPU image capture reads an explicit render target rather than the headless canvas
swap chain. Readback strips WebGPU's padded rows and uses an sRGB target. The separate
`node --test scripts/tests/preview/readback.test.mjs` preflight checks actual colors,
orientation, and an unaligned width before CI attempts the example collection.
`npm run test:preview-diagnostics` tests logging and row packing without a browser.

Linux software captures disable Chrome's GPU watchdog because software shader work
can exceed its hardware-oriented deadline. The capture retains its own 180-second
timeout. This follows the mitigation in
[Three.js PR #33650](https://github.com/mrdoob/three.js/pull/33650).
[Chromium's SwiftShader documentation](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/gpu/swiftshader.md)
and [Chrome's headless WebGPU guide](https://developer.chrome.com/blog/supercharge-web-ai-testing)
explain the graphics backend configuration. Additional Vulkan flags alone are not
proof of a working capture; use the pixel preflight and a complete example capture.

## Investigation results

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

The workaround is limited to Linux CI preview browsers; baseline/TurboFan JIT,
WebAssembly, and WebGPU remain enabled. Interactive rendering and benchmarking
browser settings are unchanged. The pixel preflight additionally exercises the
actual Three.js shader constant formatter repeatedly. Ubuntu runner and Puppeteer
versions are pinned, and failure diagnostics remain uploaded for native CI results.
