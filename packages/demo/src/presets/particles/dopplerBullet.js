import * as THREE from 'three';
import {
  AudioRenderer,
  ColorOverLifetime,
  DistortionOverLifetime,
  Emitter,
  EmissionShape,
  EmissionSource,
  ForceOverLifetime,
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
import shockwaveNormal from '../../assets/images/shockwave_alt_norm.jpg?url';
import fireballSprite from '../../assets/images/fireball_tile_5x4_n20.png?url';
import smokeAlpha from '../../assets/images/smoke_alpha.jpg?url';
import bulletShootUrl from '../../assets/audio/bullet_shoot.mp3?url';
import bulletWhizzUrl from '../../assets/audio/bullet_whizz.wav?url';
import { Easing } from 'eaz';

export default async function createDopplerBullet() {
  const textureLoader = new THREE.TextureLoader();
  const simpleSpriteTexture = textureLoader.load(Textures.Simple);
  const shockwaveDistortion = textureLoader.load(shockwaveNormal);
  const [bulletMesh, bulletLoopSound, gunshotSound] = await Promise.all([
    Promise.resolve(createBulletMesh()),
    new THREE.AudioLoader().loadAsync(bulletWhizzUrl),
    new THREE.AudioLoader().loadAsync(bulletShootUrl),
  ]);

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
    emitters: [
      new Emitter({
        source: bulletEmissionCone(),
        rate: 0.9,
        radialSpeed: [0.1, 0.35],
        alignment: 1,
        initialValues: {
          lifetime: 1.9,
          velocity: [
            new THREE.Vector3(-0.38, -0.16, -31),
            new THREE.Vector3(0.38, 0.16, -36),
          ],
          scale: new THREE.Vector3(0.22, 0.22, 0.22),
          color: new THREE.Color('#d7c091'),
          alpha: 1,
          mass: 1,
        },
      }),
    ],
    renderers: [
      new AudioRenderer({
        sound: bulletLoopSound,
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
        castShadow: true,
        receiveShadow: true,
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
      new AudioRenderer({
        sound: bulletLoopSound,
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
    ],
  });

  bulletSystem.addSubSystem(createSmokeWake(), {
    inheritScale: 0,
    inheritLifetime: 0,
    inheritColor: 0,
    inheritAlpha: 0,
    inheritMass: 0,
    inheritVelocity: 0,
    ratio: 1,
  });

  bulletSystem.addSubSystem(createHeatWake(Textures.Simple, shockwaveDistortion), {
    inheritScale: 0,
    inheritLifetime: 0,
    inheritColor: 0,
    inheritAlpha: 0,
    inheritMass: 0,
    inheritVelocity: 0,
    ratio: 1,
  });

  bulletSystem.addSubSystem(createMuzzleFlash(fireballSprite), {
    emitOnSpawn: true,
    inheritScale: 0,
    inheritLifetime: 0,
    inheritColor: 0,
    inheritAlpha: 0,
    inheritMass: 0,
    inheritVelocity: 0,
  });

  bulletSystem.addSubSystem(createSpawnShockwave(Textures.Simple, shockwaveDistortion), {
    emitOnSpawn: true,
    inheritScale: 0,
    inheritLifetime: 0,
    inheritColor: 0,
    inheritAlpha: 0,
    inheritMass: 0,
    inheritVelocity: 0,
  });

  bulletSystem.name = 'Doppler Bullet';
  bulletSystem.position.set(0, 0, 0);

  return bulletSystem;
}

createDopplerBullet.author = "rzmay";
createDopplerBullet.description = "Doppler effect on a fast bullet particle, with smoke, faint trails, spawn blast effects, and distortion wake subsystems.";

function createSmokeWake() {
  return new ParticleSystem({
    duration: 1.1,
    looping: true,
    gravity: new THREE.Vector3(0, 0.2, 0),
    emitters: [
      new Emitter({
        source: EmissionShape.Sphere(0.08, 8, 6),
        rate: 0,
        rateOverDistance: 5,
        radialSpeed: 0.1,
        initialValues: {
          lifetime: [0.55, 0.95],
          scale: [
            new THREE.Vector3(0.18, 0.18, 0.18),
            new THREE.Vector3(0.34, 0.34, 0.34),
          ],
          velocity: [
            new THREE.Vector3(-0.18, 0.02, -0.25),
            new THREE.Vector3(0.18, 0.35, 0.25),
          ],
          color: [new THREE.Color('#9a9fa4'), new THREE.Color('#d8d0c0')],
          alpha: 0.1,
        },
      }),
    ],
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
          return new THREE.Vector3(size, size, size);
        },
      }),
      new ColorOverLifetime({
        color: new THREE.Color('#d0c8bc'),
        alpha: (time) => fadeInOut(time, 0.18, 0.65),
      }),
      new RotationOverLifetime({
        angularVelocity: [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0)],
      }),
    ],
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
  });
}

