---
title: "Spheres"
example: spheres
---

[View live example](https://rzmps.rzmay.com/example/spheres)

# Spheres <ExampleAttribution />

<ExampleTags />

These particles should look rounded even though they are flat billboards. The preset keeps motion and color simple
so you can see how lighting creates the illusion before layering on a more complex effect.

<ExamplePreview />

## Leave room to read each particle

A small source sends particles outward, and zero gravity keeps falling motion from distracting from their appearance.
A few distinct colors and modest size variation make individual spheres easy to follow. Their long lifetimes give you
time to move the camera and inspect the lighting. The module list is empty: there is no hidden lifetime change to
explain the highlights or silhouette.

<ExampleCode region="emitters" />
<ExampleCode region="modules" />

## Suggest a sphere through lighting

The circular mask supplies the silhouette, while spherical normals make the lighting turn across its face. Full normal
lighting emphasizes that rounded response; moderate roughness keeps the highlight from looking like polished metal.
The model is still a billboard, so this is useful when the appearance matters more than a geometric sphere silhouette
from every angle. Compare [Cube Instances](./cubes.md) when actual faces and edges should be visible.

<ExampleCode region="renderers" />

## Assemble the effect

Pass the prepared components into the system constructor. The settings here control the whole effect, while the
emitters, modules and renderers above define its individual layers. Add the returned root to your scene and update
that root once per frame.

<ExampleCode region="system:assembly" />
