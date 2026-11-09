/** Use Puppeteer's pinned Chrome for Testing; never substitute another backend. */
export function browserArguments({ ci = process.env.CI === 'true', platform = process.platform } = {}) {
  const args = ['--disable-dev-shm-usage', '--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required'];
  if (ci) args.push('--no-sandbox', '--disable-setuid-sandbox');
  if (ci && platform === 'linux') args.push('--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader', '--use-gpu-in-tests',
    '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--disable-vulkan-surface');
  else args.push('--use-angle=default');
  return args;
}
