import uvDebugScene from 'examples/scenes/uvDebug.js';
import * as THREE from 'three';
import {
  AudioRenderer,
  ColorOverLifetime,
  DecalRenderer,
  DistortionOverLifetime,
  Emitter,
  EmissionShape,
  EmissionSource,
  ForceOverLifetime,
  MaterialCopy,
  MaterialCopySampleMode,
  MaterialCopySource,
  MeshRenderer,
  ParticleSystem,
  RotationOverLifetime,
  ScaleOverLifetime,
  SpriteRenderer,
  Textures,
  TrailMode,
  TrailRenderer,
  TrailTextureMode,
  TransformByNoise,
} from '@rzmps/rzmps';
import shockwaveNormal from 'examples/assets/images/shockwave_alt_norm.jpg?url';
import fireballSprite from 'examples/assets/images/fireball_tile_5x4_n20.png?url';
import smokeAlpha from 'examples/assets/images/smoke_alpha.jpg?url';
import bulletShootUrl from 'examples/assets/audio/bullet_shoot.mp3?url';
import bulletWhizzUrl from 'examples/assets/audio/bullet_whizz.wav?url';
import { Easing } from 'eaz';
import holeAlbedo from 'examples/assets/images/bullet-hole/bullet-hole_albedo.png?url';
import holeNormal from 'examples/assets/images/bullet-hole/bullet-hole_normal.png?url';
import holeRoughness from 'examples/assets/images/bullet-hole/bullet-hole_roughness.png?url';
import cornellBoxScene from '../scenes/cornellBox';

