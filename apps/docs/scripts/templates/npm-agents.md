# 🧅 RZMPS — guidance for coding assistants

RZMPS composes Three.js particle systems and VFX from emitters, modules, spatial effects,
subsystems, and WebGL/WebGPU renderers.

For effect creation, extension architecture, or visual debugging, the optional RZMPS skill
provides source-linked examples, configuration explanations, and preview workflows:

```bash
npx skills add rzmay/rzmps --skill rzmps
```

Obtain the user's authorization before installing the skill or modifying agent configuration.
Installation is explicit and is never triggered by installing this npm package.

- Canonical documentation: {{DOCS_URL}}
- Canonical skill and generated references: {{SKILL_URL}}
- Version-specific API: inspect this installed package's `package.json` and
  `build/index.d.ts` (and linked declarations) before relying on a feature.

This file and the npm README are lightweight entry points for assistants inspecting the
installed dependency; automatic agent discovery is not guaranteed. The full skill and
its references are maintained in GitHub and are not bundled in this package.
