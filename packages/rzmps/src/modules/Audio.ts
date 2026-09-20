import * as THREE from 'three';
import Module, { type ModuleOptions } from '../Module';
import Particle from '../Particle';
import ParticleSystem from '../ParticleSystem';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';
import particleRatio from '../helpers/particleRatio';
import type { StrictMultiple } from '../types/Multiple';
import acceptMultiple from '../helpers/acceptMultiple';
import { CollisionHit } from '../interfaces/ICollisionBackend';

const AUDIO_LISTENER_KEY = "__rzmps_audioListener";

export interface AudioOptions extends Partial<ModuleOptions> {
  listener: THREE.AudioListener;

  sound: StrictMultiple<AudioBuffer>;
  onCollisionSound: StrictMultiple<AudioBuffer>;
  onSpawnSound: StrictMultiple<AudioBuffer>;
  onDeathSound: StrictMultiple<AudioBuffer>;

  shouldPlay: (particle: Particle) => boolean;

  loop: boolean;
  ratio: number;
  collisionRatio: number;

  pitch: DynamicValue<number>;
  volume: DynamicValue<number>;

  sizeAffectsPitch: number;
  sizeAffectsVolume: number;

  alphaAffectsPitch: number;
  alphaAffectsVolume: number;

  speedAffectsPitch: number;
  speedAffectsVolume: number;

  impulseAffectsPitch: number;
  impulseAffectsVolume: number;
  impulseThreshhold: number;
}

interface ParticleAudio {
  audio: THREE.PositionalAudio;
  buffer: AudioBuffer;
}

class Audio extends Module {
  listener?: THREE.AudioListener;

  sound?: AudioBuffer[];
  onCollisionSound?: AudioBuffer[];
  onSpawnSound?: AudioBuffer[];
  onDeathSound?: AudioBuffer[];

  shouldPlay: (particle: Particle) => boolean = () => true;

  loop: boolean = true;
  ratio: number;
  collisionRatio: number;

  pitch: DynamicValue<number>;
  volume: DynamicValue<number>;

  sizeAffectsPitch: number;
  sizeAffectsVolume: number;
  alphaAffectsPitch: number;
  alphaAffectsVolume: number;
  speedAffectsPitch: number;
  speedAffectsVolume: number;
  impulseAffectsPitch: number;
  impulseAffectsVolume: number;
  impulseThreshhold: number;

  private _system?: ParticleSystem;
  private _particleAudio = new Map<string, ParticleAudio>();
  private _eventAudio = new Set<THREE.PositionalAudio>();
  private _setupCallbacks: boolean = false;

  constructor(options: Partial<AudioOptions> = {}) {
    super((particle) => this._updateParticle(particle), options);

    this.listener = options.listener;

    this.sound = options.sound
      ? acceptMultiple(options.sound)
      : undefined;

    this.onCollisionSound = options.onCollisionSound
      ? acceptMultiple(options.onCollisionSound)
      : undefined;

    this.onSpawnSound = options.onSpawnSound
      ? acceptMultiple(options.onSpawnSound)
      : undefined;

    this.onDeathSound = options.onDeathSound
      ? acceptMultiple(options.onDeathSound)
      : undefined;

    this.shouldPlay = options.shouldPlay ?? this.shouldPlay;

    this.loop = options.loop ?? this.loop;
    this.ratio = THREE.MathUtils.clamp(options.ratio ?? 1, 0, 1);
    this.collisionRatio = THREE.MathUtils.clamp(options.collisionRatio ?? this.ratio, 0, 1);

    this.pitch = options.pitch ?? 1;
    this.volume = options.volume ?? 1;

    this.sizeAffectsPitch = Math.max(0, options.sizeAffectsPitch ?? 0);
    this.sizeAffectsVolume = Math.max(0, options.sizeAffectsVolume ?? 0);

    this.alphaAffectsPitch = Math.max(0, options.alphaAffectsPitch ?? 0);
    this.alphaAffectsVolume = Math.max(0, options.alphaAffectsVolume ?? 0);

    this.speedAffectsPitch = Math.max(0, options.speedAffectsPitch ?? 0);
    this.speedAffectsVolume = Math.max(0, options.speedAffectsVolume ?? 0);

    this.impulseAffectsPitch = Math.max(0, options.impulseAffectsPitch ?? 0);
    this.impulseAffectsVolume = Math.max(0, options.impulseAffectsVolume ?? 0);
    this.impulseThreshhold = Math.max(0, options.impulseThreshhold ?? 0);
  }