export default async function dopplerBulletPreset() {
  const textureLoader = new THREE.TextureLoader();
  const simpleSpriteTexture = textureLoader.load(Textures.Simple);
  const shockwaveDistortion = textureLoader.load(shockwaveNormal);
  const [bulletMesh, bulletLoopSound, gunshotSound, holeMap, holeNormalMap, holeRoughnessMap] = await Promise.all([
    Promise.resolve(createBulletMesh()),
    new THREE.AudioLoader().loadAsync(bulletWhizzUrl),
    new THREE.AudioLoader().loadAsync(bulletShootUrl),
    textureLoader.loadAsync(holeAlbedo),
    textureLoader.loadAsync(holeNormal),
    textureLoader.loadAsync(holeRoughness),
  ]);

  // #region docs:renderers:7
  // Damage maps use projector UVs; the albedo alpha masks their combined lighting.
  holeMap.colorSpace = THREE.SRGBColorSpace;
  holeNormalMap.colorSpace = holeRoughnessMap.colorSpace = THREE.NoColorSpace;
  const holeMaterial = new THREE.MeshStandardMaterial({
    map: holeMap,
    normalMap: holeNormalMap,
    roughnessMap: holeRoughnessMap,
    roughness: 1,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
  });
  // #endregion docs:renderers:7

  // #region docs:system:1
  const bulletSystem = new ParticleSystem({
    duration: 5.5,
    looping: true,
    maxParticles: 8,
    useLiveCubemap: true,
    cubemapSettings: {
      fps: 8,
      resolutionScale: 0.5,
      intensity: 1.35,
    },
    gravity: new THREE.Vector3(0, 0, 0),
    // #region docs:emitters:1
    emitters: [
      new Emitter({
        source: bulletEmissionCone(),
        tags: ['projectile'],
        rate: 0.9,
        radialSpeed: [0.1, 0.35],
        alignment: 1,
        initialValues: {
          lifetime: 1.9,
          velocity: [
            new THREE.Vector3(-0.38, -0.16, -31),
            new THREE.Vector3(0.38, 0.16, -36),
          ],
          scale: 0.22,
          color: '#d7c091',
          alpha: 1,
          mass: 1,
        },
      }),
    ],
    // #endregion docs:emitters:1
    // #region docs:renderers:1
    renderers: [
      // Sweep the traveled segment: bullets keep flying through every marked surface.
      new DecalRenderer(holeMaterial, {
        direction: DecalRenderer.Intersect(),
        continuousRate: 60,
        onSpawn: false,
        emissionTags: ['bullet-hole'],
        rotation: [-Math.PI, Math.PI],
        hitSelection: DecalRenderer.All,
        // Surface color and normal detail remain tied to the hit, independently of projector UVs.
        materialComposite: (source, dest) => ({
          color: `${source.color} * clamp(${dest.color} * 4.0, 0.0, 1.0)`,
          opacity: `${source.opacity} * ${dest.opacity}`,
          normal: source.normal,
          roughness: dest.roughness,
          metalness: dest.metalness,
        }),
        materialCompositeGPU: (source, dest) => ({
          color: source.color.mul(dest.color.mul(4).clamp(0, 1)),
          opacity: source.opacity.mul(dest.opacity),
          normal: source.normal,
          roughness: dest.roughness,
          metalness: dest.metalness,
        }),
        size: 0.55,
        depth: 0.04,
        offset: 0.002,
        inheritScale: 0,
        inheritColor: 0,
        inheritAlpha: 0,
        lifetime: 24,
        maxDecals: 128,
        opacity: t => 1 - THREE.MathUtils.smoothstep(t, 0.8, 1),
      }),
      new AudioRenderer({
        sound: bulletLoopSound,
        tags: ['projectile'],
        onSpawnSound: gunshotSound,
        loop: true,
        maxClips: 8,
        volume: 3.5,
        pitch: [0.82, 1.24],
        lowPass: 14000,
        speedAffectsVolume: 0.12,
        depthAffectsVolume: 0.45,
        dopplerEffect: 2.4,
      }),
      new MeshRenderer({
        mesh: bulletMesh,
        maxParticles: 8,
      }),
      new TrailRenderer({
        mode: TrailMode.Particle,
        ratio: 1,
        lifetime: 0.28,
        minimumVertexDistance: 0.1,
        dieWithParticles: false,
        width: 0.055,
        widthOverTrail: (time) => 1 - Easing.cubic.in(THREE.MathUtils.clamp(time, 0, 1)),
        colorOverTrail: (time) => new THREE.Color().lerpColors(
          new THREE.Color('#f9e6ae'),
          new THREE.Color('#8391a5'),
          THREE.MathUtils.clamp(time, 0, 1),
        ),
        inheritParticleColor: true,
        textureMode: TrailTextureMode.Stretch,
        materialOptions: {
          map: simpleSpriteTexture,
          transparent: true,
          opacity: 0.22,
          depthWrite: false,
          roughness: 0.9,
        },
      }),
    ],
    // #endregion docs:renderers:1
  });
  // #endregion docs:system:1

  bulletSystem.addSubSystem(createSmokeWake(), {
    tags: ['projectile'],
    inheritScale: 0,
    inheritLifetime: 0,
    inheritColor: 0,
    inheritAlpha: 0,
    inheritMass: 0,
    inheritVelocity: 0,
    ratio: 1,
  });

  bulletSystem.addSubSystem(createHeatWake(Textures.Simple, shockwaveDistortion), {
    tags: ['projectile'],
    inheritScale: 0,
    inheritLifetime: 0,
    inheritColor: 0,
    inheritAlpha: 0,
    inheritMass: 0,
    inheritVelocity: 0,
    ratio: 1,
  });

  bulletSystem.addSubSystem(createMuzzleFlash(fireballSprite), {
    tags: ['projectile'],
    emitOnSpawn: true,
    inheritScale: 0,
    inheritLifetime: 0,
    inheritColor: 0,
    inheritAlpha: 0,
    inheritMass: 0,
    inheritVelocity: 0,
  });

  bulletSystem.addSubSystem(createSpawnShockwave(Textures.Simple, shockwaveDistortion), {
    tags: ['projectile'],
    emitOnSpawn: true,
    inheritScale: 0,
    inheritLifetime: 0,
    inheritColor: 0,
    inheritAlpha: 0,
    inheritMass: 0,
    inheritVelocity: 0,
  });

  // #region docs:system:6
  bulletSystem.addSubSystem(createImpactDust(), {
    tags: ['bullet-hole'],
    onEvent: {
      spawn: (_data, _source, context) => ({
        // Initial velocity is in simulation space; derive the puff's outward direction from the source frame.
        velocity: new THREE.Vector3(0, 1, 0).transformDirection(context.transform).multiplyScalar(0.65),
      }),
    },
    emitContinuous: false,
    inheritScale: 0,
    inheritLifetime: 0,
    inheritColor: 0,
    inheritAlpha: 0,
    inheritMass: 0,
    inheritVelocity: 0,
  });
  // #endregion docs:system:6

  bulletSystem.addEventListener('destroyed', () => {
    holeMaterial.dispose();
    holeMap.dispose();
    holeNormalMap.dispose();
    holeRoughnessMap.dispose();
  });

  bulletSystem.name = 'Doppler Bullet';
  bulletSystem.position.set(0, 0, 0);

  return bulletSystem;
}

