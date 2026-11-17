import config from '../config/browser.json' with { type: 'json' };

/** Baseline launch flags live in JSON; measurement-specific pacing remains explicit. */
export function browserArguments({
  platform = process.platform,
  ci = process.env.CI === 'true',
  profile = 'preview',
  vsync = true,
} = {}) {
  const selected = config.profiles[profile];
  if (!selected) throw new Error(`Unknown browser profile: ${profile}`);
  const software = ci && platform === 'linux';
  return [
    ...new Set([
      ...config.common,
      ...(ci ? config.ci : []),
      ...config.environments[software ? 'linuxCi' : 'native'],
      ...selected.args,
      ...(software ? selected.linuxCi : []),
      ...(!vsync ? config.uncapped : []),
    ]),
  ];
}

export function browserLaunchOptions(profile = 'preview', overrides = {}) {
  if (!config.profiles[profile]) throw new Error(`Unknown browser profile: ${profile}`);
  return { headless: true, ...config.profiles[profile].launch, args: browserArguments({ profile }), ...overrides };
}

export const browserCleanup = config.cleanup;