  public prepare(system: ParticleSystem): void {
    this._system = system;

    if (!this._setupCallbacks) {
      system.onCollision(
        (particle, collisionHit) => {
          if (collisionHit.impulse.length() <= this.impulseThreshhold) return;
          this._handleEvent(particle, this.onCollisionSound, collisionHit);
        },
      );

      system.onDeath(
        (particle) => this._handleEvent(particle, this.onDeathSound),
      );

      system.onSpawn(
        (particle) => this._handleEvent(particle, this.onSpawnSound),
      )

      this._setupCallbacks = true;
    }

    if (!this.listener) {
      // Try to get listener from cache
      if (system.scene) this.listener = system.scene.userData[AUDIO_LISTENER_KEY];

      // Try to get listener from camera
      if (system.sceneCamera) {
        system.sceneCamera.traverse((object) => {
          if (!this.listener && object instanceof THREE.AudioListener) {
            this.listener = object;
          }
        });

        // Add to camera if its not there
        if (!this.listener) {
          this.listener = new THREE.AudioListener();
          system.sceneCamera.add(this.listener);
        }
      }

      // If we found a listener, add it to the scene cache
      if (this.listener && system.scene) system.scene.userData[AUDIO_LISTENER_KEY] = this.listener;
    }

    this._cleanParticleAudio(system.particles);
  }

  private _updateParticle(particle: Particle): void {
    if (!this.listener || !this.sound || !this._system) return;

    if (!particleRatio(particle, this.ratio) || !this.shouldPlay(particle)) {
      this._removeParticleAudio(particle.id);
      return;
    }

    let state = this._particleAudio.get(particle.id);

    if (!state) {
      const audio = new THREE.PositionalAudio(this.listener);
      const sound = this.sound[Math.floor(Math.random() * this.sound.length)];

      audio.setBuffer(sound);
      audio.setLoop(this.loop);

      this._system.add(audio);

      state = {
        audio,
        buffer: sound,
      };

      this._particleAudio.set(particle.id, state);

      audio.play();
    }

    state.audio.position.copy(particle.position);
    state.audio.setPlaybackRate(this._getPitch(particle));
    state.audio.setVolume(this._getVolume(particle));
  }

  private _handleEvent(particle: Particle, audio?: AudioBuffer[], collisionHit?: CollisionHit): void {
    if (
      !audio
      || audio?.length === 0
      || !particleRatio(particle, this.collisionRatio)
      || !this.shouldPlay(particle)
    ) {
      return;
    }

    this._playOneShot(
      audio[Math.floor(Math.random() * audio.length)],
      particle,
      collisionHit,
    );
  }

  private _playOneShot(clip: AudioBuffer, particle: Particle, collisionHit?: CollisionHit) {
    if (!this.listener || !this._system) return;

    const audio = new THREE.PositionalAudio(this.listener);

    audio.setBuffer(clip);
    audio.setLoop(false);

    audio.position.copy(particle.position);
    audio.setPlaybackRate(this._getPitch(particle, collisionHit));
    audio.setVolume(this._getVolume(particle, collisionHit));

    this._system.add(audio);
    this._eventAudio.add(audio);

    audio.play();

    /*
     * THREE.Audio creates a new AudioBufferSourceNode when play() is
     * called. Clean the temporary source up once that playback ends.
     */
    if (audio.source) {
      audio.source.addEventListener('ended', () => {
        this._eventAudio.delete(audio);
        audio.removeFromParent();
      });
    }
  }

  private _getPitch(particle: Particle, collisionHit?: CollisionHit): number {
    const base = evaluateDynamicNumber(
      this.pitch,
      particle.time,
      particle.id,
    );

    return Math.max(
      0,
      base
        * this._getEffect(particle.scale.length(), this.sizeAffectsPitch)
        * this._getEffect(particle.alpha, this.alphaAffectsPitch)
        * this._getEffect(particle.velocity.length() * particle.speed, this.speedAffectsPitch)
        * this._getEffect(collisionHit?.impulse.length() ?? 1, this.impulseAffectsPitch),
    );
  }

  private _getVolume(particle: Particle, collisionHit?: CollisionHit): number {
    const base = evaluateDynamicNumber(
      this.volume,
      particle.time,
      particle.id,
    );

    return Math.max(
      0,
      base
        * this._getEffect(particle.scale.length(), this.sizeAffectsVolume)
        * this._getEffect(particle.alpha, this.alphaAffectsVolume)
        * this._getEffect(particle.velocity.length(), this.speedAffectsVolume)
        * this._getEffect(collisionHit?.impulse.length() ?? 1, this.impulseAffectsVolume),
    );
  }

  // eslint-disable-next-line class-methods-use-this
  private _getEffect(value: number, effect: number): number {
    return Math.pow(Math.max(0, value), effect);
  }

  private _cleanParticleAudio(particles: Particle[]): void {
    const activeParticles = new Set(
      particles
        .filter((particle) => particleRatio(particle, this.ratio))
        .map((particle) => particle.id),
    );

    this._particleAudio.forEach((_state, id) => {
      if (!activeParticles.has(id)) {
        this._removeParticleAudio(id);
      }
    });
  }

  private _removeParticleAudio(id: string): void {
    const state = this._particleAudio.get(id);
    if (!state) return;

    if (state.audio.isPlaying) {
      state.audio.stop();
    }

    state.audio.removeFromParent();
    this._particleAudio.delete(id);
  }

  public cleanup(): void {
    this._particleAudio.forEach((_state, id) => {
      this._removeParticleAudio(id);
    });

    this._eventAudio.forEach((audio) => {
      if (audio.isPlaying) {
        audio.stop();
      }

      audio.removeFromParent();
    });

    this._eventAudio.clear();
  }
}

export default Audio;
