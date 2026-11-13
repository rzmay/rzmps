import assert from 'node:assert/strict';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../site/dev.mjs';
import { openFixture } from './openFixture.mjs';

const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const fixture = path.resolve(import.meta.dirname, 'fixtures/corrective.html');
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`, errors);
  const result = await page.evaluate(async ({ library, serializerPath, moduleGUIPath }) => {
    const api = await import(library);
    const { THREE, StorageBufferAttribute, tsl } = window.debugBehavior;
    const { Fn, storage, vec4, float, uint } = tsl;
    const { ParticleSystemSerializer } = await import(serializerPath);
    const { ModuleGUI } = await import(moduleGUIPath);
    const { renderer, scene, camera } = window.debugBehavior;
    const gas = new api.GasSimulation({ automaticPadding: false, boundsPadding: 0,
      bounds: new THREE.Box3(new THREE.Vector3(-2, -2, -2), new THREE.Vector3(2, 2, 2)),
      initialBrickCapacity: 1, maxBrickCapacity: 1, spatialGridOptions: { brickSubdivisions: 0, cellSubdivisions: 2 },
      sourceStrength: 0, velocitySourceStrength: 0, buoyancy: 0, weight: 0, pressureIterations: 0,
      densityDissipation: 0.2, temperatureDissipation: 0.4, colorDissipation: 0.3, velocityDissipation: 0.5,
      densityCutoff: 0, turbulenceNoiseStrength: 0, vorticityStrength: 0,
    });
    const owner = new api.ParticleSystem({ gpuProcessing: true, gravityModifier: 0, maxParticles: 8,
      emitters: new api.Emitter({ rate: 0, bursts: [{ time: 0, count: 1 }],
        initialValues: { lifetime: 10, scale: 0.1 } }), modules: [gas], renderers: [] });
    scene.add(owner); await renderer.renderAsync(scene, camera);
    owner.advanceFrames(1, 1 / 60);
    await renderer.backend.device.queue.onSubmittedWorkDone();
    gas.closedMinNode.value.set(1, 1, 1); gas.closedMaxNode.value.set(1, 1, 1);
    const context = gas.poolContext, grid = gas.poolParticleGrid;
    const read = async attribute => new Float32Array(await renderer.getArrayBufferAsync(attribute));
    const coefficients = ['turbulenceNoiseStrength', 'vorticityStrength', 'densityDissipation',
      'temperatureDissipation', 'velocityDissipation', 'colorDissipation', 'turbulenceNoiseFrequency'];
    const outputAttribute = new StorageBufferAttribute(new Float32Array(7 * 4), 4);
    const output = storage(outputAttribute, 'vec4', 7);
    gas.temperatureRange = [0, 4]; gas.densityRange = [0, 8];
    for (const name of coefficients) {
      gas[`${name}ByTemperature`] = [1, 3]; gas[`${name}ByDensity`] = [2, 4];
    }
    gas.syncBehaviorParameters();
    const evaluate = Fn(() => {
      // density 4 and heat mass 8 mean physical temperature 2: both normalized parameters are 0.5.
      const state = gas.behaviorState(vec4(4, 8, 0, 0), coefficients);
      coefficients.forEach((name, i) => output.element(uint(i)).assign(vec4(
        gas.effectiveBehavior(name, float(2), state), 0, 0, 0)));
    })().compute(1);
    renderer.compute(evaluate);
    const products = [...await read(outputAttribute)].filter((_value, i) => i % 4 === 0);
    gas.densityDissipationByTemperature = [-2, -2]; gas.syncBehaviorParameters();
    renderer.compute(evaluate);
    const nonnegative = (await read(outputAttribute))[2 * 4];
    for (const name of coefficients) {
      gas[`${name}ByTemperature`] = undefined; gas[`${name}ByDensity`] = undefined;
    }
    gas.syncBehaviorParameters();
    const inactive = gas.behaviorState(vec4(4, 8, 0, 0), coefficients);

    // Exercise the real transport/decay kernels with no motion, sources, diffusion or boundary absorption.
    const decay = async (steps, dt, modulated) => {
      const modifier = value => modulated === 'curve' ? () => value : modulated ? [value, value] : undefined;
      gas.densityDissipationByTemperature = modifier(2);
      gas.temperatureDissipationByDensity = modifier(3);
      gas.colorDissipationByTemperature = modifier(0.5);
      gas.syncSimulationUniforms(); context.deltaTimeNode.value = dt;
      renderer.compute(gas.computeCells(index => {
        gas.densityCurrent.element(index).assign(vec4(4, 8, 0, 0));
        gas.colorCurrent.element(index).assign(vec4(2, 2, 2, 0));
        gas.velocityCurrent.element(index).assign(vec4(0));
      }));
      for (let step = 0; step < steps; step++) gas.computeTransport(context, renderer, grid);
      // computeTransport swaps current/next scalar identities, so read the selected storage value.
      return { density: [...await read(gas.densityCurrent.value)], color: [...await read(gas.colorCurrent.value)] };
    };
    const modules = [], device = renderer.backend.device;
    const createShader = device.createShaderModule.bind(device);
    device.createShaderModule = descriptor => {
      modules.push(descriptor.code);
      return createShader(descriptor);
    };
    const base = await decay(1, 0.2, false);
    const inactiveShaderWork = modules.some(code => code.includes('gasBehaviorTemperature')
      || code.includes('gasBehaviorDensity'));
    modules.length = 0;
    const modulated = await decay(1, 0.2, true);
    const curved = await decay(1, 0.2, 'curve');
    const substepped = await decay(2, 0.1, true);
    device.createShaderModule = createShader;

    gas.velocityPaddingLookahead = 0.5;
    const rollingPadding = (await gas.readAutomaticPadding(renderer, grid, new THREE.Vector3(3, 3, 3))).toArray();
    const occupiedSize = gas.occupiedGasBounds.getSize(new THREE.Vector3()).toArray();

    // Renderer masks can differ by temperature without changing physical noise or resampling the field.
    const volume = new api.VolumeRenderer({ densityNoiseStrength: 1, densityNoiseFrequency: 0,
      densityNoiseStrengthByTemperature: [0, 2] });
    volume.gpuAppearanceRanges[0].value.set(0, 1);
    const maskNode = Fn(() => {
      [0, 0.5, 1].forEach((heat, i) => output.element(uint(i)).assign(vec4(
        volume.modulateDensity(tsl.vec3(0), float(1), float(heat)), 0, 0, 0)));
    })().compute(1);
    renderer.compute(maskNode);
    const maskValues = await read(outputAttribute);
    const masks = [0, 4, 8].map(i => maskValues[i]);
    volume.destroy(); maskNode.dispose();

    // GUI code must preserve the derived class and every behavior curve.
    const transform = new api.TransformByNoise({ strength: new THREE.Vector3(0.35, 0.12, 0.35), frequency: 1.8 });
    const exported = new api.ParticleSystem({ emitters: [], renderers: [], modules: [gas, transform] });
    gas.collisionOptions = { surfaceThickness: 0.02, bakedFieldResolution: 32 };
    let advectionControls = 0;
    const controller = { name() { return this; }, disable() { return this; }, listen() { return this; },
      onChange() { return this; } };
    const folder = { add(_object, key) {
      if (key === 'advectionMethod') advectionControls++;
      return controller;
    }, addFolder() { return this; }, close() {} };
    const editor = Object.create(ModuleGUI.prototype);
    Object.assign(editor, { addTags() {}, addValue() {}, prettyName: value => value, emitCode() {} });
    editor.buildModule(folder, gas, exported);
    const serializer = new ParticleSystemSerializer({ system: exported });
    const code = serializer.serializeParticleSystem();
    const names = code.match(/import \{ (.+) \} from '@rzmps\/rzmps'/)[1].split(', ');
    const body = code.replace(/^import .*;$/gm, '').replace('export default particleSystem;', 'return particleSystem;');
    const restored = Function('THREE', ...names, body)(THREE, ...names.map(name => api[name]));
    const roundTrip = { codeHasNoiseBase: code.includes('new NoiseModule('),
      transform: restored.modules[1].constructor.name, strength: restored.modules[1].options.strength.toArray(),
      curve: restored.modules[0].densityDissipationByTemperature,
      collision: restored.modules[0].collisionOptions, range: restored.modules[0].temperatureRange };
    restored.destroy(); exported.destroy(); owner.destroy(); evaluate.dispose();
    return { products, nonnegative, inactiveShaderWork, inactive: Object.keys(inactive),
      base, modulated, curved, substepped, roundTrip, rollingPadding, occupiedSize, masks, advectionControls };
  }, { library: `/@fs${path.resolve('packages/rzmps/build/index.mjs')}`,
    serializerPath: `/@fs${path.resolve('apps/demo/src/gui/particle-system-gui/ParticleSystemSerializer.js')}`,
    moduleGUIPath: `/@fs${path.resolve('apps/demo/src/gui/particle-system-gui/ModuleGUI.js')}` });
  result.products.forEach(value => assert(Math.abs(value - 12) < 1e-6));
  assert.equal(result.nonnegative, 0);
  assert.equal(result.advectionControls, 1);
  assert.deepEqual(result.rollingPadding, [1.5, 1.5, 1.5], 'prediction uses a half-second horizon');
  assert.deepEqual(result.occupiedSize, [4, 4, 4]);
  for (const [i, expected] of [1, 0.5, 0.25].entries()) {
    assert(Math.abs(result.masks[i] - expected) < 1e-6, 'temperature-dependent masks and zero-strength bypass');
  }
  assert.deepEqual(result.inactive, []);
  assert.equal(result.inactiveShaderWork, false);
  const cell = 1 + 4 * (1 + 4);
  for (const [name, densityRate, heatRate, colorRate] of [['base', 0.2, 0.4, 0.3], ['modulated', 0.4, 1.2, 0.15]]) {
    assert(Math.abs(result[name].density[cell * 4] - 4 * Math.exp(-densityRate * 0.2)) < 1e-4, name);
    assert(Math.abs(result[name].density[cell * 4 + 1] - 8 * Math.exp(-(densityRate + heatRate) * 0.2)) < 1e-4, name);
    assert(Math.abs(result[name].color[cell * 4] - 2 * Math.exp(-colorRate * 0.2)) < 1e-4, name);
  }
  for (const key of ['density', 'color']) for (const channel of [0, 1, 2]) {
    assert(Math.abs(result.modulated[key][cell * 4 + channel]
      - result.substepped[key][cell * 4 + channel]) < 1e-4, `${key} decay is timestep independent`);
    assert(Math.abs(result.modulated[key][cell * 4 + channel]
      - result.curved[key][cell * 4 + channel]) < 1e-4, `${key} supports live array/function changes`);
  }
  assert.equal(result.roundTrip.codeHasNoiseBase, false);
  assert.equal(result.roundTrip.transform, 'TransformByNoise');
  assert.deepEqual(result.roundTrip.strength, [0.35, 0.12, 0.35]);
  assert.deepEqual(result.roundTrip.curve, [2, 2]);
  assert.deepEqual(result.roundTrip.collision, { surfaceThickness: 0.02, bakedFieldResolution: 32 });
  assert.deepEqual(result.roundTrip.range, [0, 4]);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ products: result.products, nonnegative: result.nonnegative,
    roundTrip: result.roundTrip, decay: 'base/modulated and timestep split passed' }));
} finally { await browser?.close(); await site.close(); }
