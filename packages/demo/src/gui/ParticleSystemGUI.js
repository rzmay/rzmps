import GUI from 'lil-gui';
import { Fragment, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { GitFork, Package } from 'lucide-react';
import * as THREE from 'three';

import { createDefaultSceneBackground } from '../presets/scenes/background';
import { getSceneParticleRoot } from '../presets/scenes/particleRoot';
import { EndBehavior, MaxCulling } from '@rzmps/rzmps';

import { EmitterGUI } from './particle-system-gui/EmitterGUI';
import { ModuleGUI } from './particle-system-gui/ModuleGUI';
import { RendererGUI } from './particle-system-gui/RendererGUI';
import { GUIValueEditor } from './particle-system-gui/GUIValueEditor';
import { ParticleSystemSerializer } from './particle-system-gui/ParticleSystemSerializer';
import { DEFAULT_MODULE_FACTORIES, DEFAULT_RENDERER_FACTORIES } from './particle-system-gui/constants';

const SCENE_PARTICLE_SYSTEM_CONFIGURER_KEY = '__rzmps_configureParticleSystem';

const RESOURCE_LINKS = [
    { label: 'GitHub', href: 'https://github.com/rzmay/rzmps', Icon: GitFork },
    { label: 'npm', href: 'https://www.npmjs.com/package/@rzmps/rzmps', Icon: Package },
];

const END_BEHAVIOR_OPTIONS = EndBehavior;
const MAX_CULLING_OPTIONS = MaxCulling ?? { New: 'new', Old: 'old' };
const RENDERER_MODE_OPTIONS = { WebGL: 'webgl', WebGPU: 'webgpu' };

export class ParticleSystemGUI {
    // -------------------------------------------------------------------------
    // Lifecycle and top-level editor state
    // -------------------------------------------------------------------------
    constructor(options) {
        this.presetLoadVersion = 0;
        this.sceneLoadVersion = 0;
        this.system = options.system;
        this.scene = options.scene;
        this.presets = options.presets ?? {};
        this.scenes = options.scenes ?? {};
        this.renderer = options.renderer;
        this.moduleFactories = { ...DEFAULT_MODULE_FACTORIES, ...options.moduleFactories };
        this.rendererFactories = { ...DEFAULT_RENDERER_FACTORIES, ...options.rendererFactories };
        this.subSystemFactories = options.subSystemFactories ?? {};
        this.onSystemChange = options.onSystemChange;
        this.onPresetChange = options.onPresetChange;
        this.onRendererChange = options.onRendererChange;
        this.onSceneChange = options.onSceneChange;
        this.onMetadataChange = options.onMetadataChange;
        this.onCodeChange = options.onCodeChange;
        this.onShowCodeChange = options.onShowCodeChange;
        this.currentPresetName = options.initialPreset;
        this.currentSceneName = options.initialScene;
        this.sceneGUI = undefined;
        this.viewState = {
            renderer: options.rendererMode ?? 'webgl',
            showCode: false,
        };

        // Focused collaborators keep this class responsible for orchestration only.
        this.valueEditor = new GUIValueEditor(this);
        this.emitterGUI = new EmitterGUI(this);
        this.moduleGUI = new ModuleGUI(this);
        this.rendererGUI = new RendererGUI(this);
        this.serializer = new ParticleSystemSerializer(this);
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
        if (this.onRendererChange) {
            this.gui
                .add(this.viewState, 'renderer', RENDERER_MODE_OPTIONS)
                .name('Renderer')
                .onChange(this.onRendererChange);
        }
        if (this.onShowCodeChange) {
            this.gui
                .add(this.viewState, 'showCode')
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
            previous.removeFromParent();
            getSceneParticleRoot(this.scene).add(next);
        }
        this.system = next;
        this.configureSystemForScene(next);
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

    update(deltaTime) {
        this.sceneUpdate?.(deltaTime);
    }

    generateCode() {
        return this.serializeParticleSystem();
    }

    emitCode() {
        this.onCodeChange?.(this.generateCode());
    }

    serializeParticleSystem() {
        return this.serializer.serializeParticleSystem();
    }

    buildEmittersFolder(...args) {
        return this.emitterGUI.buildEmittersFolder(...args);
    }

    buildModulesFolder(...args) {
        return this.moduleGUI.buildModulesFolder(...args);
    }

    buildRenderersFolder(...args) {
        return this.rendererGUI.buildRenderersFolder(...args);
    }

    buildUpdateLOD(...args) {
        return this.emitterGUI.buildUpdateLOD(...args);
    }

    addObject(...args) {
        return this.valueEditor.addObject(...args);
    }

    addDynamicValue(...args) {
        return this.valueEditor.addDynamicValue(...args);
    }

    addVector3(...args) {
        return this.valueEditor.addVector3(...args);
    }

    destroy() {
        this.sceneCleanup?.();
        this.sceneUpdate = undefined;
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
        this.buildModulesFolder(this.contentFolder, this.system);
        this.buildRenderersFolder(this.contentFolder, this.system);
        this.buildSubSystemsFolder(this.contentFolder, this.system);
        this.emitMetadata();
    }

    isSystemDestroyed(system) {
        return !!system.destroyed;
    }

    disableFolder(folder) {
        folder.controllersRecursive().forEach((controller) => controller.disable?.());
    }

    async respawnSystem() {
        const presetFactory = this.getPresetFactory(this.presets[this.currentPresetName]);
        if (!this.currentPresetName || !presetFactory)
            return;
        const version = ++this.presetLoadVersion;
        const next = await presetFactory();
        if (version !== this.presetLoadVersion)
            return;
        this.setSystem(next, this.currentPresetName);
    }
    // -------------------------------------------------------------------------
    // Demo / scene controls
    // -------------------------------------------------------------------------
    buildDemoSelectors(root) {
        if (Object.keys(this.presets).length === 0 && Object.keys(this.scenes).length === 0)
            return;
        const folder = root.addFolder('Demo');
        folder.domElement.classList.add('psgui-section', 'psgui-demo');
        folder.open();
        const presetNames = Object.keys(this.presets);
        if (presetNames.length > 0) {
            const state = { preset: this.currentPresetName ?? '(current)' };
            folder.add(state, 'preset', ['(current)', ...presetNames]).name('Preset').onChange(async (name) => {
                if (name === '(current)')
                    return;
                const presetFactory = this.getPresetFactory(this.presets[name]);
                if (!presetFactory)
                    return;
                const version = ++this.presetLoadVersion;
                const next = await presetFactory();
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
            const settingsFolder = folder.addFolder('Scene Settings');
            settingsFolder.close();
            this.buildSceneBackgroundControl(settingsFolder);
            this.buildSceneSettings(settingsFolder);
        }
    }

    async setScene(name) {
        if (!this.scene || !this.scenes[name])
            return;
        const version = ++this.sceneLoadVersion;
        this.sceneCleanup?.();
        this.sceneCleanup = undefined;
        this.sceneUpdate = undefined;
        this.currentSceneName = name;
        this.onSceneChange?.(name);
        this.applyDefaultSceneState();
        const sceneBuilder = this.getPresetFactory(this.scenes[name]);
        if (!sceneBuilder)
            return;
        const sceneLifecycle = await sceneBuilder(this.scene, this.renderer);
        if (version !== this.sceneLoadVersion) {
            if (typeof sceneLifecycle === 'function')
                sceneLifecycle();
            else
                sceneLifecycle?.cleanup?.();
            return;
        }
        if (typeof sceneLifecycle === 'function') {
            this.sceneCleanup = sceneLifecycle;
        } else {
            this.sceneCleanup = sceneLifecycle?.cleanup;
            this.sceneUpdate = sceneLifecycle?.update;
        }
        this.sceneGUI = sceneLifecycle?.gui ?? sceneBuilder.gui;
        this.syncRendererBackground();
        getSceneParticleRoot(this.scene).add(this.system);
        this.configureSystemForScene(this.system);
        this.rebuild();
        this.emitCode();
    }

    applyDefaultSceneState() {
        if (!this.scene) {
            return;
        }

        this.scene.background = createDefaultSceneBackground();
        this.scene.environment = null;
        this.syncRendererBackground();
    }

    buildSceneSettings(folder) {
        const sceneBuilder = this.getPresetFactory(this.scenes[this.currentSceneName]);
        const sceneGUI = this.sceneGUI ?? sceneBuilder?.gui;
        if (!sceneGUI) {
            return;
        }

        if (typeof sceneGUI === 'function') {
            sceneGUI(folder, this.scene, this.renderer);
            return;
        }

        if (typeof sceneGUI === 'object') {
            this.addObject(folder, sceneGUI);
        }
    }

    buildSceneBackgroundControl(folder) {
        if (!(this.scene?.background instanceof THREE.Color)) {
            return;
        }

        const state = {
            background: `#${this.scene.background.getHexString()}`,
        };

        folder.addColor(state, 'background').name('Background').onChange((value) => {
            if (!(this.scene?.background instanceof THREE.Color)) {
                return;
            }

            this.scene.background.set(value);
            this.syncRendererBackground();
        });
    }

    syncRendererBackground() {
        if (!this.renderer || !this.scene) {
            return;
        }

        if (this.scene.background instanceof THREE.Color) {
            this.renderer.setClearColor(this.scene.background, 1);
        }
    }

    configureSystemForScene(system = this.system) {
        this.scene?.userData?.[SCENE_PARTICLE_SYSTEM_CONFIGURER_KEY]?.(system);
    }

    getPresetFactory(entry) {
        return typeof entry === 'function' ? entry : entry?.create;
    }

    getPresetMetadata(entry) {
        const factory = this.getPresetFactory(entry);
        return {
            sourceUrl: entry?.sourceUrl ?? factory?.sourceUrl,
            author: entry?.author ?? factory?.author,
            description: entry?.description ?? factory?.description,
        };
    }

    emitMetadata() {
        this.onMetadataChange?.({
            particle: this.getPresetMetadata(this.presets[this.currentPresetName]),
            scene: this.getPresetMetadata(this.scenes[this.currentSceneName]),
        });
    }
    // -------------------------------------------------------------------------
    // Particle-system controls
    // -------------------------------------------------------------------------
    buildSystemFolder(root, system = this.system) {
        const folder = root.addFolder('System');
        folder.domElement.classList.add('psgui-system');
        folder.open();
        const destroyed = this.isSystemDestroyed(system);
        folder.add(system, 'simulationSpace', ['local', 'world']).name('Simulation Space');
        folder.add(system, 'useSpatialEffects').name('Spatial Effects');
        const gravityFolder = folder.addFolder('Gravity');
        gravityFolder.close();
        this.addVector3(gravityFolder, system.gravity, 'Gravity');
        this.addDynamicValue(folder, system, 'gravityModifier', 'Gravity Modifier');
        folder.add(system, 'simulationSpeed', 0, 4, 0.01).name('Simulation Speed');
        folder.add(system, 'inheritVelocity', 0, 4, 0.01).name('Inherit Velocity');
        folder.add(system, 'duration', 0.01).name('Duration');
        folder.add(system, 'prewarm').name('Prewarm');
        folder.add(system, 'prewarmFPS', 1, 120, 1).name('Prewarm FPS');
        folder.add(system, 'looping').name('Looping');
        folder.add(system, 'endBehavior', END_BEHAVIOR_OPTIONS).name('End Behavior');
        folder.add(system, 'maxParticles', 0, 100000, 1).name('Max Particles');
        folder.add(system, 'maxCullingMode', MAX_CULLING_OPTIONS).name('Max Culling');
        folder.add(system, 'simulationDistance', 0, 1000, 0.1).name('Simulation Distance');
        const updateLODFolder = folder.addFolder('Update LOD');
        updateLODFolder.close();
        this.buildUpdateLOD(updateLODFolder, system);
        folder.add(system, 'useLiveCubemap').name('Live Cubemap');
        folder.add(system.liveCubemap, 'fps', 1, 120, 1).name('Live Cubemap FPS');
        folder.add(system.liveCubemap, 'resolutionScale', 0.05, 1, 0.01).name('Live Cubemap Scale');
        folder.add(system.liveCubemap, 'intensity', 0, 10, 0.01).name('Live Cubemap Intensity');
        const controlOptions = {
            children: true,
        };
        const actions = {
            start: () => system.start(controlOptions.children),
            pause: () => system.pause(controlOptions.children),
            stop: () => system.stop(false, controlOptions.children),
            stopAndClear: () => system.stop(true, controlOptions.children),
            clearParticles: () => system.clearParticles(controlOptions.children),
            respawn: () => void this.respawnSystem(),
        };
        folder.add(controlOptions, 'children').name('Propagate Children');
        folder.add(actions, 'start').name('Start / Restart');
        folder.add(actions, 'pause').name('Pause');
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
    // -------------------------------------------------------------------------
    // Emitters
    // -------------------------------------------------------------------------
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
        folder.add(options, 'inheritScale', 0, 1, 0.01).name('Inherit Scale');
        folder.add(options, 'inheritLifetime', 0, 1, 0.01).name('Inherit Lifetime');
        folder.add(options, 'inheritColor', 0, 1, 0.01).name('Inherit Color');
        folder.add(options, 'inheritAlpha', 0, 1, 0.01).name('Inherit Alpha');
        folder.add(options, 'inheritMass', 0, 1, 0.01).name('Inherit Mass');
        folder.add(options, 'inheritVelocity', 0, 1, 0.01).name('Inherit Velocity');
        folder.add(options, 'impulseAffectsScale', 0, 4, 0.01).name('Impulse Affects Scale');
        folder.add(options, 'impulseAffectsSpeed', 0, 4, 0.01).name('Impulse Affects Speed');
        folder.add(options, 'impulseAffectsLifetime', 0, 4, 0.01).name('Impulse Affects Lifetime');
        folder.add(options, 'impulseAffectsMass', 0, 4, 0.01).name('Impulse Affects Mass');
        folder.add(options, 'impulseAffectsAlignment').name('Impulse Affects Alignment');
        folder.add(options, 'impulseThreshhold', 0, 100, 0.01).name('Impulse Threshhold');

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
        this.buildModulesFolder(editor, subSystem);
        this.buildRenderersFolder(editor, subSystem);
        this.buildSubSystemsFolder(editor, subSystem);

        folder.add(actions, 'remove').name('Remove Sub System');
    }

    // -------------------------------------------------------------------------
    // Modules
    // -------------------------------------------------------------------------
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
      .lil-gui .psgui-upload-controller {
        outline: 1px dashed rgba(255,255,255,.22);
        outline-offset: -2px;
      }
      .lil-gui .psgui-upload-controller .widget button {
        cursor: pointer;
      }
      .lil-gui .psgui-upload-hover {
        background: rgba(85,170,255,.18);
      }
    `;
        document.head.appendChild(style);
    }
}