function createSmokeWake() {
  // #region docs:system:2
  return new ParticleSystem({
    duration: 1.1,
    maxParticles: 256,
    looping: true,
    gravity: new THREE.Vector3(0, 0.2, 0),
    // #region docs:emitters:2
    emitters: [
      new Emitter({
        source: EmissionShape.Sphere(0.08, 8, 6),
        rate: 0,
        rateOverDistance: 5,
        radialSpeed: 0.1,
        initialValues: {
          lifetime: [0.55, 0.95],
          scale: [
            0.18,
            0.34,
          ],
          velocity: [
            new THREE.Vector3(-0.18, 0.02, -0.25),
            new THREE.Vector3(0.18, 0.35, 0.25),
          ],
          color: ['#9a9fa4', '#d8d0c0'],
          alpha: 0.1,
        },
      }),
    ],
    // #endregion docs:emitters:2
    // #region docs:modules:1
    modules: [
      new ForceOverLifetime({
        force: new THREE.Vector3(0, 0.12, 0),
      }),
      new TransformByNoise({
        strength: new THREE.Vector3(0.65, 0.2, 0.65),
        frequency: 1.6,
      }),
      new ScaleOverLifetime({
        scale: (time) => {
          const t = THREE.MathUtils.clamp(time, 0, 1);
          const size = 0.85 + 2.35 * Easing.cubic.out(t);
          return size;
        },
      }),
      new ColorOverLifetime({
        color: '#d0c8bc',
        alpha: (time) => fadeInOut(time, 0.18, 0.65),
      }),
      new RotationOverLifetime({
        angularVelocity: [-1, 1],
      }),
    ],
    // #endregion docs:modules:1
    // #region docs:renderers:2
    renderers: [
      new SpriteRenderer(Textures.Default, {
        material: 'lit',
        alphaMap: smokeAlpha,
        softParticleDistance: 1.2,
        materialOptions: {
          opacity: 0.62,
          roughness: 0.8,
          depthWrite: false,
        },
      }),
    ],
    // #endregion docs:renderers:2
  });
  // #endregion docs:system:2
}

function createHeatWake(alphaMap, distortionMap) {
  // #region docs:system:3
  return new ParticleSystem({
    duration: 0.7,
    maxParticles: 128,
    looping: true,
    // #region docs:emitters:3
    emitters: [
      new Emitter({
        source: EmissionShape.Sphere(0.04, 8, 6),
        rate: 24,
        radialSpeed: 0.18,
        initialValues: {
          lifetime: [0.5, 0.85],
          scale: [
            0.9,
            1.45,
          ],
          velocity: [
            new THREE.Vector3(-0.04, 0.02, 0.25),
            new THREE.Vector3(0.04, 0.16, 0.65),
          ],
          color: '#ffffff',
        },
      }),
    ],
    // #endregion docs:emitters:3
    // #region docs:modules:2
    modules: [
      new ScaleOverLifetime({
        scale: (time) => {
          const t = THREE.MathUtils.clamp(time, 0, 1);
          const size = 0.45 + 1.75 * Easing.cubic.out(t);
          return size;
        },
      }),
      new DistortionOverLifetime({
        distortionStrength: (time) => fadeInOut(time, 0.15, 0.55),
      }),
      new ColorOverLifetime({
        alpha: (time) => 0.95 * fadeInOut(time, 0.12, 0.58),
      }),
    ],
    // #endregion docs:modules:2
    // #region docs:renderers:3
    renderers: [
      new SpriteRenderer(Textures.Default, {
        billboard: false,
        alphaMap,
        materialOptions: {
          opacity: 0.62,
          transmission: 1,
          distortionMap,
          distortionStrength: 0.1,
          side: THREE.DoubleSide,
          depthWrite: false,
        },
      }),
    ],
    // #endregion docs:renderers:3
  });
  // #endregion docs:system:3
}

