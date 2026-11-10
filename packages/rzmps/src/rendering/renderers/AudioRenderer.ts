import * as THREE from 'three';
import Renderer, { type RendererOptions } from '../../core/Renderer';
import Particle from '../../core/Particle';
import type { SubSystemSource } from '../../emission/EmissionSource';
import { eventNames, parameterEventHandler, subscribeParameterEvent, transformEventParameters,
  type ParameterEventSubscription, type ParameterEventSubscriptions } from '../../events/events.utils';
import rendererEventParticle from '../rendererEventParticle';
import tagsIntersect from '../../core/tags/tagsIntersect';
import ParticleSystem from '../../core/ParticleSystem';
import type { DynamicValue } from '../../values/dynamicValue.types';
import evaluateDynamicNumber from '../../values/evaluateDynamicNumber';
import particleRatio from '../../core/particleRatio';
import type { StrictMultiple } from '../../types/multiple.types';
import acceptMultiple from '../../utils/acceptMultiple';
import { CollisionHit } from '../../collision/collision.types';
import type { SimulationEvent } from '../../events/EventReceiver';
import type { GPUParticleBufferState, GPUParticleRenderBufferState } from '../../simulation/gpu/Particle';
import type { GPUParticleReadbackField } from '../../simulation/gpu/SelectiveReadback';

const AUDIO_LISTENER_KEY = '__rzmps_audioListener';

/** Evaluated inputs for one event cue. Position is in the renderer system's simulation space. */
export interface AudioParameters {
  sound?: AudioBuffer;
  position: THREE.Vector3;
  pitch: number;
  volume: number;
  highPass: number;
  lowPass: number;
}

export interface AudioRendererOptions extends Partial<RendererOptions> {
  /** Existing AudioListener; omission discovers or attaches a listener to the active camera. */
  listener: THREE.AudioListener;

  /** Decoded buffers for continuous particle audio; playback chooses among supplied buffers. */
  sound: StrictMultiple<AudioBuffer>;
  /** Decoded buffers played on eligible collision events. */
  onCollisionSound: StrictMultiple<AudioBuffer>;
  /** Decoded buffers played on eligible particle births. */
  onSpawnSound: StrictMultiple<AudioBuffer>;
  /** Decoded buffers played on eligible particle deaths. */
  onDeathSound: StrictMultiple<AudioBuffer>;

  onSpawn: ParameterEventSubscription<AudioParameters>;
  onDeath: ParameterEventSubscription<AudioParameters>;
  onCollision: ParameterEventSubscription<AudioParameters, CollisionHit>;
  onEvent?: ParameterEventSubscriptions<AudioParameters>;

  /** Additional predicate selecting particles for sound playback. */
  shouldPlay: (particle: Particle) => boolean;

  /** Loops continuous sound clips; event cues use their own lifecycle playback behavior. */
  loop: boolean;
  /** Maximum simultaneously managed positional clips; limits audio resource costs. */
  maxClips: number;
  /** Fraction of eligible particles selected for continuous audio. */
  ratio: number;
  /** Fraction of eligible collision events selected for contact audio. */
  collisionRatio: number;

  /** Playback rate multiplier evaluated with normalized particle age. */
  pitch: DynamicValue<number>;
  /** Gain multiplier evaluated with normalized particle age. */
  volume: DynamicValue<number>;
  /** High-pass cutoff in Hz, evaluated with normalized particle age. */
  highPass: DynamicValue<number>;
  /** Low-pass cutoff in Hz, evaluated with normalized particle age. */
  lowPass: DynamicValue<number>;

  sizeAffectsPitch: number;
  sizeAffectsVolume: number;
  sizeAffectsHighPass: number;
  sizeAffectsLowPass: number;

  alphaAffectsPitch: number;
  alphaAffectsVolume: number;
  alphaAffectsHighPass: number;
  alphaAffectsLowPass: number;

  speedAffectsPitch: number;
  speedAffectsVolume: number;
  speedAffectsHighPass: number;
  speedAffectsLowPass: number;

  depthAffectsPitch: number;
  depthAffectsVolume: number;
  depthAffectsHighPass: number;
  depthAffectsLowPass: number;

  impulseAffectsPitch: number;
  impulseAffectsVolume: number;
  impulseAffectsHighPass: number;
  impulseAffectsLowPass: number;
  /** Minimum collision impulse for contact playback. */
  impulseThreshold: number;

