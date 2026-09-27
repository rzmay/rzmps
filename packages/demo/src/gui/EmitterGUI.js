import { Emitter, EmissionShape, EmissionSource, LODHelper } from '@rzmps/rzmps';
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
        this.addDynamicValue(folder, emitter, 'radialSpeed', 'Radial Speed');
        this.addDynamicValue(folder, emitter, 'alignment', 'Alignment');
        this.addTags(folder, emitter);
        folder.add(emitter, 'tagSelection', ['all', 'random', 'distribute']).name('Tag Selection');
        const updateLODFolder = folder.addFolder('Update LOD');
        updateLODFolder.close();
        this.buildUpdateLOD(updateLODFolder, emitter);

        const countLODFolder = folder.addFolder('Count LOD');
        countLODFolder.close();
        this.buildCountLOD(countLODFolder, emitter);

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
    buildUpdateLOD(folder, target) {
        this.ensureUpdateLOD(target);
        const refresh = () => {
            target._lodHelper = new LODHelper(target.updateLOD);
        };

        folder.add(target, 'useUpdateLOD').name('Enabled').onChange(refresh);
        this.addLODSettings(folder, target.updateLOD, refresh);
    }

    buildCountLOD(folder, target, includeSizeCompensation = false) {
        const state = {
            enabled: Boolean(target.countLOD),
        };
        const settings = this.normalizeLODSettings(target.countLOD);
        const refresh = () => {
            target.countLOD = state.enabled ? settings : undefined;
            target._countLODHelper = new LODHelper(target.countLOD);
        };

        folder.add(state, 'enabled').name('Enabled').onChange(refresh);
        this.addLODSettings(folder, settings, refresh);

        if (includeSizeCompensation) {
            target.compensateSize ??= false;
            folder.add(target, 'compensateSize').name('Compensate Size');
        }
    }

    ensureUpdateLOD(target) {
        target.updateLOD = this.normalizeLODSettings(target.updateLOD);
        target.useUpdateLOD ??= Boolean(target.updateLOD);
        target._lodHelper ??= new LODHelper(target.updateLOD);
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

    geometryShapeName(geometry) {
        if (geometry.type.includes('Box')) return 'Box';
        if (geometry.type.includes('Cone')) return 'Cone';
        if (geometry.type.includes('Torus')) return 'Torus';
        return 'Sphere';
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