function createMuzzleFlash(texture) {
  // #region docs:system:4
  return new ParticleSystem({
    duration: 0.45,
    maxParticles: 64,
    looping: true,
    // #region docs:emitters:4
    emitters: [
      new Emitter({
        source: pointEmissionShape(),
        bursts: [{ time: 0, count: 5 }],
        rate: 0,
        radialSpeed: [0.2, 0.8],
        initialValues: {
          lifetime: [0.22, 0.36],
          scale: [
            1.0,
            1.8,
          ],
          velocity: [
            new THREE.Vector3(-0.35, -0.12, -0.2),
            new THREE.Vector3(0.35, 0.32, 0.8),
          ],
          color: ['#ffffff', '#ffd07a'],
          alpha: 1,
          rotation: [-Math.PI, Math.PI],
        },
      }),
    ],
    // #endregion docs:emitters:4
    // #region docs:modules:3
    modules: [
      new ScaleOverLifetime({
        scale: (time) => {
          const t = THREE.MathUtils.clamp(time, 0, 1);
          const size = (0.32 + 1.45 * Easing.cubic.out(t)) * (1 - 0.35 * Easing.cubic.in(t));
          return size;
        },
      }),
      new ColorOverLifetime({
        color: (time) => new THREE.Color().lerpColors(
          new THREE.Color('#fff8d7'),
          new THREE.Color('#ff9f45'),
          THREE.MathUtils.clamp(time, 0, 1),
        ),
        alpha: (time) => 1 - Easing.cubic.in(THREE.MathUtils.clamp(time, 0, 1)),
      }),
    ],
    // #endregion docs:modules:3
    // #region docs:renderers:4
    renderers: [
      new SpriteRenderer(texture, {
        gridSize: { x: 5, y: 4 },
        frames: 20,
        fps: 36,
        softParticleDistance: 1,
        materialOptions: {
          opacity: 0.82,
          depthWrite: false,
        },
      }),
    ],
    // #endregion docs:renderers:4
  });
  // #endregion docs:system:4
}

function createSpawnShockwave(alphaMap, distortionMap) {
  // #region docs:system:5
  return new ParticleSystem({
    duration: 0.65,
    maxParticles: 64,
    looping: true,
    // #region docs:emitters:5
    emitters: [
      new Emitter({
        source: new EmissionShape({
          geometry: new THREE.SphereGeometry(0.1, 16, 8),
          source: EmissionSource.Surface,
        }),
        bursts: [{ time: 0, count: 10 }],
        rate: 0,
        radialSpeed: 2.6,
        initialValues: {
          lifetime: 0.55,
          scale: 2.0,
          color: '#ffffff',
        },
      }),
    ],
    // #endregion docs:emitters:5
    // #region docs:modules:4
    modules: [
      new ScaleOverLifetime({
        scale: (time) => {
          const t = THREE.MathUtils.clamp(time, 0, 1);
          const size = 0.28 + 4.5 * Easing.cubic.out(t);
          return size;
        },
      }),
      new DistortionOverLifetime({
        distortionStrength: (time) => 1 - Easing.cubic.in(THREE.MathUtils.clamp(time, 0, 1)),
      }),
    ],
    // #endregion docs:modules:4
    // #region docs:renderers:5
    renderers: [
      new SpriteRenderer(Textures.Default, {
        billboard: false,
        alphaMap,
        softParticleDistance: 1,
        materialOptions: {
          transmission: 1,
          distortionMap,
          distortionStrength: 2,
          side: THREE.DoubleSide,
          depthWrite: false,
        },
      }),
    ],
    // #endregion docs:renderers:5
  });
  // #endregion docs:system:5
}

