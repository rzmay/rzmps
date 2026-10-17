# AI Coding Assistants

The RZMPS skill helps coding assistants create and debug Three.js particle systems and VFX,
compose emitters, modules, spatial effects, and renderers, and validate WebGL and WebGPU
output using actual canvas previews. The complete skill lives in the public GitHub repository
at [.agents/skills/rzmps](https://github.com/rzmay/rzmps/tree/HEAD/.agents/skills/rzmps).
Its references are generated from these canonical human guides and API declarations.

## Installation

Choose an installation explicitly after reviewing the skill and authorizing any changes to
agent configuration. Installing `@rzmps/rzmps` with npm never installs a skill automatically.

<!-- distribution:installation:start -->
```bash
# Discover available skills
npx skills add rzmay/rzmps --list

# Install the RZMPS skill
npx skills add rzmay/rzmps --skill rzmps

# Install globally (optional)
npx skills add rzmay/rzmps --skill rzmps -g
```
<!-- distribution:installation:end -->

The CLI lets you select compatible agents. Project installation affects the current project;
`-g` installs at user scope. The skill follows the [Agent Skills format](https://agentskills.io/specification).
Compatible installers discover it directly from GitHub; no manual registry submission is required.
See the [skills CLI documentation](https://github.com/vercel-labs/skills) for agent selection and installation options.

These shorthand commands read the repository's default branch. They become available once
this skill is committed and published there. Before that, test the actual checkout with
`npx skills add . --list`, or use a published branch URL such as
`https://github.com/rzmay/rzmps/tree/develop` in place of `rzmay/rzmps`.
Local validation does not prove that unpushed files are already discoverable from GitHub.

## Lightweight npm Guidance

<!-- distribution:npm-readme:start -->
The optional [RZMPS skill](https://github.com/rzmay/rzmps/tree/HEAD/.agents/skills/rzmps)
helps coding assistants build Three.js particle systems and VFX using emitters, modules,
renderers, and WebGL/WebGPU previews.

```bash
npx skills add rzmay/rzmps --skill rzmps
```

Review the skill and authorize installation before changing agent configuration.
The npm package includes a short generated `AGENTS.md`, without bundling the full skill or
its references. These entry points do not guarantee automatic agent discovery. For the
installed version's API, inspect `build/index.d.ts` and the package version; see the
[canonical documentation](https://rzmps.rzmay.com/docs/) for guides.
<!-- distribution:npm-readme:end -->

## Discovery and Maintenance

The repository, this documentation site, the npm README, and generated `llms.txt` and
`llms-full.txt` all point to the same canonical skill. The site also exposes a generated
portable copy at [agent-skill/SKILL.md](https://rzmps.rzmay.com/docs/agent-skill/SKILL.md), with its relative references
alongside it. That hosted copy is generated, never independently maintained.

`npm run docs:generate` refreshes agent references, hosted skill files, npm `AGENTS.md`,
and README guidance blocks. `npm run agents:check` validates frontmatter and reference links,
discovers and installs the checkout skill in a temporary project, and audits `npm pack --dry-run`.
It leaves consumer projects and the user's agent configuration untouched.

Run `npm run agents:check -- --github` to test the exact public shorthand discovery command.
CI checks GitHub commit URLs after pushes and the shorthand after publishing to the default
branch; pull requests validate their checkout without assuming the proposed skill is already public.
