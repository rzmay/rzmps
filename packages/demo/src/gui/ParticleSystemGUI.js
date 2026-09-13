import GUI from 'lil-gui';
import { Fragment, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { GitFork, Package } from 'lucide-react';
import * as THREE from 'three';

import {
    Emitter,
    EmissionShape,
    EmissionSource,
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
    TrailMode,
    TrailTextureMode,
    Collision,
    EndBehavior,
} from '@rzmps/rzmps';

const RESOURCE_LINKS = [
    { label: 'GitHub', href: 'https://github.com/rzmay/rzmps', Icon: GitFork },
    { label: 'npm', href: 'https://www.npmjs.com/package/@rzmps/rzmps', Icon: Package },
];

const INITIAL_VALUE_DEFAULTS = {
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
const DEFAULT_MODULE_FACTORIES = {
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
    // ExternalForces needs project-owned force fields, so it starts empty.
    'External Forces': () => new ExternalForces({ forceFields: [], multiplier: 1 }),
    'Collision': () => new Collision(),
};
const DEFAULT_RENDERER_FACTORIES = {
    Sprite: () => new SpriteRenderer(),
    Mesh: () => new MeshRenderer(),
    Light: () => new LightRenderer(),
    Trail: () => new TrailRenderer(),
};
const END_BEHAVIOR_OPTIONS = EndBehavior;
export class ParticleSystemGUI {
    constructor(options) {
        this.presetLoadVersion = 0;
        this.sceneLoadVersion = 0;
        this.system = options.system;
        this.scene = options.scene;
        this.presets = options.presets ?? {};
        this.scenes = options.scenes ?? {};
        this.moduleFactories = { ...DEFAULT_MODULE_FACTORIES, ...options.moduleFactories };
        this.rendererFactories = { ...DEFAULT_RENDERER_FACTORIES, ...options.rendererFactories };
        this.subSystemFactories = options.subSystemFactories ?? {};
        this.onSystemChange = options.onSystemChange;
        this.onPresetChange = options.onPresetChange;
        this.onSceneChange = options.onSceneChange;
        this.onCodeChange = options.onCodeChange;
        this.onShowCodeChange = options.onShowCodeChange;
        this.currentPresetName = options.initialPreset;
        this.currentSceneName = options.initialScene;
        this.handleSystemDestroyed = () => {
            this.rebuild();
            this.emitCode();
        };
        this.system.addEventListener?.('destroyed', this.handleSystemDestroyed);
        this.gui = new GUI({
            title: options.title ?? 'Particle System',
            width: options.width ?? 360,
            container: options.container,
        });
        this.injectStyles();
        this.gui.onChange(() => this.emitCode());
        this.addResourceLinks();
        if (this.onShowCodeChange) {
            const viewState = { showCode: false };
            this.gui
                .add(viewState, 'showCode')
                .name('Show code')
                .onChange(this.onShowCodeChange);
        }
        this.rebuild();
        if (this.currentSceneName)
            void this.setScene(this.currentSceneName);
        this.emitCode();
    }
    get particleSystem() {
        return this.system;
    }
    setSystem(next, presetName) {
        if (next === this.system)
            return;
        this.currentPresetName = presetName;
        const previous = this.system;
        previous.removeEventListener?.('destroyed', this.handleSystemDestroyed);
        if (this.scene) {
            if (previous.parent === this.scene)
                this.scene.remove(previous);
            this.scene.add(next);
        }
        this.system = next;
        this.system.addEventListener?.('destroyed', this.handleSystemDestroyed);
        this.onSystemChange?.(next, previous);
        this.onPresetChange?.(presetName);
        this.rebuild();
        this.emitCode();
    }
    refresh() {
        this.rebuild();
        this.emitCode();
    }
    generateCode() {
        return this.serializeParticleSystem();
    }
    destroy() {
        this.sceneCleanup?.();
        this.system.removeEventListener?.('destroyed', this.handleSystemDestroyed);
        this.resourceLinksRoot?.unmount();
        this.gui.destroy();
    }
    addResourceLinks() {
        const container = document.createElement('div');
        container.className = 'psgui-resource-links';
        this.gui.domElement.appendChild(container);
        this.resourceLinksRoot = createRoot(container);
        this.resourceLinksRoot.render(createElement(
            Fragment,
            null,
            RESOURCE_LINKS.map(({ label, href, Icon }) => createElement(
                'a',
                {
                    key: label,
                    className: 'psgui-resource-link',
                    href,
                    target: '_blank',
                    rel: 'noreferrer',
                    title: label,
                    'aria-label': label,
                },
                createElement(Icon, { size: 15, strokeWidth: 2 }),
                createElement('span', null, label),
            )),
        ));
    }
    rebuild() {
        this.contentFolder?.destroy();
        this.contentFolder = this.gui.addFolder('Editor');
        this.contentFolder.open();
        this.buildDemoSelectors(this.contentFolder);
        this.buildSystemFolder(this.contentFolder, this.system);
        if (this.isSystemDestroyed(this.system))
            return;
        this.buildEmittersFolder(this.contentFolder, this.system);
        this.buildSubSystemsFolder(this.contentFolder, this.system);
        this.buildModulesFolder(this.contentFolder, this.system);
        this.buildRenderersFolder(this.contentFolder, this.system);
    }
    isSystemDestroyed(system) {
        return !!system.destroyed;
    }
    disableFolder(folder) {
        folder.controllersRecursive().forEach((controller) => controller.disable?.());
    }
    async respawnSystem() {
        if (!this.currentPresetName || !this.presets[this.currentPresetName])
            return;
        const version = ++this.presetLoadVersion;
        const next = await this.presets[this.currentPresetName]();
        if (version !== this.presetLoadVersion)
            return;
        this.setSystem(next, this.currentPresetName);
    }
    buildDemoSelectors(root) {
        if (Object.keys(this.presets).length === 0 && Object.keys(this.scenes).length === 0)
            return;
        const folder = root.addFolder('Demo');
        folder.domElement.classList.add('psgui-section', 'psgui-demo');
        const presetNames = Object.keys(this.presets);
        if (presetNames.length > 0) {
            const state = { preset: this.currentPresetName ?? '(current)' };
            folder.add(state, 'preset', ['(current)', ...presetNames]).name('Preset').onChange(async (name) => {
                if (name === '(current)')
                    return;
                const version = ++this.presetLoadVersion;
                const next = await this.presets[name]();
                if (version !== this.presetLoadVersion)
                    return;
                this.setSystem(next, name);
            });
        }
        const sceneNames = Object.keys(this.scenes);
        if (sceneNames.length > 0 && this.scene) {
            const state = { scene: this.currentSceneName ?? '(current)' };
            folder.add(state, 'scene', ['(current)', ...sceneNames]).name('Scene').onChange((name) => {
                if (name !== '(current)')
                    void this.setScene(name);
            });
        }
    }
    async setScene(name) {
        if (!this.scene || !this.scenes[name])
            return;
        const version = ++this.sceneLoadVersion;
        this.sceneCleanup?.();
        this.sceneCleanup = undefined;
        this.currentSceneName = name;
        this.onSceneChange?.(name);
        const cleanup = await this.scenes[name](this.scene);
        if (version !== this.sceneLoadVersion) {
            if (typeof cleanup === 'function')
                cleanup();
            return;
        }
        if (typeof cleanup === 'function')
            this.sceneCleanup = cleanup;
    }
    buildSystemFolder(root, system = this.system) {
        const folder = root.addFolder('System');
        folder.domElement.classList.add('psgui-system');
        const destroyed = this.isSystemDestroyed(system);
        folder.add(system, 'simulationSpace', ['local', 'world']).name('Simulation Space');
        this.addVector3(folder, system.gravity, 'Gravity');
        this.addDynamicValue(folder, system, 'gravityModifier', 'Gravity Modifier');
        folder.add(system, 'simulationSpeed', 0, 4, 0.01).name('Simulation Speed');
        folder.add(system, 'duration', 0.01).name('Duration');
        folder.add(system, 'looping').name('Looping');
        folder.add(system, 'endBehavior', END_BEHAVIOR_OPTIONS).name('End Behavior');
        const actions = {
            start: () => system.start(),
            pause: () => system.pause(),
            resume: () => {
                if (system.resume) system.resume();
                else system.start();
            },
            stop: () => system.stop(false),
            stopAndClear: () => system.stop(true),
            clearParticles: () => system.clearParticles(),
            respawn: () => void this.respawnSystem(),
        };
        folder.add(actions, 'start').name('Start / Restart');
        folder.add(actions, 'pause').name('Pause');
        folder.add(actions, 'resume').name('Resume');
        folder.add(actions, 'stop').name('Stop');
        folder.add(actions, 'stopAndClear').name('Stop + Clear');
        folder.add(actions, 'clearParticles').name('Clear Particles');
        if (destroyed) {
            this.disableFolder(folder);
            const respawn = folder.add(actions, 'respawn').name('Respawn');
            if (!this.currentPresetName || !this.presets[this.currentPresetName])
                respawn.disable?.();
        }
    }
    buildEmittersFolder(root, system = this.system) {
        const section = root.addFolder(`Emitters (${system.emitters.length})`);
        section.domElement.classList.add('psgui-section', 'psgui-emitters');
        section.open();
        system.emitters.forEach((emitter, index) => {
            const folder = section.addFolder(`${index + 1}. ${emitter.constructor.name}`);
            this.buildEmitter(folder, emitter, system);
        });
        const actions = {
            addEmitter: () => {
                system.addEmitter(new Emitter());
                this.rebuild();
                this.emitCode();
            },
        };
        section.add(actions, 'addEmitter').name('+ Add Emitter');
    }
    buildEmitter(folder, emitter, system = this.system) {
        this.addDynamicValue(folder, emitter, 'rate', 'Rate');
        this.addDynamicValue(folder, emitter, 'radialSpeed', 'Radial Speed');
        this.addDynamicValue(folder, emitter, 'alignment', 'Alignment');
        this.addTags(folder, emitter);
        folder.add(emitter, 'tagSelection', ['all', 'random', 'distribute']).name('Tag Selection');
        this.buildEmissionShape(folder.addFolder('Emission Shape'), emitter);
        this.buildInitialValues(folder.addFolder('Initial Values'), emitter);
        this.buildBursts(folder.addFolder(`Bursts (${emitter.bursts.length})`), emitter);
        const actions = {
            remove: () => {
                system.removeEmitter(emitter);
                this.rebuild();
                this.emitCode();
            },
        };
        folder.add(actions, 'remove').name('Remove Emitter');
    }
    buildEmissionShape(folder, emitter) {
        const geometry = emitter.source.geometry;
        const params = geometry.parameters ?? {};
        const shape = this.geometryShapeName(geometry);
        const state = {
            shape,
            source: emitter.source.source,
            width: params.width ?? 1,
            height: params.height ?? 1,
            depth: params.depth ?? 1,
            radius: params.radius ?? 1,
            radialSegments: params.radialSegments ?? 16,
            heightSegments: params.heightSegments ?? 8,
            tube: params.tube ?? 0.4,
            tubularSegments: params.tubularSegments ?? 32,
            arc: params.arc ?? Math.PI * 2,
        };
        folder.add(state, 'shape', ['Box', 'Sphere', 'Cone', 'Torus']).name('Shape').onChange(() => {
            this.replaceEmitterShape(emitter, state);
            this.rebuild();
        });
        folder.add(state, 'source', {
            Volume: EmissionSource.Volume,
            Surface: EmissionSource.Surface,
            Vertices: EmissionSource.Vertices,
        }).name('Source').onChange((value) => {
            emitter.source.source = Number(value);
        });
        const rebuildShape = () => this.replaceEmitterShape(emitter, state);
        if (shape === 'Box') {
            folder.add(state, 'width', 0.01).onChange(rebuildShape);
            folder.add(state, 'height', 0.01).onChange(rebuildShape);
            folder.add(state, 'depth', 0.01).onChange(rebuildShape);
        }
        else if (shape === 'Sphere') {
            folder.add(state, 'radius', 0.01).onChange(rebuildShape);
            folder.add(state, 'radialSegments', 3, 64, 1).onFinishChange(rebuildShape);
            folder.add(state, 'heightSegments', 2, 64, 1).onFinishChange(rebuildShape);
        }
        else if (shape === 'Cone') {
            folder.add(state, 'radius', 0.01).onChange(rebuildShape);
            folder.add(state, 'height', 0.01).onChange(rebuildShape);
            folder.add(state, 'radialSegments', 3, 64, 1).onFinishChange(rebuildShape);
        }
        else if (shape === 'Torus') {
            folder.add(state, 'radius', 0.01).onChange(rebuildShape);
            folder.add(state, 'tube', 0.001).onChange(rebuildShape);
            folder.add(state, 'radialSegments', 3, 64, 1).onFinishChange(rebuildShape);
            folder.add(state, 'tubularSegments', 3, 128, 1).onFinishChange(rebuildShape);
            folder.add(state, 'arc', 0, Math.PI * 2).onChange(rebuildShape);
        }
    }
    replaceEmitterShape(emitter, state) {
        const source = Number(state.source);
        let shape;
        switch (state.shape) {
            case 'Box':
                shape = EmissionShape.Box(Number(state.width), Number(state.height), Number(state.depth));
                break;
            case 'Cone':
                shape = EmissionShape.Cone(Number(state.radius), Number(state.height), Number(state.radialSegments));
                break;
            case 'Torus':
                shape = EmissionShape.Torus(Number(state.radius), Number(state.tube), Number(state.radialSegments), Number(state.tubularSegments), Number(state.arc));
                break;
            default:
                shape = EmissionShape.Sphere(Number(state.radius), Number(state.radialSegments), Number(state.heightSegments));
                break;
        }
        shape.source = source;
        emitter.source = shape;
    }
    buildInitialValues(folder, emitter) {
        const initial = emitter.initialValues;
        Object.keys(initial).forEach((key) => {
            this.addDynamicValue(folder, initial, key, this.prettyName(key));
        });
        const missing = Object.keys(INITIAL_VALUE_DEFAULTS).filter((key) => !(key in initial));
        if (missing.length > 0) {
            const state = { parameter: missing[0] };
            folder.add(state, 'parameter', missing).name('New Parameter');
            const actions = {
                add: () => {
                    initial[state.parameter] = INITIAL_VALUE_DEFAULTS[state.parameter]();
                    this.rebuild();
                    this.emitCode();
                },
            };
            folder.add(actions, 'add').name('+ Add Parameter');
        }
    }
    buildBursts(folder, emitter) {
        emitter.bursts.forEach((burst, index) => {
            const item = folder.addFolder(`Burst ${index + 1}`);
            item.add(burst, 'time', 0, 1).name('Time');
            this.addDynamicValue(item, burst, 'count', 'Count');
            const actions = {
                remove: () => {
                    emitter.bursts.splice(index, 1);
                    this.rebuild();
                    this.emitCode();
                },
            };
            item.add(actions, 'remove').name('Remove');
        });
        const actions = {
            add: () => {
                emitter.bursts.push({ time: 0, count: 10 });
                this.rebuild();
                this.emitCode();
            },
        };
        folder.add(actions, 'add').name('+ Add Burst');
    }
    buildSubSystemsFolder(root, system = this.system) {
        const entries = Array.from(system.subSystems?.entries?.() ?? []);
        const section = root.addFolder(`Sub Systems (${entries.length})`);
        section.domElement.classList.add('psgui-section', 'psgui-subsystems');
        section.open();

        entries.forEach(([subSystem, options], index) => {
            const label = subSystem.name || subSystem.constructor.name || `Sub System ${index + 1}`;
            const folder = section.addFolder(`${index + 1}. ${label}`);
            this.buildSubSystem(folder, subSystem, options, system);
        });

        const names = Object.keys(this.subSystemFactories);
        if (names.length > 0) {
            const state = { type: names[0] };
            section.add(state, 'type', names).name('Sub System Type');
            const actions = {
                add: async () => {
                    const subSystem = await this.subSystemFactories[state.type]();
                    system.addSubSystem(subSystem);
                    this.rebuild();
                    this.emitCode();
                },
            };
            section.add(actions, 'add').name('+ Add Sub System');
        }
    }

    buildSubSystem(folder, subSystem, options, parentSystem = this.system) {
        const shouldEmitIsFunction = typeof options.shouldEmit === 'function';
        if (shouldEmitIsFunction) {
            const state = { shouldEmit: 'ƒ(particle) — function driven' };
            folder.add(state, 'shouldEmit').name('Should Emit').disable();
        } else {
            folder.add(options, 'shouldEmit').name('Should Emit');
        }

        folder.add(options, 'ratio', 0, 1).name('Ratio');
        folder.add(options, 'emitContinuous').name('Emit Continuous');
        folder.add(options, 'emitOnCollision').name('Emit On Collision');
        folder.add(options, 'emitOnSpawn').name('Emit On Spawn');
        folder.add(options, 'emitOnDeath').name('Emit On Death');
        folder.add(options, 'inheritScale').name('Inherit Scale');
        folder.add(options, 'inheritLifetime').name('Inherit Lifetime');
        folder.add(options, 'inheritColor').name('Inherit Color');
        folder.add(options, 'inheritAlpha').name('Inherit Alpha');
        folder.add(options, 'inheritMass').name('Inherit Mass');

        const info = {
            particles: subSystem.particles.length,
            emitters: subSystem.emitters.length,
            modules: subSystem.modules.length,
            renderers: subSystem.renderers.length,
        };
        const infoFolder = folder.addFolder('Contents');
        infoFolder.add(info, 'emitters').name('Emitters').disable();
        infoFolder.add(info, 'modules').name('Modules').disable();
        infoFolder.add(info, 'renderers').name('Renderers').disable();
        infoFolder.add(info, 'particles').name('Current Particles').disable().listen();

        const actions = {
            remove: () => {
                parentSystem.removeSubSystem(subSystem);
                this.rebuild();
                this.emitCode();
            },
        };

        const editor = folder.addFolder('Editor');
        this.buildSystemFolder(editor, subSystem);
        this.buildEmittersFolder(editor, subSystem);
        this.buildSubSystemsFolder(editor, subSystem);
        this.buildModulesFolder(editor, subSystem);
        this.buildRenderersFolder(editor, subSystem);

        folder.add(actions, 'remove').name('Remove Sub System');
    }

    buildModulesFolder(root, system = this.system) {
        const section = root.addFolder(`Modules (${system.modules.length})`);
        section.domElement.classList.add('psgui-section', 'psgui-modules');
        section.open();
        system.modules.forEach((module, index) => {
            const folder = section.addFolder(`${index + 1}. ${module.constructor.name}`);
            this.buildModule(folder, module, system);
        });
        const names = Object.keys(this.moduleFactories);
        const state = { type: names[0] };
        section.add(state, 'type', names).name('Module Type');
        const actions = {
            add: () => {
                system.addModule(this.moduleFactories[state.type]());
                this.rebuild();
                this.emitCode();
            },
        };
        section.add(actions, 'add').name('+ Add Module');
    }
    buildModule(folder, module, system = this.system) {
        this.addTags(folder, module);
        const candidate = module;
        if (candidate.options && typeof candidate.options === 'object') {
            this.addObject(folder, candidate.options, new Set(['tags']));
        }
        else {
            const hidden = new Set([
                'modify',
                'noiseGenerator',
                'dependents',
                'priority',
                'backend',
                'collisionListeners',
                'tags',
            ]);
            Object.keys(candidate)
                .filter((key) => !key.startsWith('_') && !hidden.has(key))
                .forEach((key) => this.addValue(folder, candidate, key, this.prettyName(key)));
        }
        const actions = {
            remove: () => {
                system.removeModule(module);
                this.rebuild();
                this.emitCode();
            },
        };
        folder.add(actions, 'remove').name('Remove Module');
    }
    buildRenderersFolder(root, system = this.system) {
        const section = root.addFolder(`Renderers (${system.renderers.length})`);
        section.domElement.classList.add('psgui-section', 'psgui-renderers');
        section.open();
        system.renderers.forEach((renderer, index) => {
            const folder = section.addFolder(`${index + 1}. ${renderer.constructor.name}`);
            this.buildRenderer(folder, renderer, system);
        });
        const names = Object.keys(this.rendererFactories);
        const state = { type: names[0] };
        section.add(state, 'type', names).name('Renderer Type');
        const actions = {
            add: () => {
                const renderer = this.rendererFactories[state.type]();
                system.addRenderer(renderer);
                this.rebuild();
                this.emitCode();
            },
        };
        section.add(actions, 'add').name('+ Add Renderer');
    }
    buildRenderer(folder, renderer, system = this.system) {
        this.addTags(folder, renderer);

        if (renderer instanceof SpriteRenderer) {
            this.buildSpriteRenderer(folder, renderer);
        } else if (renderer instanceof LightRenderer) {
            this.buildLightRenderer(folder, renderer);
        } else if (renderer instanceof MeshRenderer) {
            this.buildMeshRenderer(folder, renderer);
        } else if (renderer instanceof TrailRenderer) {
            this.buildTrailRenderer(folder, renderer);
        } else {
            this.addObject(folder, renderer, new Set([
                'setup',
                'update',
                'destroy',
                'mesh',
                'geometry',
                'material',
                'tags',
            ]));
        }

        const actions = {
            remove: () => {
                system.removeRenderer(renderer);
                this.rebuild();
                this.emitCode();
            },
        };
        folder.add(actions, 'remove').name('Remove Renderer');
    }
    buildSpriteRenderer(folder, renderer) {
        this.addDynamicValue(folder, renderer, 'fps', 'FPS');
        folder.add(renderer, 'castShadow').name('Cast Shadow');
        folder.add(renderer, 'softParticleDistance', 0).name('Soft Particle Distance');
        folder.add(renderer, 'frames').min(1).step(1).name('Frames').onFinishChange(() => this.reloadSpriteMaterial(renderer));
        const materialState = { material: renderer.materialType };
        folder.add(materialState, 'material', ['unlit', 'basic']).name('Material').onChange((value) => {
            renderer.materialType = value;
            this.reloadSpriteMaterial(renderer);
        });
        this.addVector2(folder.addFolder('Grid Size'), renderer.gridSize, 'Grid', () => this.reloadSpriteMaterial(renderer));
        this.addVector2(folder.addFolder('Tile Size'), renderer.tileSize, 'Tile');
        this.addVector2(folder.addFolder('Tile Margin'), renderer.tileMargin, 'Margin');
        const info = {
            texture: renderer.texture?.name || renderer.texture?.uuid || '(texture)',
            alphaMap: renderer.alphaMap?.name || renderer.alphaMap?.uuid || '(none)',
        };
        folder.add(info, 'texture').name('Texture').disable();
        folder.add(info, 'alphaMap').name('Alpha Map').disable();
    }
    buildLightRenderer(folder, renderer) {
        this.addDynamicValue(folder, renderer, 'brightness', 'Brightness');
        this.addDynamicValue(folder, renderer, 'rangeMultiplier', 'Range Multiplier');
        folder.add(renderer, 'groupingRadiusRatio', 0).name('Grouping Radius');
        folder.add(renderer, 'decay', 0).name('Decay');
        folder.add(renderer, 'count').min(0).step(1).name('Max Lights');
        folder.add(renderer, 'ratio', 0, 1).name('Particle Ratio');
        folder.add(renderer, 'randomDistribution').name('Random Distribution');
        folder.add(renderer, 'inheritParticleColor').name('Inherit Particle Color');
        folder.add(renderer, 'sizeAffectsRange').name('Size Affects Range');
        folder.add(renderer, 'alphaAffectsIntensity').name('Alpha Affects Intensity');
        const lightOptions = folder.addFolder('Point Light');
        const lightState = {
            color: `#${new THREE.Color(renderer.lightOptions.color ?? 0xffffff).getHexString()}`,
            intensity: renderer.lightOptions.intensity ?? 1,
            distance: renderer.lightOptions.distance ?? 0,
            decay: renderer.lightOptions.decay ?? renderer.decay,
            power: renderer.lightOptions.power ?? 0,
        };
        lightOptions.addColor(lightState, 'color').name('Color').onChange((value) => {
            renderer.lightOptions.color = value;
        });
        lightOptions.add(lightState, 'intensity', 0).name('Intensity').onChange((value) => {
            renderer.lightOptions.intensity = value;
        });
        lightOptions.add(lightState, 'distance', 0).name('Distance').onChange((value) => {
            renderer.lightOptions.distance = value;
        });
        lightOptions.add(lightState, 'decay', 0).name('Decay').onChange((value) => {
            renderer.lightOptions.decay = value;
        });
        lightOptions.add(lightState, 'power', 0).name('Power').onChange((value) => {
            renderer.lightOptions.power = value;
        });
    }
    buildMeshRenderer(folder, renderer) {
        const info = {
            mesh: renderer.mesh.name || renderer.mesh.uuid,
            geometry: renderer.mesh.geometry.type,
            material: Array.isArray(renderer.mesh.material)
                ? `${renderer.mesh.material.length} materials`
                : renderer.mesh.material.type,
            capacity: renderer.instances.instanceMatrix.count,
        };
        folder.add(info, 'mesh').name('Mesh').disable();
        folder.add(info, 'geometry').name('Geometry').disable();
        folder.add(info, 'material').name('Material').disable();
        folder.add(info, 'capacity').name('Capacity').disable();
        folder.add(renderer, 'castShadow').name('Cast Shadow');
        folder.add(renderer, 'receiveShadow').name('Receive Shadow');
    }
    buildTrailRenderer(folder, renderer) {
        const modeState = {
            mode: renderer.mode,
        };

        folder.add(modeState, 'mode', {
            Particle: TrailMode.Particle,
            Ribbon: TrailMode.Ribbon,
        }).name('Mode').onChange((value) => {
            renderer.mode = Number(value);
            this.rebuild();
        });

        folder.add(renderer, 'ratio', 0, 1).name('Ratio');

        this.addDynamicValue(
            folder,
            renderer,
            'lifetime',
            'Lifetime',
        );

        folder
            .add(renderer, 'minimumVertexDistance', 0)
            .name('Minimum Vertex Distance');

        folder
            .add(renderer, 'dieWithParticles')
            .name('Die With Particles');

        if (renderer.mode === TrailMode.Ribbon) {
            folder
                .add(renderer, 'ribbonCount', 1)
                .step(1)
                .name('Ribbon Count');
        }

        const textureState = {
            textureMode: renderer.textureMode,
        };

        folder.add(textureState, 'textureMode', {
            Stretch: TrailTextureMode.Stretch,
            Tile: TrailTextureMode.Tile,
            'Repeat Per Segment': TrailTextureMode.RepeatPerSegment,
            'Distribute Per Segment': TrailTextureMode.DistributePerSegment,
        }).name('Texture Mode').onChange((value) => {
            renderer.textureMode = Number(value);
        });

        this.addDynamicValue(
            folder,
            renderer,
            'width',
            'Width',
        );

        this.addDynamicValue(
            folder,
            renderer,
            'widthOverTrail',
            'Width Over Trail',
        );

        folder
            .add(renderer, 'sizeAffectsWidth')
            .name('Size Affects Width');

        folder
            .add(renderer, 'sizeAffectsLifetime')
            .name('Size Affects Lifetime');

        folder.add(renderer, 'castShadow').name('Cast Shadow');
        folder.add(renderer, 'receiveShadow').name('Receive Shadow');

        folder
            .add(renderer, 'inheritParticleColor')
            .name('Inherit Particle Color');

        this.addDynamicValue(
            folder,
            renderer,
            'colorOverLifetime',
            'Color Over Lifetime',
        );

        this.addDynamicValue(
            folder,
            renderer,
            'colorOverTrail',
            'Color Over Trail',
        );

        this.buildTrailMaterialFolder(
            folder.addFolder('Material'),
            renderer,
        );
    }
    buildTrailMaterialFolder(folder, renderer) {
        const materials = Array.isArray(renderer.material)
            ? renderer.material
            : [renderer.material];

        const material = materials[0];

        if (!material) {
            return;
        }

        const info = {
            type: material.type,
        };

        folder
            .add(info, 'type')
            .name('Type')
            .disable();

        if ('color' in material && material.color instanceof THREE.Color) {
            const state = {
                color: `#${material.color.getHexString()}`,
            };

            folder
                .addColor(state, 'color')
                .name('Color')
                .onChange((value) => {
                    material.color.set(value);
                });
        }

        if ('opacity' in material) {
            folder
                .add(material, 'opacity', 0, 1)
                .name('Opacity');
        }

        if ('roughness' in material) {
            folder
                .add(material, 'roughness', 0, 1)
                .name('Roughness');
        }

        if ('metalness' in material) {
            folder
                .add(material, 'metalness', 0, 1)
                .name('Metalness');
        }

        if (
            'emissive' in material
            && material.emissive instanceof THREE.Color
        ) {
            const state = {
                emissive: `#${material.emissive.getHexString()}`,
            };

            folder
                .addColor(state, 'emissive')
                .name('Emissive')
                .onChange((value) => {
                    material.emissive.set(value);
                });
        }

        if ('emissiveIntensity' in material) {
            folder
                .add(material, 'emissiveIntensity', 0)
                .name('Emissive Intensity');
        }

        if ('wireframe' in material) {
            folder
                .add(material, 'wireframe')
                .name('Wireframe');
        }
    }
    addTags(folder, object, label = 'Tags') {
        const state = {
            tags: object.tags?.join(', ') ?? '',
        };

        folder
            .add(state, 'tags')
            .name(label)
            .onFinishChange((value) => {
                const tags = String(value)
                    .split(',')
                    .map((tag) => tag.trim())
                    .filter(Boolean);

                object.tags = tags.length > 0 ? tags : undefined;
                this.emitCode();
            });
    }
    addObject(
        folder,
        object,
        hidden = new Set(),
        seen = new WeakSet(),
    ) {
        if (
            !object
            || typeof object !== 'object'
            || seen.has(object)
        ) {
            return;
        }

        seen.add(object);

        Object.keys(object)
            .filter(
                (key) =>
                    !key.startsWith('_')
                    && !hidden.has(key)
            )
            .forEach(
                (key) =>
                    this.addValue(
                        folder,
                        object,
                        key,
                        this.prettyName(key),
                        seen,
                    )
            );
    }
    addValue(
        folder,
        object,
        key,
        label,
        seen = new WeakSet(),
    ) {
        const value = object[key];
        if (typeof value === 'function') {
            const state = { value: 'ƒ(t) — function driven' };
            folder.add(state, 'value').name(label).disable();
            return;
        }
        if (value instanceof THREE.Vector3) {
            this.addVector3(folder.addFolder(label), value, label);
            return;
        }
        if (value instanceof THREE.Vector2) {
            this.addVector2(folder.addFolder(label), value, label);
            return;
        }
        if (value instanceof THREE.Color) {
            const state = { color: `#${value.getHexString()}` };
            folder.addColor(state, 'color').name(label).onChange((hex) => value.set(hex));
            return;
        }
        if (Array.isArray(value)) {
            const arrayFolder =
                folder.addFolder(label);

            value.forEach(
                (_, index) =>
                    this.addValue(
                        arrayFolder,
                        value,
                        String(index),
                        index === 0
                            ? 'Min / 0'
                            : 'Max / 1',
                        seen,
                    )
            );

            return;
        }
        if (value && typeof value === 'object') {
            if (seen.has(value)) {
                return;
            }

            this.addObject(
                folder.addFolder(label),
                value,
                new Set(),
                seen,
            );

            return;
        }
        if (typeof value === 'number') {
            folder.add(object, key).name(label);
        }
        else if (typeof value === 'boolean' || typeof value === 'string') {
            folder.add(object, key).name(label);
        }
        else if (value === undefined || value === null) {
            const state = { value: String(value) };
            folder.add(state, 'value').name(label).disable();
        }
    }
    addDynamicValue(folder, object, key, label) {
        const value = object[key];
        if (typeof value === 'function') {
            const state = { mode: 'Function', value: 'ƒ(t)' };
            folder.add(state, 'mode').name(`${label} Mode`).disable();
            folder.add(state, 'value').name(label).disable();
            return;
        }
        if (Array.isArray(value) && value.length === 2) {
            const sub = folder.addFolder(label);
            const state = { mode: 'Random Between' };
            sub.add(state, 'mode').name('Mode').disable();
            this.addValue(sub, value, '0', 'Min');
            this.addValue(sub, value, '1', 'Max');
            return;
        }
        this.addValue(folder, object, key, label);
    }
    addVector3(folder, vector, label) {
        folder.add(vector, 'x').name(`${label} X`);
        folder.add(vector, 'y').name(`${label} Y`);
        folder.add(vector, 'z').name(`${label} Z`);
    }
    addVector2(folder, vector, label, onFinishChange) {
        const x = folder.add(vector, 'x').name(`${label} X`);
        const y = folder.add(vector, 'y').name(`${label} Y`);
        if (onFinishChange) {
            x.onFinishChange(onFinishChange);
            y.onFinishChange(onFinishChange);
        }
    }
    reloadSpriteMaterial(renderer) {
        renderer.loadMaterial?.();
    }
    geometryShapeName(geometry) {
        if (geometry.type.includes('Box'))
            return 'Box';
        if (geometry.type.includes('Cone'))
            return 'Cone';
        if (geometry.type.includes('Torus'))
            return 'Torus';
        return 'Sphere';
    }
    emitCode() {
        this.onCodeChange?.(this.generateCode());
    }
    serializeParticleSystem() {
        const imports = new Set(['EndBehavior', 'ParticleSystem', 'Emitter', 'EmissionShape', 'EmissionSource']);
        this.collectImports(this.system, imports);

        const lines = [
            `import * as THREE from 'three';`,
            `import { ${Array.from(imports).sort().join(', ')} } from '@rzmps/rzmps';`,
            '',
        ];

        const counter = { value: 0 };
        const rootName = 'particleSystem';
        lines.push(...this.serializeParticleSystemTree(this.system, rootName, counter));
        lines.push('', `export default ${rootName};`, '');
        return lines.join('\n');
    }

    collectImports(system, imports) {
        system.modules.forEach((module) => imports.add(module.constructor.name));
        system.renderers.forEach((renderer) => imports.add(renderer.constructor.name));
        system.subSystems?.forEach((_options, subSystem) => this.collectImports(subSystem, imports));
    }

    serializeParticleSystemTree(system, variableName, counter) {
        const lines = this.serializeParticleSystemDeclaration(system, variableName);

        system.subSystems?.forEach((options, subSystem) => {
            counter.value += 1;
            const subName = `${variableName}SubSystem${counter.value}`;
            lines.push('');
            lines.push(...this.serializeParticleSystemTree(subSystem, subName, counter));
            lines.push(`${variableName}.addSubSystem(${subName}, ${this.serializeSubSystemOptions(options)});`);
        });

        return lines;
    }

    serializeParticleSystemDeclaration(system, variableName) {
        const emitters = system.emitters.map((emitter) => this.serializeEmitter(emitter)).join(',\n');
        const modules = system.modules.map((module) => this.serializeModule(module)).join(',\n');
        const renderers = system.renderers.map((renderer) => this.serializeRenderer(renderer)).join(',\n');
        const lines = [
            `const ${variableName} = new ParticleSystem({`,
            `  gravity: ${this.serializeValue(system.gravity)},`,
            `  gravityModifier: ${this.serializeValue(system.gravityModifier)},`,
            `  simulationSpace: ${JSON.stringify(system.simulationSpace)},`,
            `  simulationSpeed: ${this.serializeValue(system.simulationSpeed)},`,
            `  duration: ${this.serializeValue(system.duration)},`,
            `  looping: ${this.serializeValue(system.looping)},`,
            `  endBehavior: ${this.serializeEndBehavior(system.endBehavior)},`,
            '  emitters: [',
            this.indent(emitters, 4),
            '  ],',
            '  modules: [',
            this.indent(modules, 4),
            '  ],',
            '  renderers: [',
            this.indent(renderers, 4),
            '  ],',
            '});',
        ];

        if (system.name) lines.push(`${variableName}.name = ${JSON.stringify(system.name)};`);
        if (!system.position.equals(new THREE.Vector3())) {
            lines.push(`${variableName}.position.set(${system.position.x}, ${system.position.y}, ${system.position.z});`);
        }

        return lines;
    }
    serializeEndBehavior(value) {
        return `EndBehavior.${EndBehavior[value] ?? 'None'}`;
    }

    serializeSubSystemOptions(options) {
        return this.serializeValue({
            shouldEmit: options.shouldEmit,
            ratio: options.ratio,
            emitContinuous: options.emitContinuous,
            emitOnCollision: options.emitOnCollision,
            emitOnSpawn: options.emitOnSpawn,
            emitOnDeath: options.emitOnDeath,
            inheritScale: options.inheritScale,
            inheritLifetime: options.inheritLifetime,
            inheritColor: options.inheritColor,
            inheritAlpha: options.inheritAlpha,
            inheritMass: options.inheritMass,
        });
    }

    serializeEmitter(emitter) {
        const initialValues = this.serializeValue(emitter.initialValues);
        const bursts = this.serializeValue(emitter.bursts.map(({ time, count }) => ({ time, count })));
        return [
            'new Emitter({',
            `  source: ${this.serializeEmissionShape(emitter.source)},`,
            `  rate: ${this.serializeValue(emitter.rate)},`,
            `  radialSpeed: ${this.serializeValue(emitter.radialSpeed)},`,
            `  alignment: ${this.serializeValue(emitter.alignment)},`,
            `  tags: ${this.serializeValue(emitter.tags)},`,
            `  tagSelection: ${this.serializeValue(emitter.tagSelection)},`,
            `  bursts: ${bursts},`,
            `  initialValues: ${initialValues},`,
            '})',
        ].join('\n');
    }
    serializeEmissionShape(shape) {
        const geometry = shape.geometry;
        const params = geometry.parameters ?? {};
        let expression;
        if (geometry.type.includes('Box')) {
            expression = `EmissionShape.Box(${params.width ?? 1}, ${params.height ?? 1}, ${params.depth ?? 1})`;
        }
        else if (geometry.type.includes('Cone')) {
            expression = `EmissionShape.Cone(${params.radius ?? 1}, ${params.height ?? 1}, ${params.radialSegments ?? 16})`;
        }
        else if (geometry.type.includes('Torus')) {
            expression = `EmissionShape.Torus(${params.radius ?? 1}, ${params.tube ?? 0.4}, ${params.radialSegments ?? 16}, ${params.tubularSegments ?? 32}, ${params.arc ?? Math.PI * 2})`;
        }
        else {
            expression = `EmissionShape.Sphere(${params.radius ?? 1}, ${params.widthSegments ?? params.radialSegments ?? 16}, ${params.heightSegments ?? 8})`;
        }
        if (shape.source === EmissionSource.Volume)
            return expression;
        return `Object.assign(${expression}, { source: EmissionSource.${this.emissionSourceName(shape.source)} })`;
    }
    serializeModule(module) {
        if (module instanceof Collision) {
            return `new Collision(${this.serializeValue({
                dampen: module.dampen,
                bounce: module.bounce,
                lifetimeLoss: module.lifetimeLoss,
                applyImpulses: module.applyImpulses,
                radiusScale: module.radiusScale,
                minKillSpeed: module.minKillSpeed,
                maxKillSpeed: module.maxKillSpeed,
                tags: module.tags,
            })})`;
        }

        if (module instanceof NoiseModule) {
            const runtime = module;
            return `new NoiseModule(${JSON.stringify(runtime.key)}, ${this.serializeValue({
                octaves: runtime.octaves,
                frequency: runtime.frequency,
                lacunarity: runtime.lacunarity,
                persistence: runtime.persistence,
                time: runtime.time,
                offset: runtime.offset,
                tags: runtime.tags,
            })})`;
        }
        const runtime = module;
        const args = runtime.options !== undefined
            ? this.serializeValue({
                ...runtime.options,
                tags: runtime.tags,
            })
            : this.serializeValue(runtime);
        return `new ${module.constructor.name}(${args})`;
    }
    serializeRenderer(renderer) {
        if (renderer instanceof SpriteRenderer) {
            const texture = this.serializeTexture(renderer.texture);
            const options = this.serializeValue({
                fps: renderer.fps,
                tileSize: renderer.tileSize,
                tileMargin: renderer.tileMargin,
                gridSize: renderer.gridSize,
                frames: renderer.frames,
                castShadow: renderer.castShadow,
                softParticleDistance: renderer.softParticleDistance,
                tags: renderer.tags,
                alphaMap: renderer.alphaMap ? this.textureSource(renderer.alphaMap) : undefined,
                material: renderer.materialType,
                materialOptions: renderer.materialOptions,
            });
            return `new SpriteRenderer(${texture}, ${options})`;
        }
        if (renderer instanceof LightRenderer) {
            return `new LightRenderer(${this.serializeValue({
                brightness: renderer.brightness,
                rangeMultiplier: renderer.rangeMultiplier,
                groupingRadiusRatio: renderer.groupingRadiusRatio,
                decay: renderer.decay,
                count: renderer.count,
                ratio: renderer.ratio,
                randomDistribution: renderer.randomDistribution,
                inheritParticleColor: renderer.inheritParticleColor,
                sizeAffectsRange: renderer.sizeAffectsRange,
                alphaAffectsIntensity: renderer.alphaAffectsIntensity,
                tags: renderer.tags,
                lightOptions: renderer.lightOptions,
            })})`;
        }
        if (renderer instanceof MeshRenderer) {
            return `new MeshRenderer({\n  mesh: ${this.serializeMesh(renderer.mesh)},\n  maxParticles: ${renderer.instances.instanceMatrix.count},\n  castShadow: ${this.serializeValue(renderer.castShadow)},\n  receiveShadow: ${this.serializeValue(renderer.receiveShadow)},\n  tags: ${this.serializeValue(renderer.tags)},\n})`;
        }
        if (renderer instanceof TrailRenderer) {
            return [
                'new TrailRenderer({',
                `  mode: ${this.serializeValue(renderer.mode)},`,
                `  ratio: ${this.serializeValue(renderer.ratio)},`,
                `  lifetime: ${this.serializeValue(renderer.lifetime)},`,
                `  minimumVertexDistance: ${this.serializeValue(renderer.minimumVertexDistance)},`,
                `  dieWithParticles: ${this.serializeValue(renderer.dieWithParticles)},`,
                `  ribbonCount: ${this.serializeValue(renderer.ribbonCount)},`,
                `  textureMode: ${this.serializeValue(renderer.textureMode)},`,
                `  width: ${this.serializeValue(renderer.width)},`,
                `  widthOverTrail: ${this.serializeValue(renderer.widthOverTrail)},`,
                `  sizeAffectsWidth: ${this.serializeValue(renderer.sizeAffectsWidth)},`,
                `  sizeAffectsLifetime: ${this.serializeValue(renderer.sizeAffectsLifetime)},`,
                `  inheritParticleColor: ${this.serializeValue(renderer.inheritParticleColor)},`,
                `  castShadow: ${this.serializeValue(renderer.castShadow)},`,
                `  receiveShadow: ${this.serializeValue(renderer.receiveShadow)},`,
                `  tags: ${this.serializeValue(renderer.tags)},`,
                `  colorOverLifetime: ${this.serializeValue(renderer.colorOverLifetime)},`,
                `  colorOverTrail: ${this.serializeValue(renderer.colorOverTrail)},`,
                `  materialOptions: ${this.serializeMaterialOptions(renderer.material)},`,
                '})',
            ].join('\n');
        }
        return `new ${renderer.constructor.name}(${this.serializeValue(renderer)})`;
    }
    serializeMesh(mesh) {
        const geometry = mesh.geometry;
        const geometryCtor = geometry.type;
        const params = geometry.parameters;
        const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        const geometryExpression = params
            ? `new THREE.${geometryCtor}(${Object.values(params).map((value) => this.serializeValue(value)).join(', ')})`
            : `new THREE.BufferGeometry() /* replace with ${geometry.type} */`;
        const materialExpression = material
            ? `new THREE.${material.type}(${this.serializeMaterialOptions(material)})`
            : 'new THREE.MeshStandardMaterial()';
        return `new THREE.Mesh(${geometryExpression}, ${materialExpression})`;
    }
    serializeMaterialOptions(material) {
        if (!material) {
            return '{}';
        }

        const options = {};

        if (material.color) {
            options.color = material.color;
        }

        if (
            material.opacity !== undefined
            && material.opacity !== 1
        ) {
            options.opacity = material.opacity;
        }

        if (material.transparent) {
            options.transparent = true;
        }

        if (material.wireframe) {
            options.wireframe = true;
        }

        if (material.roughness !== undefined) {
            options.roughness = material.roughness;
        }

        if (material.metalness !== undefined) {
            options.metalness = material.metalness;
        }

        if (material.emissive) {
            options.emissive = material.emissive;
        }

        if (
            material.emissiveIntensity !== undefined
            && material.emissiveIntensity !== 1
        ) {
            options.emissiveIntensity =
                material.emissiveIntensity;
        }

        if (
            material.side !== undefined
            && material.side !== THREE.FrontSide
        ) {
            options.side = material.side;
        }

        if (!material.depthWrite) {
            options.depthWrite = false;
        }

        return this.serializeValue(options);
    }
    serializeTexture(texture) {
        const source = this.textureSource(texture);
        return source !== undefined
            ? JSON.stringify(source)
            : `undefined /* texture ${JSON.stringify(texture.name || texture.uuid)} must be supplied manually */`;
    }
    textureSource(texture) {
        const image = texture.image;
        return image?.currentSrc || image?.src || undefined;
    }
    serializeValue(value, seen = new WeakSet()) {
        if (value === undefined)
            return 'undefined';
        if (value === null)
            return 'null';
        if (typeof value === 'string')
            return JSON.stringify(value);
        if (typeof value === 'number' || typeof value === 'boolean')
            return String(value);
        if (typeof value === 'function')
            return value.toString();
        if (value instanceof THREE.Vector3)
            return `new THREE.Vector3(${value.x}, ${value.y}, ${value.z})`;
        if (value instanceof THREE.Vector2)
            return `new THREE.Vector2(${value.x}, ${value.y})`;
        if (value instanceof THREE.Color)
            return `new THREE.Color(${JSON.stringify(`#${value.getHexString()}`)})`;
        if (value instanceof THREE.Euler)
            return `new THREE.Euler(${value.x}, ${value.y}, ${value.z}, ${JSON.stringify(value.order)})`;
        if (Array.isArray(value)) {
            return `[${value.map((item) => this.serializeValue(item, seen)).join(', ')}]`;
        }
        if (typeof value === 'object') {
            if (seen.has(value))
                return 'undefined /* circular reference */';
            seen.add(value);
            const entries = Object.entries(value)
                .filter(([key]) => !key.startsWith('_'))
                .map(([key, item]) => `${this.serializeKey(key)}: ${this.serializeValue(item, seen)}`);
            seen.delete(value);
            return `{ ${entries.join(', ')} }`;
        }
        return 'undefined';
    }
    serializeKey(key) {
        return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
    }
    emissionSourceName(source) {
        if (source === EmissionSource.Surface)
            return 'Surface';
        if (source === EmissionSource.Vertices)
            return 'Vertices';
        return 'Volume';
    }
    indent(value, spaces) {
        if (!value)
            return '';
        const prefix = ' '.repeat(spaces);
        return value.split('\n').map((line) => `${prefix}${line}`).join('\n');
    }
    prettyName(value) {
        return value
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .replace(/^./, (c) => c.toUpperCase());
    }
    injectStyles() {
        const id = 'particle-system-gui-styles';
        if (document.getElementById(id))
            return;
        const style = document.createElement('style');
        style.id = id;
        style.textContent = `
      .lil-gui .psgui-section {
        margin-top: 10px;
        border-top: 3px solid rgba(255,255,255,.22);
        padding-top: 4px;
      }
      .lil-gui .psgui-emitters { border-top-color: #55aaff; }
      .lil-gui .psgui-subsystems { border-top-color: #4dd9c0; }
      .lil-gui .psgui-modules { border-top-color: #b980ff; }
      .lil-gui .psgui-renderers { border-top-color: #ff9d57; }
      .lil-gui .psgui-demo { border-top-color: #66d19e; }
      .lil-gui .psgui-system { margin-top: 6px; }
      .lil-gui .psgui-resource-links {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
        padding: 4px;
        border-bottom: 1px solid rgba(255,255,255,.12);
      }
      .lil-gui .psgui-resource-link {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        min-height: 28px;
        color: var(--text-color);
        background: rgba(255,255,255,.08);
        border-radius: 6px;
        font-size: 11px;
        text-decoration: none;
      }
      .lil-gui .psgui-resource-link:hover {
        background: rgba(255,255,255,.14);
      }
      .lil-gui .psgui-resource-link svg {
        flex: 0 0 auto;
      }
    `;
        document.head.appendChild(style);
    }
}
