import * as THREE from 'three';
import { mix, vec2, normalize } from 'three/tsl';
import { MaterialCopy, MaterialCopySource, Module, Particle, type ParticleInitializationContext,
  type GPUParticleInitializationContext, type GPUParticleLike, DecalRenderer, MeshRenderer, AudioRenderer } from '../../build/index.mjs';

class Birth extends Module {
  constructor() { super(() => {}, { modifyGPU() {} }); }
  override initializeParticle(particle: Particle, context: ParticleInitializationContext): void {
    particle.mass = context.event ? 2 : 1;
  }
  override initializeParticleGPU(particle: GPUParticleLike, context: GPUParticleInitializationContext): void {
    particle.mass.assign(context.event ? 2 : 1);
  }
}
new Birth();
new MaterialCopy({ source: MaterialCopySource.Event, resolveSourceGPU: (_particle, context) => context.event
  ? { binding: context.event.data[0] } : undefined });
new DecalRenderer(new THREE.MeshStandardMaterial(), {
  materialComposite: (source, dest, context) => {
    context.function('blend', 'vec3 blend(vec3 a, vec3 b) { return normalize(a+b); }');
    return { color: context.sampleSource('color', `(${context.sourceUV} + vec2(0.1))`), normal: dest.normal };
  },
  materialCompositeGPU: (source, dest, context) => ({
    color: context.sampleSource('color', context.sourceUV.add(vec2(0.1))),
    normal: normalize(mix(source.normal, context.sampleDest('normal', context.destUV), dest.opacity)),
  }),
});
new MeshRenderer({ materialCompositeGPU: (source) => ({ color: source.color, opacity: source.opacity }) });

new DecalRenderer(new THREE.MeshStandardMaterial(), {
  onSpawn: (_data, _source, parameters) => ({ size: parameters.size.clone().multiplyScalar(0.5) }),
  onCollision: (hit, _source, parameters) => ({ opacity: parameters.opacity * hit.impulse.length() }),
  onEvent: { mark: (_data, _source, parameters) => ({ lifetime: parameters.lifetime * 2 }) },
  impulseAffectsSize: 0.3,
}).onEvent('splash', (_data, _source, parameters) => ({ rotation: parameters.rotation + 1 }));
new AudioRenderer({
  onSpawn: (_data, _source, parameters) => ({ pitch: parameters.pitch * 1.1 }),
  onCollision: () => false,
  onEvent: { chime: (_data, _source, parameters) => ({ lowPass: parameters.lowPass * 0.5 }) },
}).onEvent('bell', (_data, _source, parameters) => ({ volume: parameters.volume * 2 }));

new DecalRenderer(new THREE.MeshStandardMaterial()).onEvent('collision', (hit, _source, parameters) => ({
  size: parameters.size.clone().multiplyScalar(hit.impulse.length()),
}));

// Material lists may contain any nonzero number of complete map sets.
new DecalRenderer([new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial(),
  new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial(),
  new THREE.MeshStandardMaterial()], { materialIndex: 2 });

new MeshRenderer({ textureCopyQuality: 0.5, atlasOptions: { maxTileSize: 2048, minCapacity: 4 } });