function createImpactDust() {
  // #region docs:system:7
  const dust = new ParticleSystem({
    duration: 0.12,
    looping: false,
    maxParticles: 128,
    gravityModifier: -0.02,
    // #region docs:emitters:6
    emitters: new Emitter({
      source: EmissionShape.Sphere(0.025),
      rate: 0,
      bursts: [{ time: 0, count: [5, 8] }],
      radialSpeed: [0.1, 0.25],
      initialValues: {
        position: new THREE.Vector3(0, 0.045, 0),
        lifetime: [0.4, 0.65],
        scale: [0.28, 0.44],
        alpha: [0.3, 0.45],
      },
    }),
    // #endregion docs:emitters:6
    // #region docs:modules:5
    modules: [
      new MaterialCopy({ source: MaterialCopySource.Source, sampleMode: MaterialCopySampleMode.Color }),
      new ScaleOverLifetime({ scale: t => 0.7 + 1.4 * t }),
      new ColorOverLifetime({ alpha: t => 1 - t }),
      new RotationOverLifetime({ angularVelocity: [-0.7, 0.7] }),
    ],
    // #endregion docs:modules:5
    // #region docs:renderers:6
    renderers: new SpriteRenderer(Textures.Default, {
      material: 'lit',
      alphaMap: smokeAlpha,
      // A broad depth fade erased these small puffs while they were still close to the impact surface.
      softParticleDistance: 0.025,
      // Smoke takes only the sampled surface color; its mask, opacity and lighting remain its own.
      materialComposite: source => ({ color: source.color }),
      materialCompositeGPU: source => ({ color: source.color }),
      materialOptions: { roughness: 1, depthWrite: false },
    }),
    // #endregion docs:renderers:6
  });
  dust.name = 'Bullet Impact Dust';
  return dust;
  // #endregion docs:system:7
}

function createBulletMesh() {
  return new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 24, 16),
    bulletMaterial(),
  );
}

function bulletMaterial() {
  return new THREE.MeshStandardMaterial({
    color: '#c99a4c',
    metalness: 1,
    roughness: 0.22,
  });
}

function pointEmissionShape(position = new THREE.Vector3()) {
  const shape = new EmissionShape({
    geometry: new THREE.SphereGeometry(0.001, 4, 2),
  });
  shape.position.copy(position);
  return shape;
}

function bulletEmissionCone() {
  const shape = new EmissionShape({
    geometry: new THREE.ConeGeometry(0.45, 2.2, 24, 1),
    source: EmissionSource.Surface,
  });

  shape.position.set(0, 0.5, 34);
  shape.rotation.x = -Math.PI / 2;

  return shape;
}

function fadeInOut(time, fadeInEnd, fadeOutStart) {
  const t = THREE.MathUtils.clamp(time, 0, 1);
  const fadeIn = Easing.cubic.out(THREE.MathUtils.clamp(t / fadeInEnd, 0, 1));
  const fadeOut = 1 - Easing.cubic.in(THREE.MathUtils.clamp((t - fadeOutStart) / (1 - fadeOutStart), 0, 1));
  return fadeIn * fadeOut;
}

/** @type {import("../types").ExampleMetadata} */
dopplerBulletPreset.metadata = {
  author: "rzmay",
  "id": "dopplerBullet",
  "title": "Doppler Bullet",
  "description":
    "A fast, piercing bullet leaves surface-blended bullet holes, with Doppler audio, smoke, trails, and distortion.",
  "tags": [
    "dopplerBullet", "bullet", "projectile", "piercing", "decals", "materials", "compositing",
    "sources", "events", "dust", "smoke", "audio", "doppler", "trails", "distortion"
  ],
  "category": "effects",
  previewSettings: {
    scene: cornellBoxScene,
    cameraPosition: [4, 3, 4],
    cameraTarget: [0, 0.5, -4],
    warmup: 240,
  },
};