  /** Strength of relative-velocity pitch shifting; zero disables the Doppler response. */
  dopplerEffect: number;
  gpuInterpolationRate: number;
}

interface ParticleAudio {
  audio: THREE.PositionalAudio;
  buffer: AudioBuffer;
  filters: AudioFilters;
  targetPosition?: THREE.Vector3;
  velocity?: THREE.Vector3;
  speed?: number;
}

interface AudioFilters {
  highPass?: BiquadFilterNode;
  lowPass?: BiquadFilterNode;
}

/** Positional particle audio and lifecycle cues; requires audio playback permission and scene camera context. */
export default class AudioRenderer extends Renderer {
  protected get groupingRatio(): number { return 1; }
  listener?: THREE.AudioListener;

  sound?: AudioBuffer[];
  onCollisionSound?: AudioBuffer[];
  onSpawnSound?: AudioBuffer[];
  onDeathSound?: AudioBuffer[];

  onSpawn: ParameterEventSubscription<AudioParameters> = true;
  onDeath: ParameterEventSubscription<AudioParameters> = true;
  onCollision: ParameterEventSubscription<AudioParameters, CollisionHit> = true;
  private _parameterEventHandlers: ParameterEventSubscriptions<AudioParameters> = [];

  shouldPlay: (particle: Particle) => boolean = () => true;

  loop: boolean = true;
  maxClips: number;

  collisionRatio: number;

  pitch: DynamicValue<number>;
  volume: DynamicValue<number>;
  highPass: DynamicValue<number>;
  lowPass: DynamicValue<number>;

  sizeAffectsPitch: number;
  sizeAffectsVolume: number;
  sizeAffectsHighPass: number;
  sizeAffectsLowPass: number;

  alphaAffectsPitch: number;
  alphaAffectsVolume: number;
  alphaAffectsHighPass: number;
  alphaAffectsLowPass: number;

  speedAffectsPitch: number;
  speedAffectsVolume: number;
  speedAffectsHighPass: number;
  speedAffectsLowPass: number;

  depthAffectsPitch: number;
  depthAffectsVolume: number;
  depthAffectsHighPass: number;
  depthAffectsLowPass: number;

  dopplerEffect: number;
  gpuInterpolationRate: number;

  impulseAffectsPitch: number;
  impulseAffectsVolume: number;
  impulseAffectsHighPass: number;
  impulseAffectsLowPass: number;
  impulseThreshold: number;

  private _system?: ParticleSystem;

  private _particleAudio = new Map<string, ParticleAudio>();
  private _eventAudio = new Set<THREE.PositionalAudio>();
  private _cameraPosition = new THREE.Vector3();
  private _cameraDepthRange: [number, number] = [0, 100];
  private _relativePositions = new Map<string, THREE.Vector3>();
  private _relativePosition = new THREE.Vector3();
  private readonly _hasCustomShouldPlay: boolean;

  // Deltatime stored for doppler effect calculation
  private _deltaTime = 0;

