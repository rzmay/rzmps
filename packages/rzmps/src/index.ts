// ParticleSystem
export { default as ParticleSystem } from './core/ParticleSystem';
export type {
  ParticleListener,
  ParticleSystemGPUEmissionSupportReport,
  ParticleSystemOptions,
  SubSystemOptions,
} from './core/ParticleSystem';
export { default as Particle } from './core/Particle';
export {
  GPUParticleContext,
  GPUParticleRenderContext,
  GPUParticleRenderStorage,
  GPUParticleStorage,
  createEmptyGPUParticleBufferState,
  createGPUParticleBufferState,
  createGPUParticleRenderBufferState,
} from './simulation/gpu/Particle';
export type {
  GPUParticleAttributes,
  GPUParticleBufferInitialization,
  GPUParticleBufferState,
  GPUParticleLike,
  GPUParticleRenderBufferState,
  GPUParticleScalarField,
  GPUParticleUpdateContext,
  GPUParticleVectorField,
  GPUReadbackRenderer,
  GPUStorageBufferRenderer,
} from './simulation/gpu/Particle';
export {
  GPUEventBufferState,
  GPUEventType,
  GPU_EVENT_FLOAT_SLOT_COUNT,
} from './events/gpu/EventBuffer';
export type {
  GPUEventReadbackBatch,
  GPUEventRecord,
} from './events/gpu/EventBuffer';
export {
  GPUAllocationBufferState,
  GPUAllocationWriter,
} from './simulation/gpu/AllocationBuffer';
export type {
  GPUAllocationDiagnostics,
} from './simulation/gpu/AllocationBuffer';
export { GPUEmitterInstanceBufferState } from './emission/gpu/EmitterInstanceBuffer';
export type { GPUEmitterInstanceRecord } from './emission/gpu/EmitterInstanceBuffer';
export { GPUEmissionRunBufferState } from './emission/gpu/Emission';
export type { GPUEmissionRunNode } from './emission/gpu/Emission';
export { buildGPUSystemSchedule } from './simulation/gpu/buildGPUSystemSchedule';
export type {
  GPUSystemSchedule,
  GPUSystemScheduleNode,
} from './simulation/gpu/buildGPUSystemSchedule';
export { GPUSelectiveReadbackState } from './simulation/gpu/SelectiveReadback';
export type {
  GPUParticleReadbackField,
  GPUSelectiveReadbackRequest,
  GPUSelectiveReadbackResult,
} from './simulation/gpu/SelectiveReadback';
export { GPUSpatialEffectRegistry, isBatchableEffect } from './spatial/effects/gpu/SpatialEffectRegistry';
export type {
  GPUSpatialBatchableEffect,
  GPUSpatialEffectRecord,
  GPUSpatialEffectType,
  GPUSpatialParameterAccessor,
  GPUSpatialParameterField,
  GPUSpatialParameterLayout,
} from './spatial/effects/gpu/SpatialEffectRegistry';
export {
  getGPUEmitterSupport,
  getGPUEmissionShapeSupport,
} from './emission/gpu/Emission';
export type {
  GPUEmissionSupportLevel,
  GPUEmissionSupportReport,
} from './emission/gpu/Emission';
export { default as LODHelper } from './core/LODHelper';
export type { LODSettings, LODSettingsOptions } from './core/LODHelper';
export { EndBehavior } from './enums/endBehavior';
export { SimulationSpace } from './enums/simulationSpace';
export { MaxCulling } from './enums/maxCulling';

// Emitter
export { default as EmissionShape } from './emission/EmissionShape';
export type {
  EmissionShapeFactoryOptions,
  EmissionShapeOptions,
  VolumeSample,
  VolumeSampleCount,
} from './emission/EmissionShape';
export { default as Emitter } from './emission/Emitter';
export type {
  EmissionContext,
  EmitterOptions,
  SpawnBurst,
} from './emission/Emitter';
export { EmissionSource } from './enums/emissionSource';
export { default as RegisteredEmissionSource } from './emission/EmissionSource';
export type { EmissionSourceData, SubSystemSource } from './emission/EmissionSource';
export type { CPUEventHandler, GPUEventHandler, GPUEventPayload, GPUEventData, GPUEmissionContext,
  EventSubscriptions, ParameterEventHandler, ParameterEventSubscription, ParameterEventSubscriptions } from './events/events.utils';
export { TagSelectionMethod } from './enums/tagSelectionMethod';

