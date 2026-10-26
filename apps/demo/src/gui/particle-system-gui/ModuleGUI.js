import { GUIEditorBase } from './GUIEditorBase';
import { LOD_GUI_KEYS } from './constants';
import { FluidSimulation } from '@rzmps/rzmps';

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
        const gpuStatus = {
            get compatible() {
                return module.supportsGPU ? 'GPU compatible' : 'CPU only';
            },
        };
        folder.add(gpuStatus, 'compatible').name('GPU').disable().listen();
        this.addTags(folder, module);
        const updateLODFolder = folder.addFolder('Update LOD');
        updateLODFolder.close();
        this.buildUpdateLOD(updateLODFolder, module);
        const candidate = module;
        if (candidate.options && typeof candidate.options === 'object') {
            this.addObject(folder, candidate.options, new Set(['tags', 'useOctree', 'useSpatialGrid', ...LOD_GUI_KEYS]));
        }
        else {
            const hidden = new Set([
                'modify',
                'modifyGPU',
                'condition',
                'conditionGPU',
                'gpuParameters',
                'noiseGenerator',
                'dependents',
                'priority',
                'backend',
                'useOctree',
                'octreeOptions',
                'octreeAggregator',
                'useSpatialGrid',
                'spatialGridOptions',
                'spatialEffects',
                'explicitSpatialEffects',
                'spatialEffectFilter',
                'requireSpatialEffects',
                'collisionListeners',
                'collisionHitSamples',
                'collisionPositionSamples',
                'collisionNormalSamples',
                'collisionHitAttribute',
                'collisionPositionAttribute',
                'collisionNormalAttribute',
                'explicitForceFields',
                'forceFields',
                'forceFieldFilter',
                'octree',
                'sourceOctree',
                'useOctree',
                'useSpatialGrid',
                'spatialGrid',
                'octreeOptions',
                'spatialGridOptions',
                'particleSystem',
                'explicitAffectors',
                'affectors',
                'affectorFilter',
                'particleAffectors',
                'parsedParticleAffectors',
                'alignment',
                'cohesion',
                'separation',
                'affector',
                'toNode',
                'desiredVelocity',
                'currentDirection',
                'affectorDirection',
                'affectorParticlePosition',
                'particleAffectorDirection',
                'worldQuaternion',
                'inverseWorldQuaternion',
                'particleIndices',
                'particleAffectorInfluences',
                'adjustedAggregate',
                'currentAffectorInfluence',
                'quantizedOctreeBounds',
                'octreeBoundsCenter',
                'octreeBoundsSize',
                'listener',
                'tags',
                ...LOD_GUI_KEYS,
            ]);
            if (candidate instanceof FluidSimulation) {
                [
                    'bounds', 'particleBounds', 'automaticPaddingDistance', 'resolution', 'cellSize', 'cellCount', 'autoBounds',
                    'spatialGridOptions', 'spatialGrid',
                    'boundsMinNode', 'cellSizeNode', 'forceNode', 'maxVelocityNode',
                    'velocityCurrentAttribute', 'velocityNextAttribute',
                    'pressureCurrentAttribute', 'pressureNextAttribute', 'divergenceAttribute',
                    'velocityCurrent', 'velocityNext', 'pressureCurrent', 'pressureNext',
                    'divergence', 'curl', 'density', 'colorField', 'densityAttributeA',
                    'densityAttributeB', 'colorAttributeA', 'colorAttributeB',
                    'visualDensityAttribute', 'visualColorAttribute', 'visualDensity', 'visualColor',
                    'solid', 'solidAttribute', 'solidNode',
                    'densityCurrent', 'densityNext', 'colorCurrent', 'colorNext',
                    'densityTexture', 'colorTexture', 'pressureNodes', 'divergenceNode',
                    'projectionNodes', 'velocityNodes', 'sourceNodes', 'outputNodes',
                    'gatherNode', 'forceNodeCompute', 'gpuCacheKey', 'gatherCacheKey',
                    'visualCacheKey', 'visualDensityNode', 'visualColorNode', 'visualOutputNodes',
                    'maxima', 'maximaAttribute', 'maximaNodes', 'maximaResetNode',
                    'pendingPreviousBounds',
                    'lastBoundsRead', 'boundsReadPending',
                ].forEach((key) => hidden.add(key));
            }
            Object.keys(candidate)
                .filter((key) => (
                    !key.startsWith('_')
                    && !hidden.has(key)
                    && !(candidate instanceof FluidSimulation && /(Node|Nodes|Attribute|Attributes|Texture|Textures)$/.test(key))
                ))
                .forEach((key) => this.addValue(folder, candidate, key, this.prettyName(key)));
        }
        if (candidate.useOctree) {
            const quality = folder.addFolder('Octree Options');
            quality.close();
            const settings = {
                maxDepth: candidate.octreeOptions.maxDepth ?? 8,
                particlesPerLeaf: candidate.octreeOptions.particlesPerLeaf ?? 4,
                timeQuality: candidate.octreeOptions.timeQuality ?? 1,
                quantizeBounds: candidate.octreeOptions.quantizeBounds ?? 0,
            };
            ['maxDepth', 'particlesPerLeaf', 'timeQuality', 'quantizeBounds']
                .forEach((key) => quality.add(settings, key).name(this.prettyName(key)).onChange((value) => {
                    candidate.octreeOptions[key] = value;
                    const octree = candidate.getParticleOctree?.();
                    if (octree) octree[key] = value;
                }));
        }
        if (candidate.useSpatialGrid) {
            const quality = folder.addFolder('Spatial Grid Options');
            quality.close();
            const grid = candidate.spatialGrid;
            const options = candidate.spatialGridOptions ?? {};
            if (!candidate.spatialGridOptions) candidate.spatialGridOptions = options;
            const settings = {
                brickSubdivisions: grid?.brickSubdivisions ?? options.brickSubdivisions ?? 3,
                cellSubdivisions: grid?.cellSubdivisions ?? options.cellSubdivisions ?? 4,
                powerOfTwoBounds: grid?.powerOfTwoBounds ?? options.powerOfTwoBounds ?? true,
                cubicBounds: grid?.cubicBounds ?? options.cubicBounds ?? false,
                centeredAtOrigin: grid?.centeredAtOrigin ?? options.centeredAtOrigin ?? true,
                autoExpand: grid?.autoExpand ?? options.autoExpand ?? true,
                autoShrink: grid?.autoShrink ?? options.autoShrink ?? true,
                shrinkDelay: grid?.shrinkDelay ?? options.shrinkDelay ?? 600,
                expansionHysteresis: grid?.expansionHysteresis ?? options.expansionHysteresis ?? 0.125,
                timeQuality: grid?.timeQuality ?? options.timeQuality ?? 1,
                maxQuerySteps: grid?.maxQuerySteps ?? options.maxQuerySteps ?? 0,
            };
            ['brickSubdivisions', 'cellSubdivisions']
                .forEach((key) => quality.add(settings, key, 0, 8, 1).name(this.prettyName(key)).onChange((value) => {
                    candidate.setSpatialGridOptions({ [key]: value });
                    this.emitCode();
                }));
            ['powerOfTwoBounds', 'cubicBounds', 'centeredAtOrigin',
                'autoExpand', 'autoShrink', 'shrinkDelay', 'expansionHysteresis',
                'timeQuality', 'maxQuerySteps']
                .forEach((key) => quality.add(settings, key).name(this.prettyName(key)).onChange((value) => {
                    candidate.setSpatialGridOptions({ [key]: value });
                    this.emitCode();
                }));
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
