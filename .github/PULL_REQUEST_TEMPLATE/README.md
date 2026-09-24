# Pull Request Templates

GitHub supports multiple pull request templates in this folder. When opening a
pull request, choose the template that best matches the change by adding
`?template=template-name.md` to the compare URL, or copy the relevant checklist
into the pull request body.

Templates:

- `bug_fix.md`
- `feature.md`
- `new_module.md`
- `new_renderer.md`
- `new_preset.md`

If the change spans multiple categories, use `feature.md` and call out the
additional areas in the description.

`new_module.md` and `new_renderer.md` ask contributors to update the relevant
README sections directly. `new_renderer.md` and `new_preset.md` also ask for a
screenshot, video, or GIF so visual changes are reviewable without everyone
rebuilding the demo locally.