// Renderers
export { default as Renderer } from './core/Renderer';
export type { RendererOptions } from './core/Renderer';
export { default as LightRenderer } from './rendering/renderers/LightRenderer';
export type { LightRendererAllocationOptions } from './rendering/renderers/LightRenderer';
export { default as MeshRenderer } from './rendering/renderers/MeshRenderer';
export { default as SpriteRenderer } from './rendering/renderers/SpriteRenderer';
export { default as AudioRenderer } from './rendering/renderers/AudioRenderer';
export type { AudioParameters } from './rendering/renderers/AudioRenderer';
export { default as DecalRenderer, DECAL_RENDERER_USER_DATA_KEY } from './rendering/renderers/DecalRenderer';
export type { DecalInstance, DecalRendererOptions, DecalDirectionSampler, DecalProjectionContext,
  DecalDirection, DecalHitSelection, DecalParameters }
  from './rendering/renderers/DecalRenderer';
export { SpriteMaterialType } from './enums/spriteMaterialType';
export { default as TrailRenderer } from './rendering/renderers/TrailRenderer';
export { TrailMode } from './enums/trailMode';
export { TrailTextureMode } from './enums/trailTextureMode';
export { default as LiveCubemap } from './rendering/renderers/LiveCubemap';
export type { LiveCubemapOptions } from './rendering/renderers/LiveCubemap';

// Modules
export { default as Module } from './core/Module';
export type {
  ModuleCondition,
  ModuleGPUCondition,
  ModuleGPUUpdate,
  ModuleOptions,
  ModuleUpdate,
  SpatialEffectConstructor,
} from './core/Module';
export { default as NoiseModule } from './modules/NoiseModule';
export { default as ForceOverLifetime } from './modules/ForceOverLifetime';
export { default as LimitVelocityOverLifetime } from './modules/LimitVelocityOverLifetime';
export { default as TransformByNoise } from './modules/TransformByNoise';
export { default as ColorBySize } from './modules/ColorBySize';
export { default as ColorBySpeed } from './modules/ColorBySpeed';
export { default as ColorByDepth } from './modules/ColorByDepth';
export { default as ColorOverLifetime } from './modules/ColorOverLifetime';
export { default as DistortionBySize } from './modules/DistortionBySize';
export { default as DistortionBySpeed } from './modules/DistortionBySpeed';
export { default as DistortionByDepth } from './modules/DistortionByDepth';
export { default as DistortionOverLifetime } from './modules/DistortionOverLifetime';
export { default as ScaleBySpeed } from './modules/ScaleBySpeed';
export { default as ScaleByDepth } from './modules/ScaleByDepth';
export { default as ScaleOverLifetime } from './modules/ScaleOverLifetime';
export { default as RotationBySize } from './modules/RotationBySize';
export { default as RotationBySpeed } from './modules/RotationBySpeed';
export { default as RotationByDepth } from './modules/RotationByDepth';
export { default as RotationOverLifetime } from './modules/RotationOverLifetime';
export { default as OrientToDirection } from './modules/OrientToDirection';
export { default as VelocityBySize } from './modules/VelocityBySize';
export { default as VelocityByDepth } from './modules/VelocityByDepth';
export { default as VelocityOverLifetime } from './modules/VelocityOverLifetime';
export { default as SpeedBySize } from './modules/SpeedBySize';
export { default as SpeedByDepth } from './modules/SpeedByDepth';
export { default as SpeedOverLifetime } from './modules/SpeedOverLifetime';
export { default as MassBySize } from './modules/MassBySize';
export { default as MassByDepth } from './modules/MassByDepth';
export { default as MassOverLifetime } from './modules/MassOverLifetime';
export { default as Boids } from './modules/Boids';
export type {
  BoidParticleAffectorOptions,
  BoidsOptions,
} from './modules/Boids';
export { default as BoidAffector } from './spatial/effects/BoidAffector';
export type { BoidAffectorOptions } from './spatial/effects/BoidAffector';
export { default as BoidAffectorHelper } from './spatial/effects/BoidAffectorHelper';
export { default as SpatialEffect, SpatialEffectUpdatePolicy } from './spatial/effects/SpatialEffect';
export type {
  SpatialEffectFeatherUpdate,
  SpatialEffectGPUCondition,
  SpatialEffectGPUTest,
  SpatialEffectGPUUpdate,
  SpatialEffectModifier,
  SpatialEffectOptions,
  SpatialEffectTest,
  SpatialEffectUpdate,
} from './spatial/effects/SpatialEffect';
export { default as SpatialEffectHelper } from './spatial/effects/SpatialEffectHelper';
export { default as KillZone } from './spatial/effects/KillZone';
export type { KillZoneOptions } from './spatial/effects/KillZone';
export { default as Collision } from './modules/Collision';
export type { CollisionListener, CollisionOptions } from './modules/Collision';

