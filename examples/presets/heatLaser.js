import * as THREE from 'three';
import { Easing } from 'eaz';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { batchColor, float, If, mix, texture, uint, vec3 } from 'three/tsl';
import {
  Collision,
  ColorOverLifetime,
  isIgnoredCollisionObject,
  DecalRenderer,
  Emitter,
  EmissionShape,
  ForceOverLifetime,
  GasModule,
  GasSimulation,
  LightRenderer,
  MaterialCopy,
  MaterialCopySampleMode,
  MaterialCopySource,
  MeshRenderer,
  Module,
  ParticleSystem,
  RotationBySpeed,
  ScaleOverLifetime,
  SimulationSpace,
  TransformByNoise,
  TransformMode,
  Textures,
  TrailMode,
  TrailRenderer,
  VolumeRenderer,
} from '@rzmps/rzmps';
import wallAndSphere from '../scenes/wallAndSphere.js';
import { getSceneParticleRoot } from '../utils/particleRoot.js';
import burnURL from '../assets/images/heat-laser/burn.png?url';
import scorchURL from '../assets/images/heat-laser/scorch.png?url';
import fragmentsURL from '../assets/models/Destruction_1.glb?url';

export default async function createHeatLaser() {
  // #region docs:controls
  // These art controls tune the look and interaction of this particular laser.
  const controls = {
    automaticSweep: true,
    enabled: true,
    power: 1,
    beamWidth: 0.2,
    sparkRate: 1,
    debrisRate: 1,
    burnSize: 0.8,
    minDistance: 0.035,
    maxStretch: 4,
    beamLengthPadding: 0.3,
    baseLifetime: 8,
    maxDecals: 2 ** 11,
    smokeAmount: 1,
    temperature: 1.2,
  };
  // #endregion docs:controls

  const beamRate = 600,
    beamSpeed = 90,
    ribbonCount = 3;
  const haloTexture = new THREE.TextureLoader().load(Textures.Simple);
  const origin = new THREE.Vector3(-7, 2.5, 5);
  const smoothedTarget = new THREE.Vector3(0.6, 1.9, 1.4);
  let aiming = false;
  const pointer = new THREE.Vector2(),
    raycaster = new THREE.Raycaster();
  const sweep = createHeatLaserSweep();
  const { from: sweepStart, to: previous } = sweep;
  const direction = new THREE.Vector3();
  let elapsed = 0,
    activeScene,
    canvas,
    manualTarget;
  let collisionCount = 0,
    reheatCount = 0;

  // #region docs:renderers:beam
  // A white-hot core sells concentrated energy; a wider orange halo makes it glow.
  const glowMaterial = new THREE.MeshBasicMaterial({
    color: '#ff3104',
    map: haloTexture,
    transparent: true,
    opacity: 0.6 / ribbonCount,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
  const coreMaterial = new THREE.MeshBasicMaterial({
    color: '#fff5bb',
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
  const halo = new TrailRenderer({
    mode: TrailMode.Ribbon,
    ribbonCount,
    texture: haloTexture,
    width: controls.beamWidth * 4,
    material: glowMaterial,
    inheritParticleColor: false,
    sizeAffectsWidth: false,
  });
  const core = new TrailRenderer({
    mode: TrailMode.Ribbon,
    ribbonCount,
    width: controls.beamWidth / ribbonCount,
    material: coreMaterial,
    inheritParticleColor: false,
    sizeAffectsWidth: false,
  });
  // #endregion docs:renderers:beam

  // #region docs:system
  const system = new ParticleSystem({
    gpuProcessing: false,
    simulationSpace: SimulationSpace.World,
    maxParticles: 4096,
    duration: 60,
    looping: true,
    gravityModifier: 0,
    // Closely spaced, fast particles read as one continuous beam when joined by ribbon trails.
    // #region docs:emitters:anchors
    emitters: new Emitter({
      tags: ['laser-beam'],
      source: EmissionShape.Sphere(0.001, 8, 6),
      rate: () => (controls.enabled ? beamRate : 0),
      radialSpeed: 0.08,
      initialValues: {
        position: origin,
        velocity: () => direction.clone().multiplyScalar(beamSpeed),
        lifetime: 0.5,
        mass: 0.01,
        scale: 0.005,
        color: '#fff5bb',
      },
    }),
    // #endregion docs:emitters:anchors
    renderers: [halo, core],
  });
  system.name = 'Heat Laser';
  // #endregion docs:system

  // #region docs:renderers:burn
  const loader = new THREE.TextureLoader();
  const burnMap = loader.load(burnURL),
    scorchMap = loader.load(scorchURL);
  scorchMap.colorSpace = THREE.SRGBColorSpace;
  const burn = texture(burnMap);
  const burnMaterial = new MeshStandardNodeMaterial({
    roughness: 0.98,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  // Glowing burn marks show active heat; a separate dark scorch layer leaves a visible damage trail.
  burnMaterial.colorNode = vec3(0.08, 0.025, 0.01);
  burnMaterial.opacityNode = burn.a;
  burnMaterial.emissiveNode = vec3(3, 0.3, 0.01).mul(burn.a).mul(batchColor.r.pow(2));
  const burns = new DecalRenderer(burnMaterial, {
    tags: ['laser-beam'],
    onSpawn: false,
    onCollision: (_hit, _source, parameters) => {
      if (!controls.enabled) return false;
      parameters.size.set(controls.burnSize, controls.burnSize, 1);
      parameters.lifetime = controls.baseLifetime;
      return parameters;
    },
    // Overlap neighboring marks into a continuous hot stroke while keeping texture variation.
    warp: (particle, ray, hit) =>
      DecalRenderer.Warp.FromPoints(sweepStart, previous, controls.maxStretch, 4)(particle, ray, hit),
    rotation: () => Math.random() * Math.PI * 2,
    minDistance: controls.minDistance,
    maxDecals: controls.maxDecals,
    depth: 0.2,
    offset: 0.008,
    inheritColor: 0,
    inheritScale: 0,
    inheritAlpha: 0,
    inheritMaterial: false,
    emissionTags: ['laser-burn'],
    opacity: age => 1 - THREE.MathUtils.smoothstep(age, 0.6, 1),
  });
  // Keep the damage wider, dimmer and less stretched than the molten-looking burn layer.
  const scorchMaterial = new THREE.MeshStandardMaterial({
    map: scorchMap,
    roughness: 0.98,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const scorches = new DecalRenderer(scorchMaterial, {
    tags: ['laser-beam'],
    onSpawn: false,
    onCollision: () => {
      if (!controls.enabled) return false;
    },
    rotation: () => Math.random() * Math.PI * 2,
    size: 1.15,
    lifetime: () => controls.baseLifetime,
    warp: DecalRenderer.Warp.FromPoints(sweepStart, previous, 1.15, 1.1),
    minDistance: controls.minDistance,
    maxDecals: controls.maxDecals,
    depth: 0.3,
    offset: 0.004,
    inheritColor: 0,
    inheritScale: 0,
    inheritAlpha: 0,
    inheritMaterial: false,
    opacity: age => 0.45 * (1 - age),
  });
  // #endregion docs:renderers:burn

  // #region docs:events
  const lifetimeHeat = source => Easing.cubic.in(Math.max(0, 1 - source.age / source.lifetime));
  const unsubscribe = system.onEvent('collision', event => {
    const hit = event.data;
    if (!controls.enabled || !hit?.object || !hit.normal || !event.source?.tags?.includes('laser-beam')) return;
    collisionCount++;
    // Keep a stationary hit hot instead of piling new marks on the same spot.
    const renderer = event.origin.renderers.find(view => view instanceof DecalRenderer);
    const local = hit.object.worldToLocal(hit.point.clone());
    const overlapping = renderer
      ?.queryDecals(hit.object, hit.point, controls.burnSize * controls.maxStretch, hit.normal)
      .find(decal => {
        if (!decal.geometry.boundingBox) decal.geometry.computeBoundingBox();
        return decal.geometry.boundingBox.distanceToPoint(local) < 0.035;
      });
    if (overlapping) {
      // Restart cooling and add a short, hotter burst at the contacted mark.
      overlapping.age = 0;
      overlapping.lifetime = controls.baseLifetime;
      overlapping.source?.emitEvent('reheat');
      reheatCount++;
    }
    sweep.contact(hit, burns.decals, overlapping);
  });
  // Listen for reheating before attaching the renderers that place new marks.
  system.addRenderer(burns);
  system.addRenderer(scorches);
  // Fade the molten glow with heat, while the damage layer follows its own lifetime fade.
  const updateBurnSources = () => {
    for (const decal of burns.decals) {
      const source = decal.source;
      if (!source) continue;
      const value = lifetimeHeat(decal);
      decal.color.setRGB(value, value, value);

      source.update({ mass: controls.power * controls.smokeAmount });
    }
  };
  // #endregion docs:events

  // #region docs:modules:controller
  // #region docs:modules:aim
  // Smooth the aim so a fast pointer sweep still leaves a continuous stroke.
  const movePointer = event => {
    const bounds = canvas.getBoundingClientRect();
    pointer.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      1 - ((event.clientY - bounds.top) / bounds.height) * 2,
    );
    controls.automaticSweep = false;
    manualTarget = undefined;
  };
  const automaticTarget = () => {
    const phase = elapsed % 18;
    // Hold, sweep, leave an older patch, return to it, and then sweep toward the floor.
    if (phase < 2) return new THREE.Vector3(-0.1, 1.8, 1.25);
    if (phase < 7) return new THREE.Vector3(-0.1 + (phase - 2) * 0.36, 1.8, 1.4);
    if (phase < 10) return new THREE.Vector3(1.7, 1.3, 1.3);
    if (phase < 13) return new THREE.Vector3(-0.1, 1.8, 1.25);
    return new THREE.Vector3(0.2 + Math.sin(phase) * 1.1, 0, 2.4);
  };
  system.addModule(
    new Module(() => {}, {
      prepare: context => {
        const dt = context.deltaTime;
        elapsed += dt;
        sweep.advance(dt, controls.enabled);
        gas.sourceTemperature = controls.temperature;
        updateBurnSources();
        const nextCanvas = system.sceneRenderer?.domElement;
        if (nextCanvas && nextCanvas !== canvas) {
          canvas?.removeEventListener('pointermove', movePointer);
          canvas = nextCanvas;
          canvas.addEventListener('pointermove', movePointer);
        }
        const scene = system.scene,
          sceneRoot = scene && getSceneParticleRoot(scene);
        if (sceneRoot !== activeScene) {
          burns.clear();
          scorches.clear();
          activeScene = sceneRoot;
          sweep.reset();
          aiming = false;
        }
        if (!scene || !controls.enabled) return;
        scene.updateWorldMatrix(true, true);
        let target = manualTarget?.clone() ?? automaticTarget();
        if (!manualTarget && !controls.automaticSweep && system.sceneCamera) {
          raycaster.setFromCamera(pointer, system.sceneCamera);
          const targets = [];
          const collect = object => {
            if (!object.visible || isIgnoredCollisionObject(object)) return;
            if (object.isMesh) targets.push(object);
            object.children.forEach(collect);
          };
          scene.children.forEach(collect);
          const aimed = raycaster.intersectObjects(targets, false)[0];
          if (aimed) target = aimed.point;
          else target = raycaster.ray.at(20, new THREE.Vector3());
        }
        // Smooth the beam toward the aim target.
        if (!aiming) {
          smoothedTarget.copy(target);
          aiming = true;
        } else smoothedTarget.lerp(target, 1 - Math.exp(-28 * dt));
        direction.copy(smoothedTarget).sub(origin).normalize();
        halo.width = controls.beamWidth * 4;
        core.width = controls.beamWidth / ribbonCount;
        burns.minDistance = scorches.minDistance = controls.minDistance;
        burns.maxDecals = scorches.maxDecals = controls.maxDecals;
      },
    }),
  );
  // #endregion docs:modules:aim

  // #region docs:modules:beamNoise
  // Give the straight beam three independently jagged strands without bending its collision path.
  for (let ribbon = 0; ribbon < ribbonCount; ribbon++) {
    system.addModule(
      new TransformByNoise({
        tags: ['laser-beam'],
        priority: Module.Priority.Transient,
        transformMode: TransformMode.Position,
        strength: () => (controls.beamWidth / ribbonCount) * 1.5,
        frequency: 1,
        scrollSpeed: 3,
        offset: new THREE.Vector3(ribbon * 31.416, 0, 0),
        condition: core.RibbonCondition(ribbon),
      }),
    );
  }
  // #endregion docs:modules:beamNoise

  // #region docs:modules:beamCollision
  // Stop the beam at surfaces and use those same hits for every impact effect.
  system.addModule(new Collision({ tags: ['laser-beam'], lifetimeLoss: 1 }));

  // Trim old beam segments beyond the latest hit; stale hits expire when aiming into open space.
  system.addModule(
    new Module(particle => particle.kill(), {
      tags: ['laser-beam'],
      priority: Module.Priority.PreMovementTransient,
      condition: particle =>
        sweep.receiver &&
        sweep.age <= 0.1 &&
        particle.position.distanceToSquared(origin) >
          (previous.distanceTo(origin) + Math.max(0, controls.beamLengthPadding)) ** 2,
    }),
  );
  // #endregion docs:modules:beamCollision
  // #endregion docs:modules:controller

  // #region docs:emitters:impact
  // #region docs:emitters:sparks
  // Short, bright sparks make contact feel energetic without becoming another flame source.
  const sparks = new ParticleSystem({
    gpuProcessing: false,
    simulationSpace: SimulationSpace.World,
    maxParticles: 16384,
    duration: 0.08,
    looping: false,
    gravityModifier: 1,
    emitters: new Emitter({
      source: EmissionShape.Sphere(0.025),
      radialSpeed: [1, 6],
      bursts: { time: 0, count: () => Math.round((3 + Math.random() * 5) * controls.sparkRate) },
      initialValues: {
        lifetime: [0.2, 0.8],
        speed: [0.7, 1.6],
        mass: 0.01,
        scale: new THREE.Vector3(0.025, 0.1, 0.025),
        velocity: new THREE.Vector3(0, 4, 0),
        color: '#fff1bc',
      },
    }),
    modules: [
      new Collision({ bounce: 0.35, dampen: 0.25, lifetimeLoss: 0.2 }),
      new ColorOverLifetime({ color: ['#fff4c4', '#ff2b03'], alpha: time => (1 - time) ** 1.5 }),
    ],
    renderers: [
      new TrailRenderer({
        lifetime: 0.06,
        width: 0.012,
        material: new THREE.MeshBasicMaterial({
          color: '#ffad32',
          blending: THREE.AdditiveBlending,
          transparent: true,
          depthWrite: false,
          toneMapped: false,
        }),
      }),
    ],
  });
  sparks.name = 'Laser Sparks';
  system.addSubSystem(sparks, {
    tags: ['laser-beam'],
    ratio: 0.08,
    emitOnCollision: true,
    emitContinuous: false,
    inheritLifetime: 0,
    inheritScale: 0,
    inheritColor: 0,
    inheritVelocity: 0.03,
    shouldEmit: () => controls.enabled,
  });

  // #endregion docs:emitters:sparks

  // #region docs:emitters:debris
  // Surface-colored fragments suggest that the laser is chipping material away.
  const fragmentAsset = await new GLTFLoader().loadAsync(fragmentsURL);
  const fragmentMaterial = new THREE.MeshStandardMaterial({ color: 'white', roughness: 1 });
  const fragments = [];
  fragmentAsset.scene.updateMatrixWorld(true);
  fragmentAsset.scene.traverse(object => {
    if (!object.isMesh) return;
    fragments.push(new THREE.Mesh(object.geometry.clone().applyMatrix4(object.matrixWorld), fragmentMaterial));
    object.geometry.dispose();
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose();
  });
  // Size the collision sphere from the authored fragments rather than their unit particle scale.
  const thicknesses = fragments
    .map(fragment => {
      fragment.geometry.computeBoundingBox();
      const size = fragment.geometry.boundingBox.getSize(new THREE.Vector3());
      return Math.min(size.x, size.y, size.z);
    })
    .sort((a, b) => a - b);
  const collisionDiameter = thicknesses[Math.floor(thicknesses.length / 2)] ?? 0.03;
  const debris = new ParticleSystem({
    gpuProcessing: false,
    simulationSpace: SimulationSpace.World,
    maxParticles: 8192,
    duration: 0.08,
    looping: false,
    gravityModifier: 1,
    emitters: new Emitter({
      source: EmissionShape.Sphere(0.03),
      radialSpeed: [0.5, 5],
      bursts: {
        time: 0,
        count: () => (Math.random() < controls.debrisRate ? 1 : 0),
      },
      initialValues: {
        lifetime: [1.5, 3],
        scale: [0.8, 2.5],
        velocity: new THREE.Vector3(0, 2, 0),
        mass: 0.1,
        rotation: [new THREE.Vector3(), new THREE.Vector3(6, 6, 6)],
        // Let RotationBySpeed own tumbling so settled fragments stop rotating.
        angularVelocity: 0,
      },
    }),
    modules: [
      new MaterialCopy({ source: MaterialCopySource.Collision, sampleMode: MaterialCopySampleMode.UVPatch }),
      new Collision({ bounce: 0.3, dampen: 0.4, radiusScale: collisionDiameter }),
      new RotationBySpeed({
        speedRange: [0.25, 1],
        angularVelocity: [0, new THREE.Vector3(20, 40, 10)],
      }),
      new ColorOverLifetime({ alpha: time => 1 - THREE.MathUtils.smoothstep(time, 0.8, 1) }),
    ],
    renderers: new MeshRenderer({ mesh: fragments, maxParticles: 8192, textureCopyQuality: 1 }),
  });
  debris.name = 'Laser Debris';
  system.addSubSystem(debris, {
    tags: ['laser-beam'],
    ratio: 0.025,
    emitOnCollision: true,
    emitContinuous: false,
    inheritLifetime: 0,
    inheritScale: 0,
    inheritColor: 0,
    inheritVelocity: 0,
    shouldEmit: () => controls.enabled,
  });
  // #endregion docs:emitters:debris
  // #endregion docs:emitters:impact

  // #region docs:modules:gas
  // #region docs:modules:solver
  // Let heat rise and drift into a shared plume that can outlive the beam at each contact.
  const gas = new GasSimulation({
    sourceTemperature: controls.temperature,
    collisionOptions: { surfaceThickness: 0.02, bakedFieldResolution: 24 },
    spatialGridOptions: {
      brickSubdivisions: 4,
      cellSubdivisions: 2,
      minVolumeQuality: 8,
      maxVolumeQuality: 8,
    },
    pressureIterations: 12,
    sourceStrength: 0.3,
    velocitySourceStrength: 0.018,
    externalForce: new THREE.Vector3(-0.12, 0.1, 0),
    densityDissipation: 1.6,
    temperatureDissipation: 4,
    colorDissipation: 1.6,
    velocityDissipation: 0.15,
    temperatureOverLifetime: time => 1 - time,
    buoyancy: 8,
    weight: 0,
    scalarDiffusion: 0.00005,
    turbulenceNoiseStrength: 1,
    turbulenceNoiseFrequency: 2.4,
    turbulenceNoiseSpeed: 0.95,
    turbulenceNoiseOctaves: 2,
    vorticityStrength: 10,
    temperatureRange: [0, 1.2],
    densityDissipationByTemperature: [1, 2],
    colorDissipationByTemperature: [1, 2],
  });
  // #endregion docs:modules:solver

  // #region docs:modules:cooling
  // New emissions start hot at fresh burns, then become cooler and thinner as those marks age.
  const coolingBurnGas = new GasModule({
    initialize(particles, emission) {
      if (particles.length === 0) return;
      let heat = 0,
        temperature = 0,
        count = 0;
      for (const particle of particles) {
        const source = particle.source;
        if (!source) continue;
        const cooling = lifetimeHeat(source);
        heat += cooling;
        temperature += cooling * (particle.tags?.includes('laser-reheat') ? 2 : 1);
        count++;
      }
      // Orphaned particles stop depositing gas when their burn source has expired or been removed.
      const cooling = count > 0 ? heat / count : 0;
      emission.temperature *= count > 0 ? temperature / count : 0;
      emission.density *= cooling;
    },
    initializeGPU(particles, emission) {
      const heat = float(0).toVar(),
        temperature = float(0).toVar(),
        count = float(0).toVar();
      const reheatMask = uint(fumes.getGPUFilterTagMask(['laser-reheat']) ?? 0);
      particles.forEach(particle => {
        const source = particle.source;
        If(source.valid, () => {
          const cooling = float(1).sub(source.age.div(source.lifetime)).clamp(0, 1).pow(3);
          heat.addAssign(cooling);
          temperature.addAssign(cooling.mul(particle.tagMask.bitAnd(reheatMask).notEqual(0).select(2, 1)));
          count.addAssign(1);
        });
      });
      const cooling = heat.div(count.max(1));
      emission.temperature.mulAssign(temperature.div(count.max(1)));
      emission.density.mulAssign(cooling);
    },
  });
  // #endregion docs:modules:cooling

  // #region docs:modules:spread
  // Fresh, hot burns spread gas outward; cool marks release a gentler plume.
  const gasSpread = new Module(() => {}, {
    modifyGPU: () => {},
    initializeParticle(particle, { source }) {
      const heat = source ? (lifetimeHeat(source) * controls.temperature) / 1.2 : 0;
      const radial = THREE.MathUtils.lerp(0.25, 1.5, THREE.MathUtils.clamp(heat, 0, 1));
      particle.velocity
        .sub(new THREE.Vector3(0, 0.6, 0))
        .multiplyScalar(radial)
        .add(new THREE.Vector3(0, 0.6, 0));
    },
    initializeParticleGPU(particle, context) {
      const source = context.source;
      const heat = source
        ? float(1)
            .sub(source.realtime.div(1000).div(source.lifetime))
            .clamp(0, 1)
            .pow(3)
            .mul(controls.temperature / 1.2)
            .clamp(0, 1)
        : float(0);
      particle.velocity.assign(
        particle.velocity
          .sub(vec3(0, 0.6, 0))
          .mul(mix(float(0.25), float(1.5), heat))
          .add(vec3(0, 0.6, 0)),
      );
    },
  });
  // #endregion docs:modules:spread
  // #endregion docs:modules:gas

  // #region docs:renderers:gas
  // Hot gas reads as luminous flame; cooler gas becomes gray smoke lit by the scene.
  const volume = new VolumeRenderer({
    lightingGridOptions: { cellSize: 0.5, maxDistance: 8 },
    opacity: 0.75,
    threshold: 0.025,
    range: 0.02,
    steps: 160,
    samplesPerVoxel: 2,
    temperatureRange: [0, 1],
    opacityByTemperature: heat => THREE.MathUtils.lerp(0.45, 2, THREE.MathUtils.smoothstep(heat, 0.1, 0.8)),
    emissive: 1,
    emissiveByTemperature: heat => THREE.MathUtils.smoothstep(heat, 0.08, 0.45),
    emissiveByDensity: density => Math.min(1, density * 8),
    colorByTemperature: heat => {
      const smoke = new THREE.Color('#686b70'),
        flame = new THREE.Color('#ff5108');
      return heat < 0.35
        ? smoke.lerp(flame, THREE.MathUtils.smoothstep(heat, 0.08, 0.35))
        : flame.lerp(new THREE.Color('#fff4b0'), THREE.MathUtils.smoothstep(heat, 0.35, 1));
    },
    densityNoiseStrength: 1,
    densityNoiseContrast: 2,
    densityNoiseFrequency: 1,
    densityNoiseSpeed: 4,
    densityNoiseOctaves: 1,
    densityNoiseStrengthByTemperature: [0.25, 1.5],
    densityNoiseContrastByTemperature: [0.5, 1.25],
    densityNoiseFrequencyByTemperature: [1.25, 2],
    densityNoiseStretch: 0.25,
    densityNoiseStretchByTemperature: [1, 0.1],
    densityNoiseStretchBySpeed: [0, 1],
  });
  // #endregion docs:renderers:gas

  // #region docs:renderers:lights
  // Light nearby surfaces with two warm lights; the volume supplies its own visible flame color.
  const flameLights = new LightRenderer({
    count: 2,
    brightness: 4,
    distance: 6,
    decay: 1,
    rangeMultiplier: 4,
    alphaAffectsIntensity: true,
    inheritParticleColor: false,
    color: '#ff842b',
    configureLight(particle, light) {
      const sourceHeat = particle.source ? lifetimeHeat(particle.source) : 0;
      const temperature =
        controls.temperature * sourceHeat * (1 - particle.time) * (particle.tags?.includes('laser-reheat') ? 2 : 1);
      light.intensity *= THREE.MathUtils.smoothstep(temperature, 0, 1.2) ** 2;
    },
  });
  // #endregion docs:renderers:lights

  // #region docs:emitters:gas
  // Give every accepted burn its own ongoing plume, with extra hot emission while the beam reheats it.
  const fumes = new ParticleSystem({
    gpuProcessing: true,
    simulationSpace: SimulationSpace.World,
    maxParticles: 65536,
    initialCapacity: 4096,
    duration: 60,
    looping: true,
    gravityModifier: 0,
    emitters: [
      new Emitter({
        emitContinuous: true,
        sourceTags: ['laser-burn'],
        source: EmissionShape.Sphere(0.12),
        rate: 5,
        radialSpeed: 0.7,
        initialValues: {
          position: new THREE.Vector3(0, 0.25, 0),
          lifetime: 0.7,
          scale: 0.3,
          mass: 1.2,
          color: 'white',
          velocity: new THREE.Vector3(0, 0.6, 0),
        },
      }),
      // Reheating adds a source-bound burst; its short event run emits once and then retires.
      new Emitter({
        sourceTags: ['laser-burn'],
        tags: ['laser-reheat'],
        emitContinuous: false,
        onEvent: { reheat: () => ({ duration: 0.05 }) },
        source: EmissionShape.Sphere(0.12),
        rate: 0,
        bursts: { time: 0, count: 1 },
        radialSpeed: 0.7,
        initialValues: {
          position: new THREE.Vector3(0, 0.25, 0),
          lifetime: 0.35,
          scale: 0.3,
          mass: 1.2,
          color: 'white',
          velocity: new THREE.Vector3(0, 0.6, 0),
        },
      }),
    ],
    modules: [
      gas,
      coolingBurnGas,
      gasSpread,
      new ForceOverLifetime({ force: new THREE.Vector3(0, 0.35, 0) }),
      new TransformByNoise({ strength: new THREE.Vector3(0.35, 0.12, 0.35), frequency: 1.8 }),
      new ScaleOverLifetime({ scale: time => 1 - 0.8 * time }),
      new ColorOverLifetime({ alpha: time => 1 - THREE.MathUtils.smoothstep(time, 0.65, 1) }),
    ],
    renderers: [volume, flameLights],
  });
  fumes.name = 'Laser Fire and Smoke';
  system.addSubSystem(fumes, {
    inheritLifetime: 0,
    inheritScale: 0,
    inheritColor: 0,
    inheritAlpha: 0,
    inheritMass: 1,
    inheritVelocity: 1,
    shouldEmit: source => source.alpha > 0 && source.mass > 0,
  });
  // #endregion docs:emitters:gas

  // #region docs:lifecycle
  // Expose demo controls and release the textures, materials and event handlers owned by this preset.
  system.userData.heatLaser = {
    controls,
    gas,
    burns,
    scorches,
    aimAt: point => {
      manualTarget = point.clone();
      controls.automaticSweep = false;
    },
    get statistics() {
      return {
        collisions: collisionCount,
        reheats: reheatCount,
        burns: burns.count,
        sources: burns.decals.filter(decal => decal.source?.alive).length,
      };
    },
  };
  system.addEventListener('destroyed', () => {
    unsubscribe();
    canvas?.removeEventListener('pointermove', movePointer);
    burnMaterial.dispose();
    scorchMaterial.dispose();
    burnMap.dispose();
    scorchMap.dispose();
    glowMaterial.dispose();
    coreMaterial.dispose();
    haloTexture.dispose();
    fragments.forEach(mesh => mesh.geometry.dispose());
    fragmentMaterial.dispose();
  });
  return system;
  // #endregion docs:lifecycle
}

// #region docs:helpers:sweep
// Bridge accepted burn marks; reheating makes the contacted mark the next anchor.
export function createHeatLaserSweep() {
  return {
    from: new THREE.Vector3(),
    to: new THREE.Vector3(),
    receiver: undefined,
    age: Infinity,
    anchor: undefined,
    latest: undefined,
    reset() {
      this.receiver = undefined;
      this.age = Infinity;
      this.anchor = this.latest = undefined;
      this.from.copy(this.to);
    },
    advance(deltaTime, enabled = true) {
      this.age += deltaTime;
      if (!enabled) this.reset();
    },
    contact(hit, decals = [], reheated) {
      // Never connect different receivers or bridge an interruption in contact.
      const latest = decals.at(-1);
      if (this.receiver !== hit.object || this.age > 0.1) this.anchor = undefined;
      else if (latest !== this.latest) this.anchor = latest;
      this.latest = latest;
      if (reheated) this.anchor = reheated;
      this.from.copy(hit.point);
      if (this.anchor?.receiver === hit.object && decals.includes(this.anchor) && this.anchor.emissionTransform) {
        this.anchor.receiver.updateWorldMatrix(true, false);
        this.from.setFromMatrixPosition(this.anchor.emissionTransform).applyMatrix4(this.anchor.receiver.matrixWorld);
      }
      this.to.copy(hit.point);
      this.receiver = hit.object;
      this.age = 0;
    },
  };
}
// #endregion docs:helpers:sweep

/** @type {import('../types').ExampleMetadata} */
createHeatLaser.metadata = {
  id: 'heatLaser',
  title: 'Heat Laser',
  author: 'rzmay',
  description: 'Interactive heat laser with collision sparks, reheated burns and persistent fire.',
  tags: ['laser', 'trails', 'collision', 'decals', 'sources', 'events', 'gas', 'fire', 'webgpu'],
  previewSettings: {
    backend: 'webgpu',
    scene: wallAndSphere,
    warmup: 240,
    duration: 12,
    cameraPosition: [-6, 3.6, 8],
    cameraTarget: [0, 1.5, 0],
  },
};
