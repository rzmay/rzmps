# Contributing to RZMPS

Thanks for helping improve RZMPS. The project is a monorepo with a core
particle simulation library, optional physics integrations, and a browser demo.

## Project Layout

- `packages/rzmps`: core library.
- `apps/demo`: interactive demo, benchmark runner, scenes, and particle
  presets.
- `packages/ammo`, `packages/jolt`, `packages/rapier`:
  optional physics backends.
- `scripts`: workspace scripts, benchmark reporting, and repo tooling.

## Local Setup

```bash
npm install
npm run build:modules
npm start --workspace apps/demo
```

The demo usually runs at `http://localhost:5173`.

## Development Workflow

1. Open an issue for substantial changes before starting work.
2. Keep pull requests focused on one behavior change or one feature.
3. Preserve the public API unless the change is explicitly discussed.
4. Prefer existing module, emitter, renderer, and GUI patterns.
5. Add or update demo presets when visual behavior is hard to understand from
   code alone.
6. Update READMEs when user-facing behavior changes.

## Build And Benchmark Commands

Build all publishable packages:

```bash
npm run build:modules
```

Build the demo:

```bash
npm run build --workspace apps/demo
```

Run core regression tests:

```bash
npm test
```

Run browser benchmarks:

```bash
npm run benchmark:run
```

Update benchmark tables in READMEs:

```bash
npm run benchmark:update-report
```

Review the release process:

```text
docs/release-flow.md
```

Add missing author metadata to newly added demo presets:

```bash
npm run presets:add-author -- --github-user your-github-name
```

## Pull Request Automation

The PR maintenance workflow runs on same-repository pull requests and attempts
to add missing author metadata to newly added demo preset files based on the PR
author's GitHub username.

The CI workflow runs `npm test`, builds the demo, and checks whitespace on pull
requests and pushes to `develop`. Benchmarks are intentionally not part of CI by
default because they are hardware- and browser-environment-sensitive; include a
benchmark report in the pull request when changing performance-sensitive code.

Preset author metadata is optional and should be attached to the loader function:

```js
createMyPreset.author = "github-user";
```

The demo derives profile links and avatars from that GitHub username.

GitHub does not generally allow workflows to push commits back to pull requests
from forks with the default token. For forked PRs, a maintainer may need to run
`npm run presets:add-author -- --github-user github-user` locally or push a
follow-up commit from a trusted branch.

## Contribution Areas

Library changes:

- Keep simulation behavior deterministic where possible.
- Avoid moving simulation to GPU compute unless there is an explicit design
  discussion for that feature.
- Preserve extensibility of `Module`, `Emitter`, and `Renderer`.
- Be careful with hot paths: avoid per-particle allocation, unnecessary array
  copies, and repeated setup work.

Demo changes:

- Keep presets inspectable and useful for debugging real behavior.
- Add scene GUI controls for meaningful scene parameters.
- Credit authors for contributed presets. New preset loaders may use
  `loader.author = "github-user"`.
- Prefer clear visual validation over decorative complexity.

Renderer changes:

- Reuse buffers where possible.
- Grow capacities geometrically.
- Avoid per-frame material or geometry rebuilds unless necessary.
- Explain any WebGL/WebGPU differences in the pull request.

## Pull Request Checklist

- The change is scoped and documented.
- Relevant build commands pass.
- Demo presets or docs are updated when useful.
- Benchmark impact is reported for performance-sensitive changes.
- New public API has a clear reason and naming.

## Code Of Conduct

All contributors are expected to follow `CODE_OF_CONDUCT.md`.