  constructor(options: Partial<AudioRendererOptions> = {}) {
    super(options);
    this._parameterEventHandlers = options.onEvent ?? [];
    this.events = [...new Set([
      ...this.events, ...eventNames(this._parameterEventHandlers),
    ])];
    this.onSpawn = options.onSpawn ?? true;
    this.onDeath = options.onDeath ?? true;
    this.onCollision = options.onCollision ?? true;

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

    this._hasCustomShouldPlay = options.shouldPlay !== undefined;
    this.shouldPlay = options.shouldPlay ?? this.shouldPlay;

    this.loop = options.loop ?? this.loop;
    this.maxClips = Math.max(0, Math.floor(options.maxClips ?? 256));
    this.ratio = THREE.MathUtils.clamp(options.ratio ?? 1, 0, 1);
    this.collisionRatio = THREE.MathUtils.clamp(options.collisionRatio ?? this.ratio, 0, 1);

    this.pitch = options.pitch ?? 1;
    this.volume = options.volume ?? 1;
    this.highPass = options.highPass ?? 0;
    this.lowPass = options.lowPass ?? 0;

    this.sizeAffectsPitch = Math.max(0, options.sizeAffectsPitch ?? 0);
    this.sizeAffectsVolume = Math.max(0, options.sizeAffectsVolume ?? 0);
    this.sizeAffectsHighPass = Math.max(0, options.sizeAffectsHighPass ?? 0);
    this.sizeAffectsLowPass = Math.max(0, options.sizeAffectsLowPass ?? 0);

    this.alphaAffectsPitch = Math.max(0, options.alphaAffectsPitch ?? 0);
    this.alphaAffectsVolume = Math.max(0, options.alphaAffectsVolume ?? 0);
    this.alphaAffectsHighPass = Math.max(0, options.alphaAffectsHighPass ?? 0);
    this.alphaAffectsLowPass = Math.max(0, options.alphaAffectsLowPass ?? 0);

    this.speedAffectsPitch = Math.max(0, options.speedAffectsPitch ?? 0);
    this.speedAffectsVolume = Math.max(0, options.speedAffectsVolume ?? 0);
    this.speedAffectsHighPass = Math.max(0, options.speedAffectsHighPass ?? 0);
    this.speedAffectsLowPass = Math.max(0, options.speedAffectsLowPass ?? 0);

    this.depthAffectsPitch = Math.max(0, options.depthAffectsPitch ?? 0);
    this.depthAffectsVolume = Math.max(0, options.depthAffectsVolume ?? 0);
    this.depthAffectsHighPass = Math.max(0, options.depthAffectsHighPass ?? 0);
    this.depthAffectsLowPass = Math.max(0, options.depthAffectsLowPass ?? 0);

    this.impulseAffectsPitch = Math.max(0, options.impulseAffectsPitch ?? 0);
    this.impulseAffectsVolume = Math.max(0, options.impulseAffectsVolume ?? 0);
    this.impulseAffectsHighPass = Math.max(0, options.impulseAffectsHighPass ?? 0);
    this.impulseAffectsLowPass = Math.max(0, options.impulseAffectsLowPass ?? 0);
    this.impulseThreshold = Math.max(0, options.impulseThreshold ?? 0);

    this.dopplerEffect = Math.max(0, options.dopplerEffect ?? 0);
    this.gpuInterpolationRate = Math.max(0, options.gpuInterpolationRate ?? 20);
  }

  onEvent(name: 'collision', handler: ParameterEventSubscription<AudioParameters, CollisionHit>): this;
  onEvent(name: string, handler?: ParameterEventSubscription<AudioParameters>): this;
  onEvent(name: string, handler: ParameterEventSubscription<AudioParameters>
    | ParameterEventSubscription<AudioParameters, CollisionHit> = true): this {
    this._parameterEventHandlers = subscribeParameterEvent(this._parameterEventHandlers, name,
      handler as ParameterEventSubscription<AudioParameters>);
    this.events = [...new Set([...this.events, name])];
    return this;
  }

  get parameterEvents(): ParameterEventSubscriptions<AudioParameters> { return this._parameterEventHandlers; }

  override get selectedEventNames(): readonly string[] {
    return [...new Set([...this.events, ...eventNames(this._parameterEventHandlers),
      ...[['spawn', this.onSpawn], ['death', this.onDeath], ['collision', this.onCollision]]
        .filter(([, handler]) => handler).map(([name]) => name as string),
    ])].filter(name => this.eventHandler(name));
  }

  private eventHandler(name: string): ParameterEventSubscription<AudioParameters> {
    const handler = parameterEventHandler(this._parameterEventHandlers, name) ?? (name === 'spawn' ? this.onSpawn
      : name === 'death' ? this.onDeath : name === 'collision' ? this.onCollision : true);
    return handler as ParameterEventSubscription<AudioParameters>;
  }

  protected override receive(event: SimulationEvent): void {
    const system = this._system;
    if (!system || !this.eventHandler(event.name)) return;

    // Resolve the source view once, then evaluate the selected cue's parameters.
    const particle = rendererEventParticle(event, system);
    const hit = event.name === 'collision' ? event.data as CollisionHit : undefined;
    const cues = { spawn: this.onSpawnSound, death: this.onDeathSound,
      collision: this.onCollisionSound }[event.name];
    this._handleEvent(particle, cues, hit, event.name === 'collision' ? this.collisionRatio : this.ratio,
      event.name, event.data, event.source ?? particle);
  }

  public setup(system: ParticleSystem): void {
    this._system = system;
    this.synchronize(system);
    this._ensureListener(system);
  }

