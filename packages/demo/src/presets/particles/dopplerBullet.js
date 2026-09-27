import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import {
  Audio as AudioModule,
  ColorOverLifetime,
  DistortionOverLifetime,
  Emitter,
  EmissionShape,
  EmissionSource,
  ForceOverLifetime,
  MeshRenderer,
  ParticleSystem,
  ScaleOverLifetime,
  SpriteRenderer,
  Textures,
  TrailMode,
  TrailRenderer,
  TrailTextureMode,
  TransformByNoise,
  VelocityOverLifetime,
} from '@rzmps/rzmps';
import warpNormal from '../../assets/images/warp_norm.jpg?url';
import { Easing } from 'eaz';

const BULLET_MODEL_URL = '/placeholders/low-poly-bullet.glb';
const BULLET_LOOP_SOUND_URL = '/placeholders/bullet-loop.ogg';
const GUNSHOT_SOUND_URL = '/placeholders/gunshot.ogg';

export default async function createDopplerBullet() {
  const textureLoader = new THREE.TextureLoader();
  const simpleSpriteTexture = textureLoader.load(Textures.Simple);
  const heatDistortion = textureLoader.load(warpNormal);
  const [bulletMesh, bulletLoopSound, gunshotSound] = await Promise.all([
    loadBulletMesh(),
    loadAudioOrPlaceholder(BULLET_LOOP_SOUND_URL, 1.5, createBulletLoopBuffer),
    loadAudioOrPlaceholder(GUNSHOT_SOUND_URL, 0.45, createGunshotBuffer),
  ]);

  const bulletSystem = new ParticleSystem({
    duration: 4.25,
    looping: true,
    maxParticles: 1,
    gravity: new THREE.Vector3(0, 0, 0),
    emitters: [
      new Emitter({
        source: pointEmissionShape(new THREE.Vector3(0, 1.25, 15)),
        bursts: [{ time: 0, count: 1 }],
        rate: 0,
        alignment: 1,
        initialValues: {
          lifetime: 4.2,
          velocity: new THREE.Vector3(0, 0, -7.25),
          scale: new THREE.Vector3(1, 1, 1),
          color: new THREE.Color('#d7c091'),
          alpha: 1,
          mass: 1,
        },
      }),
    ],
    modules: [
      new AudioModule({
        sound: bulletLoopSound,
        onSpawnSound: gunshotSound,
        loop: true,
        maxClips: 8,
        volume: 0.8,
        pitch: 1,
        lowPass: 14000,
        speedAffectsVolume: 0.12,
        depthAffectsVolume: 0.45,
        dopplerEffect: 3.25,
      }),
    ],
    renderers: [
      new MeshRenderer({
        mesh: bulletMesh,
        maxParticles: 1,
        castShadow: true,
        receiveShadow: true,
      }),
      new TrailRenderer({
        mode: TrailMode.Particle,
        ratio: 1,
        lifetime: 0.8,
        minimumVertexDistance: 0.1,
        dieWithParticles: false,
        width: 0.08,
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
  });

  bulletSystem.addSubSystem(createSmokeWake(), {
    inheritScale: 0,
    inheritLifetime: 0,
    inheritColor: 0,
    inheritAlpha: 0,
    inheritMass: 0,
    inheritVelocity: 0.45,
    ratio: 0.75,
  });

  bulletSystem.addSubSystem(createHeatWake(Textures.Simple, heatDistortion), {
    inheritScale: 0,
    inheritLifetime: 0,
    inheritColor: 0,
    inheritAlpha: 0,
    inheritMass: 0,
    inheritVelocity: 0.6,
    ratio: 1,
  });

  bulletSystem.addSubSystem(createMuzzleFlash(), {
    emitOnSpawn: true,
    inheritScale: 0,
    inheritLifetime: 0,
    inheritColor: 0,
    inheritAlpha: 0,
    inheritMass: 0,
    inheritVelocity: 0,
  });

  bulletSystem.addSubSystem(createSpawnShockwave(Textures.Simple, heatDistortion), {
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
createDopplerBullet.description = "Exaggerates continuous positional audio doppler on a fast bullet particle, with smoke, faint trails, spawn blast effects, and distortion wake subsystems.";

function createSmokeWake() {
  return new ParticleSystem({
    duration: 1.35,
    looping: true,
    gravity: new THREE.Vector3(0, 0.2, 0),
    emitters: [
      new Emitter({
        source: EmissionShape.Sphere(0.08, 8, 6),
        rate: 16,
        radialSpeed: 0.25,
        initialValues: {
          lifetime: [0.85, 1.35],
          scale: [
            new THREE.Vector3(0.25, 0.25, 0.25),
            new THREE.Vector3(0.5, 0.5, 0.5),
          ],
          velocity: [
            new THREE.Vector3(-0.08, 0.04, 0.65),
            new THREE.Vector3(0.08, 0.28, 1.1),
          ],
          color: [new THREE.Color('#7d8085'), new THREE.Color('#c1b9aa')],
          alpha: 0.22,
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
          const size = 0.55 + 1.7 * Easing.cubic.out(t);
          return new THREE.Vector3(size, size, size);
        },
      }),
      new ColorOverLifetime({
        color: new THREE.Color('#b7b0a5'),
        alpha: (time) => fadeInOut(time, 0.18, 0.65),
      }),
    ],
    renderers: [
      new SpriteRenderer(Textures.Simple, {
        material: 'lit',
        alphaMap: Textures.Simple,
        softParticleDistance: 1.2,
        materialOptions: {
          opacity: 0.55,
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
        rate: 12,
        radialSpeed: 0.08,
        initialValues: {
          lifetime: [0.45, 0.75],
          scale: [
            new THREE.Vector3(0.75, 0.75, 0.75),
            new THREE.Vector3(1.25, 1.25, 1.25),
          ],
          velocity: [
            new THREE.Vector3(-0.04, 0.02, 0.25),
            new THREE.Vector3(0.04, 0.16, 0.65),
          ],
          color: new THREE.Color('#ffffff'),
          alpha: 0.45,
          distortionStrength: 1,
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
          const size = 0.4 + 1.6 * Easing.cubic.out(t);
          return new THREE.Vector3(size, size, size);
        },
      }),
      new DistortionOverLifetime({
        distortionStrength: (time) => fadeInOut(time, 0.15, 0.55),
      }),
      new ColorOverLifetime({
        alpha: (time) => 0.55 * fadeInOut(time, 0.15, 0.55),
      }),
    ],
    renderers: [
      new SpriteRenderer(Textures.Default, {
        alphaMap,
        materialOptions: {
          opacity: 0.3,
          transmission: 1,
          distortionMap,
          distortionStrength: 6,
          depthWrite: false,
        },
      }),
    ],
  });
}

function createMuzzleFlash() {
  return new ParticleSystem({
    duration: 0.3,
    looping: true,
    emitters: [
      new Emitter({
        source: pointEmissionShape(),
        bursts: [{ time: 0, count: 10 }],
        rate: 0,
        radialSpeed: [0.5, 1.6],
        initialValues: {
          lifetime: [0.12, 0.24],
          scale: [
            new THREE.Vector3(0.35, 0.35, 0.35),
            new THREE.Vector3(1.25, 1.25, 1.25),
          ],
          velocity: [
            new THREE.Vector3(-0.55, -0.2, -0.15),
            new THREE.Vector3(0.55, 0.45, 1.0),
          ],
          color: [new THREE.Color('#fff7d2'), new THREE.Color('#ff8b3d')],
          alpha: 1,
        },
      }),
    ],
    modules: [
      new ScaleOverLifetime({
        scale: (time) => {
          const t = THREE.MathUtils.clamp(time, 0, 1);
          const size = 0.5 + 1.8 * Easing.cubic.out(t);
          return new THREE.Vector3(size, size, size);
        },
      }),
      new ColorOverLifetime({
        color: (time) => new THREE.Color().lerpColors(
          new THREE.Color('#fff6c4'),
          new THREE.Color('#ff5334'),
          THREE.MathUtils.clamp(time, 0, 1),
        ),
        alpha: (time) => 1 - Easing.cubic.in(THREE.MathUtils.clamp(time, 0, 1)),
      }),
    ],
    renderers: [
      new SpriteRenderer(Textures.Circle, {
        materialOptions: {
          opacity: 0.9,
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
        bursts: [{ time: 0, count: 8 }],
        rate: 0,
        radialSpeed: 2.5,
        initialValues: {
          lifetime: 0.5,
          scale: new THREE.Vector3(1.8, 1.8, 1.8),
          color: new THREE.Color('#ffffff'),
          alpha: 0.55,
          distortionStrength: 1,
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
          const size = 0.25 + 4.5 * Easing.cubic.out(t);
          return new THREE.Vector3(size, size, size);
        },
      }),
      new DistortionOverLifetime({
        distortionStrength: (time) => 1 - Easing.cubic.in(THREE.MathUtils.clamp(time, 0, 1)),
      }),
      new ColorOverLifetime({
        alpha: (time) => 0.8 * (1 - Easing.cubic.in(THREE.MathUtils.clamp(time, 0, 1))),
      }),
    ],
    renderers: [
      new SpriteRenderer(Textures.Default, {
        alphaMap,
        softParticleDistance: 1,
        materialOptions: {
          opacity: 0.45,
          transmission: 1,
          distortionMap,
          distortionStrength: 10,
          depthWrite: false,
        },
      }),
    ],
  });
}

async function loadBulletMesh() {
  try {
    const gltf = await new GLTFLoader().loadAsync(BULLET_MODEL_URL);
    const mesh = gltf.scene.getObjectByProperty('isMesh', true);
    if (mesh instanceof THREE.Mesh) {
      mesh.geometry.computeVertexNormals();
      mesh.material = mesh.material ?? bulletMaterial();
      return mesh;
    }
  } catch {
    // Placeholder path is expected to fail until real assets are added.
  }

  const geometry = new THREE.ConeGeometry(0.08, 0.5, 10, 1);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, 0, -0.18);

  return new THREE.Mesh(geometry, bulletMaterial());
}

function bulletMaterial() {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color('#d7c091'),
    metalness: 0.8,
    roughness: 0.34,
  });
}

async function loadAudioOrPlaceholder(url, duration, createFallback) {
  try {
    return await new THREE.AudioLoader().loadAsync(url);
  } catch {
    return createFallback(duration);
  }
}

function createBulletLoopBuffer(duration) {
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  const context = new AudioContextConstructor();
  const sampleRate = context.sampleRate || 44100;
  const buffer = context.createBuffer(1, Math.max(1, Math.floor(sampleRate * duration)), sampleRate);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < data.length; i += 1) {
    const t = i / sampleRate;
    const flutter = Math.sin(Math.PI * 2 * 17 * t) * 0.12;
    data[i] = (
      Math.sin(Math.PI * 2 * 110 * t)
      + Math.sin(Math.PI * 2 * 224 * t) * 0.45
      + flutter
    ) * 0.16;
  }

  context.close?.();
  return buffer;
}

function createGunshotBuffer(duration) {
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  const context = new AudioContextConstructor();
  const sampleRate = context.sampleRate || 44100;
  const buffer = context.createBuffer(1, Math.max(1, Math.floor(sampleRate * duration)), sampleRate);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < data.length; i += 1) {
    const t = i / sampleRate;
    const envelope = Math.exp(-t * 18);
    const crack = Math.sin(Math.PI * 2 * 180 * t) * 0.35;
    data[i] = ((Math.random() * 2 - 1) * 0.85 + crack) * envelope;
  }

  context.close?.();
  return buffer;
}

function pointEmissionShape(position = new THREE.Vector3()) {
  const shape = new EmissionShape({
    geometry: new THREE.SphereGeometry(0.001, 4, 2),
  });
  shape.position.copy(position);
  return shape;
}

function fadeInOut(time, fadeInEnd, fadeOutStart) {
  const t = THREE.MathUtils.clamp(time, 0, 1);
  const fadeIn = Easing.cubic.out(THREE.MathUtils.clamp(t / fadeInEnd, 0, 1));
  const fadeOut = 1 - Easing.cubic.in(THREE.MathUtils.clamp((t - fadeOutStart) / (1 - fadeOutStart), 0, 1));
  return fadeIn * fadeOut;
}
