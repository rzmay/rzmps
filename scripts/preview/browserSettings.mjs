/** Keep Linux software-rendering setup explicit and reproducible. */
export function previewBrowserArguments({ platform = process.platform, ci = process.env.CI === 'true' } = {}) {
  const args = [
    '--disable-dev-shm-usage',
    '--enable-unsafe-webgpu',
    '--autoplay-policy=no-user-gesture-required',
    '--enable-logging=stderr',
  ];
  if (ci) args.push('--no-sandbox', '--disable-setuid-sandbox');
  if (ci && platform === 'linux') {
    args.push(
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--use-webgpu-adapter=swiftshader',
      '--use-gpu-in-tests',
      '--disable-gpu-watchdog',
      // Chrome 154's Maglev tier can spin in Three.js float formatting on emulated Linux/x64.
      // This keeps baseline/TurboFan compilation and leaves the WebGPU backend unchanged.
      '--js-flags=--no-maglev',
    );
  } else args.push('--use-angle=default');
  return args;
}