// Force Fields
export { default as ParticleForceField } from './spatial/effects/ParticleForceField';
export type { ForceFieldOptions } from './spatial/effects/ParticleForceField';
export { default as ParticleForceFieldHelper } from './spatial/effects/ParticleForceFieldHelper';

// Collision
export type { ICollisionBackend, CollisionHit, CollisionQuery } from './collision/collision.types';
export { default as ThreeCollisionBackend } from './collision/ThreeCollisionBackend';
export type { ThreeCollisionBackendOptions } from './collision/ThreeCollisionBackend';
export { default as ThreeGPUCollisionBackend } from './collision/ThreeGPUCollisionBackend';
export {
  CollisionGeometryUpdatePolicy,
} from './collision/ThreeGPUCollisionBackend';
export type {
  ThreeGPUCollisionBackendOptions,
  ThreeGPUCollisionBackendStats,
} from './collision/ThreeGPUCollisionBackend';

// Dynamic Value
export { default as sampleDynamicValue } from './values/sampleDynamicValue';
export { default as maxDynamicNumber } from './values/maxDynamicNumber';
export { default as minDynamicNumber } from './values/minDynamicNumber';
export { default as maxDynamicVector } from './values/maxDynamicVector';
export { default as minDynamicVector } from './values/minDynamicVector';
export { default as maxDynamicColor } from './values/maxDynamicColor';
export { default as minDynamicColor } from './values/minDynamicColor';
export type { ColorInput, Vector3Input } from './values/valueInput.types';
export type { DynamicValue, DynamicUntimedValue } from './values/dynamicValue.types';
export type { ValueByParameter } from './values/valueByParameter.types';
export { default as ParticleOctree } from './spatial/structures/ParticleOctree';
export type {
  OctreeAggregator,
  OctreeConfig,
  OctreeNode,
  ParticleOctreeQueryOptions,
} from './spatial/structures/ParticleOctree';
export { default as ParticleSpatialGrid } from './spatial/structures/ParticleSpatialGrid';
export type { GPUComputeRange } from './utils/gpu/computeDispatch.utils';
export { SpatialLevels } from './enums/resolveSpatialLevels';
export type { SpatialLevelsInput, SpatialGridOptions } from './enums/resolveSpatialLevels';
export type { SpatialBackend, SpatialAggregator, SpatialAggregateLayout, SpatialAggregateType,
  SpatialAggregateNodes, GPUSpatialRegion } from './types/spatialAggregator.types';
export type { GPUSpatialRegionRange, GPURegionParticleIndices } from './spatial/structures/gpu/GPUSpatialRegions';
export type {
  ParticleSpatialGridOptions,
  ParticleSpatialGridDiagnostics,
  ParticleSpatialGridQueryOptions,
  ParticleSpatialGridVisitor,
} from './spatial/structures/ParticleSpatialGrid';

// Texture helper
export * as Textures from './rendering/textures';

export { CompensationMode } from './core/Renderer';
export type { RendererChildrenOptions } from './core/Renderer';

export { default as TextureAtlas } from './rendering/TextureAtlas';
export type { TextureAtlasOptions } from './rendering/TextureAtlas';
export { MaterialCopySampleMode } from './rendering/compositing/MaterialCopyRegistry';
export type { MaterialTarget, SurfacePatch } from './rendering/compositing/MaterialCopyRegistry';

export type { TaggedValue } from './types/taggedValue.types';
export { default as prepareTaggedSelection } from './core/tags/prepareTaggedSelection';
export type { TaggedSelection } from './core/tags/prepareTaggedSelection';
export { default as selectByTags } from './core/tags/selectByTags';
export { default as selectByTagsGPU } from './core/tags/selectByTagsGPU';
export { default as EventReceiver } from './events/EventReceiver';
export type {
  EventOrigin, EventScope, SimulationEvent, EventExecutionContext, GPUEventExecutionContext, EventReceiverOptions,
} from './events/EventReceiver';
export type { ModuleExecutionContext, ModuleGPUExecutionContext } from './core/Module';
export type { GPUEventBatch } from './events/gpu/EventBatch';

export type { ParticleInitializationContext, GPUParticleInitializationContext,
  ParticleInitializer, GPUParticleInitializer } from './core/Particle';

export { default as MaterialCopy, MaterialCopySource } from './modules/MaterialCopy';
export type { MaterialCopyOptions, MaterialCopyInput, GPUMaterialCopyInput } from './modules/MaterialCopy';

export type { MaterialChannels, GPUMaterialChannels, MaterialChannel, MaterialCompositeCallback,
  MaterialCompositeGPUCallback, MaterialCompositeContext, MaterialCompositeGPUContext }
  from './rendering/compositing/composite.utils';
