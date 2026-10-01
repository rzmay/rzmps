import { GUIEditorBase } from './GUIEditorBase';
import { LOD_GUI_KEYS } from './constants';

export class ModuleGUI extends GUIEditorBase {
    buildModulesFolder(root, system = this.system) {
        const section = root.addFolder(`Modules (${system.modules.length})`);
        section.domElement.classList.add('psgui-section', 'psgui-modules');
        section.open();
        system.modules.forEach((module, index) => {
            const folder = section.addFolder(`${index + 1}. ${module.constructor.name}`);
            folder.open();
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
        const updateLODFolder = folder.addFolder('Update LOD');
        updateLODFolder.close();
        this.buildUpdateLOD(updateLODFolder, module);
        const candidate = module;
        if (candidate.options && typeof candidate.options === 'object') {
            this.addObject(folder, candidate.options, new Set(['tags', ...LOD_GUI_KEYS]));
        }
        else {
            const hidden = new Set([
                'modify',
                'noiseGenerator',
                'dependents',
                'priority',
                'backend',
                'collisionListeners',
                'explicitForceFields',
                'forceFields',
                'forceFieldFilter',
                'particleSystem',
                'explicitAffectors',
                'affectors',
                'affectorFilter',
                'parsedParticleAffectors',
                'alignment',
                'cohesion',
                'separation',
                'affector',
                'toNode',
                'desiredVelocity',
                'affectorDirection',
                'affectorParticlePosition',
                'particleAffectorDirection',
                'worldQuaternion',
                'inverseWorldQuaternion',
                'particleIndices',
                'particleAffectorInfluences',
                'adjustedAggregate',
                'currentAffectorInfluence',
                'listener',
                'tags',
                ...LOD_GUI_KEYS,
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

    // -------------------------------------------------------------------------
    // Renderers and materials
    // -------------------------------------------------------------------------
}