function createHeatWake(alphaMap, distortionMap) {
  return new ParticleSystem({
    duration: 0.7,
    looping: true,
    emitters: [
      new Emitter({
        source: EmissionShape.Sphere(0.04, 8, 6),
        rate: 24,
        radialSpeed: 0.18,
        initialValues: {
          lifetime: [0.5, 0.85],
          scale: [
            new THREE.Vector3(0.9, 0.9, 0.9),
            new THREE.Vector3(1.45, 1.45, 1.45),
          ],
          velocity: [
            new THREE.Vector3(-0.04, 0.02, 0.25),
            new THREE.Vector3(0.04, 0.16, 0.65),
          ],
          color: new THREE.Color('#ffffff'),
          distortionStrength: 1,
        },
      }),
    ],
    modules: [
      new ScaleOverLifetime({
        scale: (time) => {
          const t = THREE.MathUtils.clamp(time, 0, 1);
          const size = 0.45 + 1.75 * Easing.cubic.out(t);
          return new THREE.Vector3(size, size, size);
        },
      }),
      new DistortionOverLifetime({
        distortionStrength: (time) => fadeInOut(time, 0.15, 0.55),
      }),
      new ColorOverLifetime({
        alpha: (time) => 0.95 * fadeInOut(time, 0.12, 0.58),
      }),
    ],
    renderers: [
      new SpriteRenderer(Textures.Default, {
        billboard: false,
        alphaMap,
        materialOptions: {
          opacity: 0.62,
          transmission: 1,
          distortionMap,
          distortionStrength: 32,
          side: THREE.DoubleSide,
          depthWrite: false,
        },
      }),
    ],
  });
}

function createMuzzleFlash(texture) {
  return new ParticleSystem({
    duration: 0.45,
    looping: true,
    emitters: [
      new Emitter({
        source: pointEmissionShape(),
        bursts: [{ time: 0, count: 5 }],
        rate: 0,
        radialSpeed: [0.2, 0.8],
        initialValues: {
          lifetime: [0.22, 0.36],
          scale: [
            new THREE.Vector3(1.0, 1.0, 1.0),
            new THREE.Vector3(1.8, 1.8, 1.8),
          ],
          velocity: [
            new THREE.Vector3(-0.35, -0.12, -0.2),
            new THREE.Vector3(0.35, 0.32, 0.8),
          ],
          color: [new THREE.Color('#ffffff'), new THREE.Color('#ffd07a')],
          alpha: 1,
          rotation: [
            new THREE.Vector3(-Math.PI, 0, 0),
            new THREE.Vector3(Math.PI, 0, 0),
          ],
        },
      }),
    ],
    modules: [
      new ScaleOverLifetime({
        scale: (time) => {
          const t = THREE.MathUtils.clamp(time, 0, 1);
          const size = (0.32 + 1.45 * Easing.cubic.out(t)) * (1 - 0.35 * Easing.cubic.in(t));
          return new THREE.Vector3(size, size, size);
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
  });
}

function createSpawnShockwave(alphaMap, distortionMap) {
  return new ParticleSystem({
    duration: 0.65,
    looping: true,
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
          scale: new THREE.Vector3(2.0, 2.0, 2.0),
          color: new THREE.Color('#ffffff'),
          distortionStrength: 1,
        },
      }),
    ],
    modules: [
      new ScaleOverLifetime({
        scale: (time) => {
          const t = THREE.MathUtils.clamp(time, 0, 1);
          const size = 0.28 + 4.5 * Easing.cubic.out(t);
          return new THREE.Vector3(size, size, size);
        },
      }),
      new DistortionOverLifetime({
        distortionStrength: (time) => 1 - Easing.cubic.in(THREE.MathUtils.clamp(time, 0, 1)),
      }),
    ],
    renderers: [
      new SpriteRenderer(Textures.Default, {
        billboard: false,
        alphaMap,
        softParticleDistance: 1,
        materialOptions: {
          transmission: 1,
          distortionMap,
          distortionStrength: 64,
          side: THREE.DoubleSide,
          depthWrite: false,
        },
      }),
    ],
  });
}

function createBulletMesh() {
  return new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 24, 16),
    bulletMaterial(),
  );
}

function bulletMaterial() {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color('#c99a4c'),
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
