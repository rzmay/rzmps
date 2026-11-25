# Documentation workspace

This app builds the public VitePress documentation. It owns authored guides, example explanations,
API navigation, source extraction, search/SEO metadata and documentation media generation.
Repository-wide contribution and API conventions live in [CONTRIBUTING](../../CONTRIBUTING.md).

## Writing and editing

- Start with [Writing Example Guides](#writing-example-guides) when changing a preset or its explanation.
- Preset factories live in `examples/presets/`; authored explanations live here in `examples/`.
  Keep code canonical in the factory and reference its source regions with `<ExampleCode />`.
- Conceptual tutorials live in `guides/`. Register their reading order in `scripts/navigation.mjs`.
- Public API comments live with declarations; API Markdown and navigation are generated.
- `contributing.md` is the public contribution landing page, linking to these maintainer instructions and repository contribution policy.
  This README explains the workspace workflow; it is not a second copy of repository policy.

## Commands

From the repository root:

```sh
npm run dev
npm run generate --workspace @rzmps/docs
npm run scripts check:docs
node --test apps/docs/tests/examples.test.mjs examples/tests/catalog.test.mjs
```

Generation updates API pages, discovery data, the published agent skill and README guidance.
It preserves authored example explanations. Check source regions, metadata and explanatory prose before
regenerating; a source link alone cannot teach a design decision. Run `npm run lint` for maintained code.
`npm run scripts pr:prepare` owns the full PR pipeline; see the root contributor guide for its prerequisites.

## Media and generated files

Ordinary source generation, source checks and development do not capture images or videos.
Set `factory.metadata.previewSettings` in the preset; import a scene factory for its preferred scene.
Shared capture defaults live in `scripts/preview-settings.mjs`.

```sh
npm run preview -- --example fire --backend webgl
npm run generate:previews --workspace @rzmps/docs -- --example fire
```

Preview generation needs Puppeteer's pinned Chrome and FFmpeg/FFprobe. Inspect the actual effect when changing
visual behavior; a successfully encoded file does not prove the effect looks right. Deployment restores the media
cache, generates stale assets, validates decoding and hashes, then assembles and checks the published site.
Shared capture and Linux diagnostics are documented in [scripts/README.md](../../scripts/README.md).

Generated API/index pages, navigation JSON, `public/previews/`, `public/llms*.txt` and builds are ignored.
The generated `.agents/skills/rzmps` distribution, root/library README guidance and library `AGENTS.md` stay tracked
for GitHub/npm discovery. Edit their canonical guides/templates and regenerate them rather than editing outputs.

## Search, SEO and checks

Example metadata supplies titles, descriptions, tags, authors and social media references. VitePress owns docs
canonicals and the sitemap; site assembly owns interactive example aliases and root crawler metadata.
The maintained implementation is in `scripts/seo.mjs`, the VitePress configuration and
`scripts/site/check-seo.mjs` at the repository root. The deployment SEO check validates assembled targets.
There is no separate implementation-audit document to keep synchronized with those files.

Documentation tests live in `tests/`. Source tests check extraction, references, metadata and media options;
generated-artifact checks need prepared docs. Root [test](../../tests/README.md) and
[benchmark](../../benchmarks/README.md) workspaces document their selection sets and output formats.
Keep benchmark results, renderer investigations and CI findings in their owning tooling documentation or PR,
not in user-facing example walkthroughs.

## Writing Example Guides

An example should help someone build an effect with an intention of their own. Start by saying what the
viewer should notice, then connect each important piece of code to the visual or audible result it creates.
The reader has not seen your design process: make the reasoning visible without asking them to infer it
from property names or a list of numbers.

### Explain the effect before the components

Describe the intended shape, motion, timing, surface response and sound. A useful opening might explain that
a projectile should feel fast, its wake should linger briefly, and impacts should leave evidence on the wall.
These are choices for that preset, not requirements of RZMPS or rules every projectile must follow.

Then explain the chain of decisions. If a beam should look erratic, explain why noise disturbs its path.
If its impacts should look hot, explain why a dark mark alone is insufficient and how a temporary glow or
smoke layer would communicate heat. These are hypothetical examples of reasoning, not a checklist of features
to add to existing presets. Describe only what the actual factory builds.

For each substantial code block, answer:

- What part of the intended effect does this create?
- Why does this preset use this component, value or timing relationship?
- What would changing it let the reader achieve?

Prefer a consequence over a property inventory: “A short lifetime keeps the flame close to its source” teaches
more than “lifetime is 1.35.” Explain an exact number when it controls a visible relationship; avoid deriving
particle counts or repeating every default just because the data is available.

### Let the explanation determine the layout

Use headings that follow construction: launch a projectile, draw its wake, mark an impact, then add sound.
A simple effect may still read well as setup, emission, motion and appearance. There is no required order or
fixed set of headings. Group emitters, modules and renderers together when they solve the same design problem.
Explain child systems at the point where their relationship to the parent becomes useful.

Keep canonical code in `examples/presets/` and use balanced source regions. Each region must contain complete,
syntactically valid JavaScript statements. Define an emitter, module or renderer before constructing the system,
then pass it into the constructor or add it with the appropriate system method. Do not excerpt an object member
such as `modules: [...]` on its own, and include a helper's function declaration when showing its return statement. The existing `system`, `emitters`,
`modules` and `renderers` categories remain useful extraction labels, not prescribed article sections.
Named regions let a guide show a particular part of a larger factory:

```md
## Let smoke trail behind the projectile

Explain why smoke should linger and why its emission follows distance traveled.

<ExampleCode region="emitters:wake" />
<ExampleCode region="modules:wake" />
```

Use the actual region names in that factory. Avoid showing the complete system and then repeating every nested
component: link the complete source for context and choose smaller blocks for the walkthrough. Keep material setup,
local helpers and curve definitions reachable in the excerpts that use them. Do not copy a second implementation
into Markdown. Keep metadata, attribution, tags, the live-demo link and `<ExamplePreview />` connected to the factory.

### Make curves readable

Prefer named `eaz` easing functions for a single transition and `curves` keyframes for an envelope with several
stages. Keep them local to the self-contained preset. Say whether a callback receives normalized particle age,
depth, size or another parameter: the same-looking function can mean different things in different fields.

For example, hold smoke opacity early, then fade more quickly near death:

```js
import { Easing } from 'eaz';
import { ColorOverLifetime } from '@rzmps/rzmps';

const fadeSmoke = new ColorOverLifetime({
  alpha: age => 1 - Easing.cubic.in(age),
});
```

Here `age` runs from zero to one across a particle's lifetime. `cubic.in` names the shape instead of hiding it in
powers and multiplication. Clamp or remap the input explicitly when a transition occupies only part of the lifetime.
A simple linear ramp is also readable as `THREE.MathUtils.lerp(start, end, Easing.linear.in(age))`.

For smoke that appears softly and fades away, use a timestamp map directly at the input:

```js
import { Curve } from 'curves';
import { ColorOverLifetime } from '@rzmps/rzmps';

const fadeSmoke = new ColorOverLifetime({
  alpha: new Curve({ 0: 0, 0.2: 1, 1: 0 }),
});
```

`Curve` is callable in `curves@1.2.0`: RZMPS passes the normalized age as its time argument. Its bound `.evaluate`
method also works directly, without a wrapper or `.bind()`. Construct the curve once in the configuration,
not inside a per-particle callback. Three keys communicate birth, peak and death; the default cubic easing
softens the transitions. Use as few keys as the intended shape needs.

Timestamp values use the appropriate built-in keyframe type. Write `[value, Easing.linear]` at a timestamp when
you want that key to use linear rather than default easing. A scorch mark needs an additional key because it should
hold its maximum opacity between appearing and fading:

```js
import * as THREE from 'three';
import { Curve } from 'curves';
import { DecalRenderer } from '@rzmps/rzmps';

const scorch = new DecalRenderer(new THREE.MeshBasicMaterial(), {
  opacity: new Curve({ 0: 0, 0.025: 0.05, 0.6: 0.05, 1: 0 }),
});
```

Keep curves directly in their RZMPS input fields rather than
introducing a separate helper section. Source excerpts include the imports they use. Prefer the short easing callback
above for a single transition, and keep direct math for behavior it explains clearly, such as periodic oscillation.

#### Return Three.js values with casting

A vector-shaped curve interpolates plain `{ x, y, z }` values. Use `.cast()` when a DynamicValue expects a
`THREE.Vector3`; the cast view remains callable:

```js
import * as THREE from 'three';
import { Curve } from 'curves';
import { ScaleOverLifetime } from '@rzmps/rzmps';

const stretchSmoke = new ScaleOverLifetime({
  scale: new Curve({
    0: { x: 0.35, y: 0.35, z: 0.35 },
    1: { x: 1.8, y: 2.4, z: 1.8 },
  }).cast(({ x, y, z }) => new THREE.Vector3(x, y, z)),
});
```

This grows the plume more along Y than across it. The curve still describes the shape; the cast only converts the
result to the class required by the input. It runs after interpolation and modifiers.

RGB curves also return plain `{ r, g, b }` objects. Those objects are not Three.js `ColorRepresentation` values,
so cast them to `THREE.Color` too. Construct color endpoints with Three.js when starting from display color strings;
that preserves their conversion into the working color space:

```js
import * as THREE from 'three';
import { Curve } from 'curves';
import { ColorOverLifetime } from '@rzmps/rzmps';

const coolSmoke = new ColorOverLifetime({
  color: new Curve({
    0: new THREE.Color('#ffb570'),
    1: new THREE.Color('#555566'),
  }).cast(({ r, g, b }) => new THREE.Color(r, g, b)),
});
```

The cast view shares its source curve's keys and settings; use `.source` when you need the original unconverted output.
For simple presets, keep the cast inline with the input instead of introducing another named helper.

### Make the source comfortable to read

Use consistent indentation and blank lines between setup, meaningful groups of properties and separate systems.
Avoid a blank line after every scalar property. Give helpers and curves names that describe their purpose.
Add short comments where they explain intent, units, timing or a surprising choice; avoid narrating the syntax.
Keep each preset self-contained, with its materials, helper definitions, cleanup and subsystem wiring visible in
that source. Formatting and curve refactors should preserve the effect unless a visual change is intentional.

A reader should be able to start with the main silhouette, add motion, and layer secondary cues. Point out a few
useful adaptations, such as widening a source, shortening a fade or lowering collision bounce, rather than ending
with an exhaustive catalog of implementation details.

### Keep the audience in view

These walkthroughs teach library use. Explain the scene prerequisites, units and update ownership someone needs
to reproduce the result. Link to feature guides for API details instead of turning an example into an engine manual.
Avoid benchmark numbers, CI comparisons, debugging history, old-versus-new implementation notes and findings from
renderer investigations. Keep those in the relevant test/benchmark workspace, issue or PR. An LOD example can teach
how distance changes density without reporting profiling results or explaining GPU buffer allocation.

### Review the finished walkthrough

Read the guide next to its canonical source. Check that every claimed behavior exists, every source reference resolves,
and every significant layer has a stated purpose. Preserve authors, IDs, source URLs and preview settings.
Use `npm run lint` and the focused example tests from the [docs workspace README](https://github.com/rzmay/rzmps/blob/HEAD/apps/docs/README.md).
When visual behavior changes, inspect the effect; prose and a passing test cannot replace that check.
Regenerate documentation and the published skill through the normal workspace workflow when ready to publish.
