import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { exp, float, mix, pow, uniform, vec3 } from 'three/tsl';
import {
  GasAffector, GasSimulation, Module, ParticleForceField, SpatialEffectHelper, GeometryUpdatePolicy,
} from '@rzmps/rzmps';
import suzanneModel from 'examples/assets/models/suzanne.glb?url';
import { createSceneParticleRoot, disposeSceneParticleRoot } from '../utils/particleRoot.js';

const CONFIGURER_KEY = '__rzmps_configureParticleSystem';

export default async function gasSpatialEffectsScene(scene) {
  const gltf = await new GLTFLoader().loadAsync(suzanneModel);
  let geometry;

  gltf.scene.traverse(child => {
    if (geometry || !child.isMesh) return;
    geometry = child.geometry.clone();
    geometry.rotateX(-Math.PI / 2);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
  });

  if (!geometry) throw new Error('suzanne.glb does not contain a mesh');

  const root = new THREE.Group();
  root.name = 'Gas Spatial Effects Scene';
  const particleRoot = createSceneParticleRoot(scene);

  // An ordinary force field affects both particles and gas, with a soft spatial boundary.
  const wind = ParticleForceField.Sphere({
    direction: new THREE.Vector3(0.015, 0.005, 0),
    rotationSpeed: 0.008,
    position: new THREE.Vector3(-1.5, 1.5, 0),
    feather: 0.65,
    priority: Module.Priority.Permanent,
  }, 2.2, 24, 16);
  wind.name = 'Permanent Feathered Wind';

  // This fixed, hard-edged box changes physical temperature rather than particle appearance.
  const heatingRate = uniform(3);
  const heater = GasAffector.Box((gas, dt, _context, strength) => {
    gas.temperature.addAssign(heatingRate.mul(dt).mul(strength));
    gas.velocity.y.addAssign(float(0.4).mul(dt).mul(strength));
  }, {
    position: new THREE.Vector3(1.3, 1.6, 0),
    priority: Module.Priority.Permanent,
    feather: 0,
  }, 1.8, 2.5, 2.4);
  heater.name = 'Permanent Hard-Edged Heater';

  // A moving custom shape modifies only the rendered gas; transported state stays unchanged.
  const tintColor = new THREE.Color('#62c6dd');
  const tintRetention = uniform(0.4);
  const tint = new GasAffector((gas, dt, _context, strength) => {
    const step = dt.mul(strength);
    gas.color.assign(mix(gas.color, vec3(tintColor), float(1).sub(exp(step.mul(-8)))));
    gas.density.mulAssign(pow(tintRetention, step));
  }, {
    geometry,
    position: new THREE.Vector3(0, 2.2, 0),
    scale: new THREE.Vector3(1.2, 1.2, 1.2),
    feather: 0.4,
    updatePolicy: GeometryUpdatePolicy.TransformDynamic,
    priority: Module.Priority.Transient,
  });
  tint.name = 'Moving Transient Suzanne Tint';

  const effects = [wind, heater, tint];
  const helpers = effects.map((effect, index) =>
    new SpatialEffectHelper(effect, [0xffd166, 0xff8844, 0x62c6dd][index]));
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 18),
    new THREE.MeshStandardMaterial({ color: 0x20252a, roughness: 0.88 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(6, 10, 5);
  root.add(...effects, ...helpers, ground, new THREE.AmbientLight(0xffffff, 0.55), light);
  scene.add(root);

  // Configure the selected system without creating or selecting a particle preset.
  const previousConfigurer = scene.userData[CONFIGURER_KEY];
  const configure = system => {
    previousConfigurer?.(system);
    system.useSpatialEffects = true;
    for (const gas of system.getModules(GasSimulation)) gas.supportForceFields = true;
  };
  scene.userData[CONFIGURER_KEY] = configure;
  const motion = { enabled: true };
  let elapsed = 0;

  return {
    update(dt) {
      if (!motion.enabled) return;
      elapsed += dt;
      tint.position.set(Math.sin(elapsed * 0.6) * 2, 2.2 + Math.sin(elapsed * 0.8) * 0.5, 0);
      tint.rotation.y = elapsed * 0.3;
      helpers[2].update();
    },

    gui(folder) {
      effects.forEach((effect, index) => {
        const controls = folder.addFolder(effect.name);
        for (const axis of ['x', 'y', 'z']) {
          controls.add(effect.position, axis, -8, 8, 0.1).name(axis.toUpperCase())
            .onChange(() => helpers[index].update());
        }
        controls.add(effect, 'feather', 0, 3, 0.05).name('Feather')
          .onChange(() => helpers[index].update());
        controls.add(helpers[index], 'visible').name('Show Helper');
        if (effect === tint) controls.add(motion, 'enabled').name('Move');
      });
      const windControls = folder.addFolder('Wind Force');
      for (const axis of ['x', 'y', 'z']) {
        windControls.add(wind.direction, axis, -0.1, 0.1, 0.001).name(axis.toUpperCase())
          .onChange(() => { wind.needsUpdate = true; });
      }
      folder.add(heatingRate, 'value', -5, 5, 0.1).name('Heating Rate');
      folder.add(tintRetention, 'value', 0, 1, 0.01).name('Transient Density Retention');
    },

    cleanup() {
      disposeSceneParticleRoot(scene, particleRoot);
      scene.remove(root);
      if (scene.userData[CONFIGURER_KEY] === configure) {
        if (previousConfigurer) scene.userData[CONFIGURER_KEY] = previousConfigurer;
        else delete scene.userData[CONFIGURER_KEY];
      }
      helpers.forEach(helper => helper.dispose());
      effects.forEach(effect => effect.geometry.dispose());
      ground.geometry.dispose();
      ground.material.dispose();
    },
  };
}

gasSpatialEffectsScene.metadata = { id: 'gasSpatialEffects', title: 'Gas Spatial Effects', author: 'rzmay' };
gasSpatialEffectsScene.description =
  'Three regions demonstrate permanent wind and heating, plus a moving, feathered custom gas appearance effect.';