  protected _update(particles: Particle[], system: ParticleSystem, deltaTime: number): void {
    this._system = system;
    this._deltaTime = deltaTime;
    this._updateCameraState(system);
    this.synchronize(system);
    this._ensureListener(system);
    this._cleanParticleAudio(particles);

    particles.forEach((particle) => this._updateParticle(particle));
  }

  protected get updateGPUUsesCPUReadback(): boolean { return true; }

  protected _updateGPU(
    buffers: GPUParticleBufferState | GPUParticleRenderBufferState,
    system: ParticleSystem,
    deltaTime = 0,
  ): void {
    this._system = system;
    this._deltaTime = deltaTime;
    this._updateCameraState(system);
    this._ensureListener(system);
    this.beginExecution(system, deltaTime);
    this._advanceGPUAudio(deltaTime);
    const ratio = Math.max(this.ratio, 0.01);
    const sampleLimit = Math.ceil(Math.max(this.maxClips, 1) / ratio) * 2;
    let fields: GPUParticleReadbackField[] | undefined;
    if (!this._hasCustomShouldPlay) {
      fields = ['position', 'velocity', 'speed', 'time'];
      if (
        this.sizeAffectsPitch > 0
        || this.sizeAffectsVolume > 0
        || this.sizeAffectsHighPass > 0
        || this.sizeAffectsLowPass > 0
      ) fields.push('scale');
      if (
        this.alphaAffectsPitch > 0
        || this.alphaAffectsVolume > 0
        || this.alphaAffectsHighPass > 0
        || this.alphaAffectsLowPass > 0
      ) fields.push('alpha');
    }
    this.updateCPUFromGPU(buffers, system, deltaTime, sampleLimit, fields);
  }

  private _updateCameraState(system: ParticleSystem): void {
    if (system.sceneCamera) {
      system.sceneCamera.getWorldPosition(this._cameraPosition);

      if (system.simulationSpace !== 'world') {
        system.worldToSimulation(this._cameraPosition);
      }

      if (
        system.sceneCamera instanceof THREE.PerspectiveCamera
        || system.sceneCamera instanceof THREE.OrthographicCamera
      ) {
        this._cameraDepthRange = [system.sceneCamera.near, system.sceneCamera.far];
      }
    }
  }

  private _ensureListener(system: ParticleSystem): void {
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
  }

  private _updateParticle(particle: Particle): void {
    if (!this.listener || !this.sound || !this._system) return;

    if (!particleRatio(particle, this.ratio) || !this.shouldPlay(particle)) {
      this._removeParticleAudio(particle.id);
      return;
    }

    let state = this._particleAudio.get(particle.id);

    const created = !state;
    if (!state) {
      const audio = new THREE.PositionalAudio(this.listener);
      const sound = this.sound[Math.floor(Math.random() * this.sound.length)];

      audio.setBuffer(sound);
      audio.setLoop(this.loop);

      this._system.add(audio);

      state = {
        audio,
        buffer: sound,
        filters: {},
      };

      this._particleAudio.set(particle.id, state);

      audio.play();
    }

    if (this._system.isGPUProcessingActive) {
      state.targetPosition ??= particle.position.clone();
      state.targetPosition.copy(particle.position);
      state.velocity ??= new THREE.Vector3();
      state.velocity.copy(particle.velocity);
      state.speed = particle.speed;
      if (created) state.audio.position.copy(particle.position);
    } else {
      state.audio.position.copy(particle.position);
      state.targetPosition = undefined;
      state.velocity = undefined;
      state.speed = undefined;
    }
    state.audio.setPlaybackRate(this._getPitch(particle));
    state.audio.setVolume(this._getVolume(particle));
    this._applyFilters(state.audio, particle, undefined, state.filters);
  }

  private _advanceGPUAudio(deltaTime: number): void {
    if (deltaTime <= 0) return;
    const correction = 1 - Math.exp(-this.gpuInterpolationRate * deltaTime);
    this._particleAudio.forEach((state) => {
      if (!state.targetPosition || !state.velocity) return;
      state.targetPosition.addScaledVector(state.velocity, deltaTime * (state.speed ?? 1));
      state.audio.position.lerp(state.targetPosition, correction);
    });
  }

