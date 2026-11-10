"""Manual Mantaflow reference: blender -b --python blender-smoke.py -- /tmp/smoke-study."""
import bpy
import json
import math
import os
import sys
import tempfile

output = sys.argv[sys.argv.index('--') + 1]
os.makedirs(output, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 60
scene.frame_end = 180
scene.gravity = (0, 0, -9.81)
bpy.ops.mesh.primitive_cube_add(size=16)
domain = bpy.context.object
modifier = domain.modifiers.new('Smoke', 'FLUID')
modifier.fluid_type = 'DOMAIN'
settings = modifier.domain_settings
settings.domain_type = 'GAS'
settings.resolution_max = 64
settings.cache_frame_end = scene.frame_end
settings.cache_type = 'MODULAR'
settings.cache_data_format = 'UNI'
settings.cache_directory = tempfile.mkdtemp(prefix='cache-', dir=output)
settings.use_dissolve_smoke = False
settings.vorticity = 0.2
settings.alpha = 0
settings.beta = 1
settings.use_adaptive_domain = False
for face in ('front', 'back', 'left', 'right', 'top', 'bottom'):
    setattr(settings, 'use_collision_border_' + face, False)
bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=0.45)
source = bpy.context.object
flow = source.modifiers.new('Source', 'FLUID')
flow.fluid_type = 'FLOW'
emission = flow.flow_settings
emission.flow_type = 'SMOKE'
emission.flow_behavior = 'INFLOW'
emission.density = 1
emission.temperature = 1
emission.use_initial_velocity = True
emission.velocity_coord = (0, 0, 0.8)
emission.use_inflow = True
emission.keyframe_insert('use_inflow', frame=1)
emission.keyframe_insert('use_inflow', frame=12)
emission.use_inflow = False
emission.keyframe_insert('use_inflow', frame=13)
bpy.context.view_layer.objects.active = domain
source.select_set(False)
domain.select_set(True)
bpy.ops.fluid.bake_data()
results = {}
for frame in (30, 60, 120, 180):
    scene.frame_set(frame)
    bpy.context.view_layer.update()
    evaluated = domain.evaluated_get(bpy.context.evaluated_depsgraph_get()).modifiers['Smoke'].domain_settings
    density = list(evaluated.density_grid)
    velocity = list(evaluated.velocity_grid)
    resolution = tuple(evaluated.domain_resolution)
    total = sum(density)
    energy = sum(d * sum(v * v for v in velocity[i * 3:i * 3 + 3])
                 for i, d in enumerate(density))
    results[frame] = {'density': total, 'peak': max(density, default=0),
                      'rmsGridSpeed': math.sqrt(energy / max(total, 1e-6)),
                      'resolution': resolution}
    nx, ny, nz = resolution
    pixels = []
    for z in range(nz):
        for x in range(nx):
            optical_depth = sum(density[x + nx * (y + ny * z)] for y in range(ny)) * 16 / nx
            value = 1 - math.exp(-optical_depth)
            pixels.extend((value, value, value, 1))
    image = bpy.data.images.new('Density projection', width=nx, height=nz)
    image.pixels = pixels
    image.filepath_raw = os.path.join(output, f'density-{frame}.png')
    image.file_format = 'PNG'
    image.save()
with open(os.path.join(output, 'metrics.json'), 'w') as handle:
    json.dump(results, handle, indent=2)
print(json.dumps(results))
