# Module Priority and Execution Order

RZMPS sorts modules and generic spatial effects together by numeric priority. Smaller priorities run first within a phase. Input order is preserved for equal priorities. A module's `dependents` are flattened before sorting; each dependent's own priority still determines its phase.

| Priority | Phase | Persistence |
| --- | --- | --- |
| Less than 0 | Before movement | Changes become permanent simulation state |
| 0 up to, excluding, 1 | Before movement | Transient changes influence this frame's movement |
| 1 or greater | After movement | Transient changes affect this frame's rendered appearance |

Use `Module.Priority.Permanent` (`-1`) for acceleration or accumulated changes. Multiply acceleration by `deltaTime` so the change is expressed per second. Use `Module.Priority.PreMovementTransient` (`0.5`) for a temporary velocity adjustment that should influence integration without accumulating into next frame's base velocity. Use `Module.Priority.Transient` (`1`) for a size or tint multiplier derived from normalized particle age.

At the beginning of the next update, cached values are restored. A render-time velocity change therefore does not move the particle in the current frame, and it does not automatically become next frame's velocity. This is why changing the priority can change the meaning of an otherwise identical callback.

Prefer a built-in lifetime module before writing an equivalent callback: those modules already select phases appropriate to their behavior. When combining modifiers that write the same property, inspect both their priorities and whether each callback assigns or multiplies that property. A later assignment can replace an earlier result.

`prepare(system, deltaTime)` runs before the per-particle phase. Use it for shared calculations or spatial collection, and reuse scratch objects in the particle callback. Update LOD can skip module work; disable it when comparing fixed-step effects.