  private _handleEvent(
    particle: Particle,
    buffers?: AudioBuffer[],
    collisionHit?: CollisionHit,
    ratio: number = this.ratio,
    name = collisionHit ? 'collision' : 'spawn',
    data: unknown = collisionHit,
    source: SubSystemSource = particle,
  ): void {
    if (!particleRatio(particle, ratio) || !this.shouldPlay(particle)
      || (this.tags && !tagsIntersect(particle.tags ?? [], this.tags))
      || (collisionHit && collisionHit.impulse.length() <= this.impulseThreshold)) return;
    const handler = this.eventHandler(name);
    if (!handler) return;
    const explicit = typeof handler === 'function'
      || parameterEventHandler(this._parameterEventHandlers, name) !== undefined;
    const cues = buffers?.length ? buffers : explicit ? this.sound : undefined;
    const parameters = transformEventParameters(handler, data, source, {
      sound: cues?.length ? cues[Math.floor(Math.random() * cues.length)] : undefined,
      position: particle.position.clone(), pitch: this._getPitch(particle, collisionHit),
      volume: this._getVolume(particle, collisionHit),
      highPass: this._getHighPassFrequency(particle, collisionHit),
      lowPass: this._getLowPassFrequency(particle, collisionHit),
    });
    if (!parameters?.sound || !parameters.position.toArray().every(Number.isFinite)
      || ![parameters.pitch, parameters.volume, parameters.highPass, parameters.lowPass].every(Number.isFinite)) return;
    this._playOneShot(parameters);
  }

