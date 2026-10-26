# AI Coding Assistants

The RZMPS skill helps coding assistants create and debug Three.js particle systems and VFX,
compose emitters, modules, spatial effects, and renderers, and validate WebGL and WebGPU
output using actual canvas previews. The complete skill lives in the public GitHub repository
at [.agents/skills/rzmps](https://github.com/rzmay/rzmps/tree/HEAD/.agents/skills/rzmps).
Its entry point and references are generated from these canonical human guides and API declarations.

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

The repository, this documentation site, the npm README, and generated `llms.txt` all point
to the same canonical skill in GitHub. `llms.txt` includes explicit installation guidance;
the website does not host another copy of the skill or its bundled references.

`llms-full.txt` is an optional generated Markdown bundle of the guides, examples, and API
reference for tools that need a complete documentation snapshot. It is a convenience format,
not a requirement for skill discovery, installation, or automatic agent access. Prefer the
index and relevant pages when the full bundle is unnecessary.

`npm run docs:generate` refreshes agent references, documentation discovery files, npm `AGENTS.md`,
and README guidance blocks. `npm run agents:check` validates frontmatter and reference links,
discovers and installs the checkout skill in a temporary project, and audits `npm pack --dry-run`.
It leaves consumer projects and the user's agent configuration untouched.

The entire `.agents/skills/rzmps` folder remains committed so GitHub installers can fetch it
without running a build. Its `SKILL.md` is generated from the definition below, and its reference
pages come from the guides, examples, and API declarations. Website indexes and `llms` files
are ignored build artifacts, regenerated for local builds and deployment. CI checks that the
committed skill matches its canonical sources; it does not automatically commit changes.

Run `npm run agents:check -- --github` to test the exact public shorthand discovery command.
CI checks GitHub commit URLs after pushes and the shorthand after publishing to the default
branch; pull requests validate their checkout without assuming the proposed skill is already public.

## Canonical Skill Definition

The following metadata and workflow generate `.agents/skills/rzmps/SKILL.md`. Edit them here;
the generated skill rewrites documentation links to bundled references so it remains portable.

<!-- skill:metadata:start -->
```yaml
name: rzmps
description: Build and debug Three.js particle systems and VFX in RZMPS using emitters, modules, renderers, and WebGL/WebGPU canvas previews.
```
<!-- skill:metadata:end -->

<!-- skill:instructions:start -->
Inspect the installed package version and public exports before using a feature. In this repository, use the current branch's TypeScript source. Prefer existing emitters, modules, renderers, and spatial effects before adding custom behavior.

Read [getting started](first-particle-system.md) for scene ownership and updates, [concepts](concepts.md) for lifecycle, priority, tags, spatial collections, and subsystem composition, and [GPU processing](gpu-processing.md) before implementing TSL callbacks, readback, collision, or spatial-grid behavior. Search the [generated API](../api/index.md) for signatures.

Reuse a canonical factory from `examples/`; inspect [example explanations](../examples/index.md) for its configuration rationale. Preserve the default factory and author metadata contracts. Add balanced documentation source regions and update the authored Markdown explanation, then run `npm run docs:generate` and `npm run docs:check`.

Check the selected renderer and custom material compatibility using [compatibility](compatibility.md). Build packages, run `npm run preview -- --example <id> --backend webgl`, and inspect the contact sheet and metadata. Repeat with webgpu when relevant; report unavailable backends explicitly. Adjust warmup, interval, or scene to capture the actual event. Technical success alone does not establish visual quality.

Update root systems once; parents own subsystem timing. Follow Module, Renderer, Emitter, and SpatialEffect CPU/GPU extension hooks and priority semantics. Do not treat WebGPU rendering as proof of GPU simulation; check component support and `isGPUProcessingActive`. Use features present in the installed version and current branch. Reference files are generated from human documentation; edit their canonical source instead.

Repository preview scripts and `examples/` are checkout tools. In a consumer project, adapt an example to its existing rendering loop or use a repository checkout for previews; do not assume consumers have repository npm scripts. Read the [installation guidance](#installation) before installing the skill or changing agent configuration.
<!-- skill:instructions:end -->
