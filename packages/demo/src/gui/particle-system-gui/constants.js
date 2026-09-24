import * as THREE from 'three';
import {
    NoiseModule,
    VelocityOverLifetime,
    ForceOverLifetime,
    LimitVelocityOverLifetime,
    TransformByNoise,
    ColorOverLifetime,
    ColorBySpeed,
    ScaleOverLifetime,
    ScaleBySpeed,
    RotationOverLifetime,
    RotationBySpeed,
    ExternalForces,
    SpriteRenderer,
    MeshRenderer,
    LightRenderer,
    TrailRenderer,
    Collision,
} from '@rzmps/rzmps';

export const AUDIO_BUFFER_SOURCE_KEY = '__rzmpsAudioBufferSource';
export const RAW_CODE = Symbol('rawCode');
export const LOD_GUI_KEYS = new Set(['useUpdateLOD', 'updateLOD', 'countLOD', 'compensateSize']);

export const INITIAL_VALUE_DEFAULTS = {
    lifetime: () => 1,
    speed: () => 1,
    position: () => new THREE.Vector3(),
    rotation: () => new THREE.Vector3(),
    scale: () => new THREE.Vector3(1, 1, 1),
    velocity: () => new THREE.Vector3(),
    angularVelocity: () => new THREE.Vector3(),
    scalarVelocity: () => new THREE.Vector3(),
    acceleration: () => new THREE.Vector3(),
    angularAcceleration: () => new THREE.Vector3(),
    scalarAcceleration: () => new THREE.Vector3(),
    color: () => new THREE.Color(1, 1, 1),
    alpha: () => 1,
};

export const DEFAULT_MODULE_FACTORIES = {
    'Velocity Over Lifetime': () => new VelocityOverLifetime({ linear: new THREE.Vector3() }),
    'Force Over Lifetime': () => new ForceOverLifetime({ force: new THREE.Vector3() }),
    'Limit Velocity Over Lifetime': () => new LimitVelocityOverLifetime({ limit: new THREE.Vector3(10, 10, 10) }),
    'Transform By Noise': () => new TransformByNoise({ strength: new THREE.Vector3(1, 1, 1), frequency: 1 }),
    'Color Over Lifetime': () => new ColorOverLifetime({ color: new THREE.Color(1, 1, 1), alpha: 1 }),
    'Color By Speed': () => new ColorBySpeed({ color: new THREE.Color(1, 1, 1), speedRange: [0, 10] }),
    'Size Over Lifetime': () => new ScaleOverLifetime({ scale: new THREE.Vector3(1, 1, 1) }),
    'Size By Speed': () => new ScaleBySpeed({ scale: new THREE.Vector3(1, 1, 1), speedRange: [0, 10] }),
    'Rotation Over Lifetime': () => new RotationOverLifetime({ angularVelocity: new THREE.Vector3() }),
    'Rotation By Speed': () => new RotationBySpeed({ angularVelocity: new THREE.Vector3(), speedRange: [0, 10] }),
    'Noise Module': () => new NoiseModule('noise'),
    'External Forces': () => new ExternalForces({ forceFields: [], multiplier: 1 }),
    Collision: () => new Collision(),
};

export const DEFAULT_RENDERER_FACTORIES = {
    Sprite: () => new SpriteRenderer(),
    Mesh: () => new MeshRenderer(),
    Light: () => new LightRenderer(),
    Trail: () => new TrailRenderer(),
};