  private _playOneShot(parameters: AudioParameters): void {
    if (!this.listener || !this._system || !parameters.sound) return;
    if (this._eventAudio.size >= this.maxClips) return;

    const audio = new THREE.PositionalAudio(this.listener);

    audio.setBuffer(parameters.sound);
    audio.setLoop(false);

    audio.position.copy(parameters.position);
    audio.setPlaybackRate(Math.max(0, parameters.pitch));
    audio.setVolume(Math.max(0, parameters.volume));
    const filters: BiquadFilterNode[] = [];
    for (const [type, frequency] of [['highpass', parameters.highPass], ['lowpass', parameters.lowPass]] as const) {
      if (frequency <= 0) continue;
      const filter = this._createFilter(type);
      if (!filter) continue;
      this._setFilterFrequency(filter, frequency);
      filters.push(filter);
    }
    if (filters.length) audio.setFilters(filters);

    this._system.add(audio);
    this._eventAudio.add(audio);

    audio.play();

    /*
     * THREE.Audio creates a new AudioBufferSourceNode when play() is
     * called. Clean the temporary source up once that playback ends.
     */
    audio.source?.addEventListener('ended', () => {
      this._eventAudio.delete(audio);
      audio.removeFromParent();
    });
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
        * this._getEffect(this._getDepthTime(particle), this.depthAffectsPitch)
        * this._getDopplerEffect(particle)
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
        * this._getEffect(this._getDepthTime(particle), this.depthAffectsVolume)
        * this._getEffect(collisionHit?.impulse.length() ?? 1, this.impulseAffectsVolume),
    );
  }

  private _applyFilters(
    audio: THREE.PositionalAudio,
    particle: Particle,
    collisionHit?: CollisionHit,
    filterCache: AudioFilters = {},
  ): void {
    const filters: BiquadFilterNode[] = [];

    const highPass = this._getHighPassFrequency(particle, collisionHit);
    if (highPass > 0) {
      filterCache.highPass ??= this._createFilter('highpass');
      if (filterCache.highPass) {
        this._setFilterFrequency(filterCache.highPass, highPass);
        filters.push(filterCache.highPass);
      }
    }

    const lowPass = this._getLowPassFrequency(particle, collisionHit);
    if (lowPass > 0) {
      filterCache.lowPass ??= this._createFilter('lowpass');
      if (filterCache.lowPass) {
        this._setFilterFrequency(filterCache.lowPass, lowPass);
        filters.push(filterCache.lowPass);
      }
    }

    if (filters.length > 0 || audio.getFilters().length > 0) {
      audio.setFilters(filters);
    }
  }

  private _getHighPassFrequency(particle: Particle, collisionHit?: CollisionHit): number {
    return this._getFilteredFrequency(
      this.highPass,
      particle,
      collisionHit,
      {
        size: this.sizeAffectsHighPass,
        alpha: this.alphaAffectsHighPass,
        speed: this.speedAffectsHighPass,
        depth: this.depthAffectsHighPass,
        impulse: this.impulseAffectsHighPass,
      },
    );
  }

  private _getLowPassFrequency(particle: Particle, collisionHit?: CollisionHit): number {
    return this._getFilteredFrequency(
      this.lowPass,
      particle,
      collisionHit,
      {
        size: this.sizeAffectsLowPass,
        alpha: this.alphaAffectsLowPass,
        speed: this.speedAffectsLowPass,
        depth: this.depthAffectsLowPass,
        impulse: this.impulseAffectsLowPass,
      },
    );
  }

  private _getFilteredFrequency(
    value: DynamicValue<number>,
    particle: Particle,
    collisionHit: CollisionHit | undefined,
    effects: {
      size: number;
      alpha: number;
      speed: number;
      depth: number;
      impulse: number;
    },
  ): number {
    const base = evaluateDynamicNumber(
      value,
      particle.time,
      particle.id,
    );

    if (base <= 0) return 0;

    const frequency = base
      * this._getEffect(particle.scale.length(), effects.size)
      * this._getEffect(particle.alpha, effects.alpha)
      * this._getEffect(particle.velocity.length(), effects.speed)
      * this._getEffect(this._getDepthTime(particle), effects.depth)
      * this._getEffect(collisionHit?.impulse.length() ?? 1, effects.impulse);

    return Math.max(0, frequency);
  }

  private _getDepthTime(particle: Particle): number {
    const min = this._cameraDepthRange[0];
    const max = this._cameraDepthRange[1];
    if (max === min) {
      return particle.position.distanceTo(this._cameraPosition) >= max ? 1 : 0;
    }

    return THREE.MathUtils.clamp(
      THREE.MathUtils.mapLinear(
        particle.position.distanceTo(this._cameraPosition),
        min,
        max,
        0,
        1,
      ),
      0,
      1,
    );
  }

  private _getDopplerEffect(particle: Particle): number {
    if (this.dopplerEffect <= 0 || this._deltaTime <= 0) return 1;

    this._relativePosition
      .copy(particle.position)
      .sub(this._cameraPosition);

    if (this._system?.isGPUProcessingActive) {
      const distance = this._relativePosition.length();
      const velocityAwayFromListener = distance > Number.EPSILON
        ? particle.velocity.dot(this._relativePosition) * particle.speed / distance
        : 0;
      return this._getDopplerFactor(velocityAwayFromListener);
    }

    const previous = this._relativePositions.get(particle.id);
    if (!previous) {
      this._relativePositions.set(particle.id, this._relativePosition.clone());
      return 1;
    }

    const previousDistance = previous.length();
    const currentDistance = this._relativePosition.length();
    previous.copy(this._relativePosition);

    const velocityAwayFromListener = (currentDistance - previousDistance) / this._deltaTime;
    return this._getDopplerFactor(velocityAwayFromListener);
  }

  private _getDopplerFactor(velocityAwayFromListener: number): number {
    const speedOfSound = 343;
    const denominator = Math.max(1, speedOfSound + velocityAwayFromListener);
    const physicalFactor = THREE.MathUtils.clamp(speedOfSound / denominator, 0.25, 4);
    return Math.max(0, 1 + (physicalFactor - 1) * this.dopplerEffect);
  }

  private _createFilter(type: BiquadFilterType): BiquadFilterNode | undefined {
    if (!this.listener) return undefined;

    const filter = this.listener.context.createBiquadFilter();
    filter.type = type;

    return filter;
  }

  private _setFilterFrequency(filter: BiquadFilterNode, frequency: number): void {
    if (!this.listener) return;

    const maxFrequency = this.listener.context.sampleRate * 0.5;
    filter.frequency.value = THREE.MathUtils.clamp(frequency, 0, maxFrequency);
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
        this._relativePositions.delete(id);
      }
    });

    // If any event audio has stopped, remove it
    this._eventAudio.forEach((audio) => {
      if (!audio.isPlaying) {
        this._eventAudio.delete(audio);
        audio.removeFromParent();
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
    this._relativePositions.delete(id);
  }

  public destroy(): void {
    super.reset();
    this.dispose();
    this.cancelGPUSelectiveReadback();

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
    this._relativePositions.clear();
    this._system = undefined;
  }

  public clear(): void {
    this.cancelGPUSelectiveReadback();
    this._particleAudio.forEach((_state, id) => {
      this._removeParticleAudio(id);
    });
    this._eventAudio.forEach((audio) => {
      if (audio.isPlaying) audio.stop();
      audio.removeFromParent();
    });
    this._eventAudio.clear();
    this._relativePositions.clear();
  }
}
