import { Emitter, EmissionShape, EmissionSource } from '@rzmps/rzmps';
import { GUIEditorBase } from './GUIEditorBase';
import { INITIAL_VALUE_DEFAULTS } from './constants';

export class EmitterGUI extends GUIEditorBase {
    buildEmittersFolder(root, system = this.system) {
        const section = root.addFolder(`Emitters (${system.emitters.length})`);
        section.domElement.classList.add('psgui-section', 'psgui-emitters');
        section.open();
        system.emitters.forEach((emitter, index) => {
            const folder = section.addFolder(`${index + 1}. ${emitter.constructor.name}`);
            folder.open();
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
        this.addDynamicValue(folder, emitter, 'rateOverDistance', 'Rate Over Distance');
        this.addDynamicValue(folder, emitter, 'radialSpeed', 'Radial Speed');
        this.addDynamicValue(folder, emitter, 'alignment', 'Alignment');
        this.addTags(folder, emitter);
        folder.add(emitter, 'tagSelection', ['all', 'random', 'distribute']).name('Tag Selection');


        const emissionShapeFolder = folder.addFolder('Emission Shape');
        emissionShapeFolder.close();
        this.buildEmissionShape(emissionShapeFolder, emitter);

        const initialValuesFolder = folder.addFolder('Initial Values');
        initialValuesFolder.open();
        this.buildInitialValues(initialValuesFolder, emitter);

        const burstsFolder = folder.addFolder(`Bursts (${emitter.bursts.length})`);
        burstsFolder.close();
        this.buildBursts(burstsFolder, emitter);
        const actions = {
            remove: () => {
                system.removeEmitter(emitter);
                this.rebuild();
                this.emitCode();
            },
        };
        folder.add(actions, 'remove').name('Remove Emitter');
    }
    // -------------------------------------------------------------------------
    // Level-of-detail controls
    // -------------------------------------------------------------------------
    buildLOD(folder, target) {
        const state = { enabled: Boolean(target.lod) };
        const settings = this.normalizeLODSettings(target.lod);
        const refresh = () => { target.lod = state.enabled ? settings : undefined; };
        folder.add(state, 'enabled').name('Enabled').onChange(refresh);
        this.addLODSettings(folder, settings, refresh);
        folder.add(target, 'quality').name('Current Quality').disable().listen();
    }

    normalizeLODSettings(settings) {
        return {
            ...this.createDefaultLODSettings(),
            ...(settings ?? {}),
        };
    }

    createDefaultLODSettings() {
        return {
            distance: 10,
            quality: 0.5,
            maxLevel: 4,
            falloff: 1.5,
            continuous: false,
        };
    }

    addLODSettings(folder, settings, onChange) {
        folder.add(settings, 'distance', 0.1, 200, 0.1).name('Distance').onChange(onChange);
        folder.add(settings, 'quality', 0.01, 1, 0.01).name('Quality').onChange(onChange);
        folder.add(settings, 'falloff', 1, 4, 0.01).name('Falloff').onChange(onChange);
        folder.add(settings, 'maxLevel', 0, 8, 1).name('Max Level').onChange(onChange);
        folder.add(settings, 'continuous').name('Continuous').onChange(onChange);
    }
    // -------------------------------------------------------------------------
    // Emission shape / initial particle values
    // -------------------------------------------------------------------------
    buildEmissionShape(folder, emitter) {
        const geometry = emitter.source.geometry;
        const params = geometry.parameters ?? {};
        const shape = this.geometryShapeName(geometry);
        const automaticVolumeSamples = emitter.source.volumeSamples === 'auto';
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
            automaticVolumeSamples,
            volumeSamples: automaticVolumeSamples ? emitter.source.resolvedVolumeSamples : emitter.source.volumeSamples,
        };
        folder.add(state, 'shape', ['Custom', 'Box', 'Sphere', 'Cone', 'Torus']).name('Shape').onChange(() => {
            if (state.shape === 'Custom') return;
            this.replaceEmitterShape(emitter, state);
            this.rebuild();
        });
        folder.add(state, 'source', {
            Volume: EmissionSource.Volume,
            Surface: EmissionSource.Surface,
            Vertices: EmissionSource.Vertices,
        }).name('Source').onChange((value) => {
            emitter.source.source = value;
        });
        let volumeSamplesController;
        folder.add(state, 'automaticVolumeSamples').name('Automatic Samples').onChange((value) => {
            emitter.source.volumeSamples = value ? 'auto' : Number(state.volumeSamples);
            if (value) {
                state.volumeSamples = emitter.source.resolvedVolumeSamples;
                volumeSamplesController.updateDisplay().disable();
            }
            else {
                volumeSamplesController.enable();
            }
        });
        volumeSamplesController = folder.add(state, 'volumeSamples', 1, 8192, 1).name('Volume Samples').listen().onFinishChange((value) => {
            if (!state.automaticVolumeSamples)
                emitter.source.volumeSamples = Number(value);
        });
        if (state.automaticVolumeSamples)
            volumeSamplesController.disable();
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

    geometryShapeName(geometry) {
        if (geometry.type.includes('Box')) return 'Box';
        if (geometry.type.includes('Cone')) return 'Cone';
        if (geometry.type.includes('Torus')) return 'Torus';
        if (geometry.type.includes('Sphere')) return 'Sphere';
        return 'Custom';
    }

    replaceEmitterShape(emitter, state) {
        const source = state.source;
        let shape;
        switch (state.shape) {
            case 'Custom':
                return;
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
        shape.volumeSamples = state.automaticVolumeSamples ? 'auto' : Number(state.volumeSamples);
        emitter.source = shape;
        if (state.automaticVolumeSamples)
            state.volumeSamples = shape.resolvedVolumeSamples;
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
            item.close();
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
    // -------------------------------------------------------------------------
    // Sub-systems
    // -------------------------------------------------------------------------
}
