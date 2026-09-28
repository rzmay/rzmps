import * as THREE from 'three';
import { Audio, SpriteRenderer, LightRenderer, MeshRenderer, TrailRenderer, TrailMode, TrailTextureMode } from '@rzmps/rzmps';
import { GUIEditorBase } from './GUIEditorBase';
import { LOD_GUI_KEYS } from './constants';

export class RendererGUI extends GUIEditorBase {
    buildRenderersFolder(root, system = this.system) {
        const section = root.addFolder(`Renderers (${system.renderers.length})`);
        section.domElement.classList.add('psgui-section', 'psgui-renderers');
        section.open();
        system.renderers.forEach((renderer, index) => {
            const folder = section.addFolder(`${index + 1}. ${renderer.constructor.name}`);
            folder.open();
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
        const updateLODFolder = folder.addFolder('Update LOD');
        updateLODFolder.close();
        this.buildUpdateLOD(updateLODFolder, renderer);

        const countLODFolder = folder.addFolder('Count LOD');
        countLODFolder.close();
        this.buildCountLOD(countLODFolder, renderer, true);

        if (renderer instanceof SpriteRenderer) {
            this.buildSpriteRenderer(folder, renderer);
        } else if (renderer instanceof LightRenderer) {
            this.buildLightRenderer(folder, renderer);
        } else if (renderer instanceof MeshRenderer) {
            this.buildMeshRenderer(folder, renderer);
        } else if (renderer instanceof TrailRenderer) {
            this.buildTrailRenderer(folder, renderer);
        } else if (renderer instanceof Audio) {
            this.buildAudioRenderer(folder, renderer);
        } else {
            this.addObject(folder, renderer, new Set([
                'setup',
                'update',
                'destroy',
                'mesh',
                'geometry',
                'material',
                'tags',
                ...LOD_GUI_KEYS,
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
        folder.add(renderer, 'billboard').name('Billboard');
        folder.add(renderer, 'sizeAttenuation').name('Size Attenuation');
        folder.add(renderer, 'castShadow').name('Cast Shadow');
        folder.add(renderer, 'softParticleDistance', 0).name('Soft Particle Distance');
        folder.add(renderer, 'frames').min(1).step(1).name('Frames').onFinishChange(() => this.reloadSpriteMaterial(renderer));
        const materialState = { material: renderer.materialType };
        folder.add(materialState, 'material', ['unlit', 'lit']).name('Material').onChange((value) => {
            renderer.materialType = value;
            this.reloadSpriteMaterial(renderer);
        });
        const gridSizeFolder = folder.addFolder('Grid Size');
        gridSizeFolder.close();
        this.addVector2(gridSizeFolder, renderer.gridSize, 'Grid', () => this.reloadSpriteMaterial(renderer));

        const tileSizeFolder = folder.addFolder('Tile Size');
        tileSizeFolder.close();
        this.addVector2(tileSizeFolder, renderer.tileSize, 'Tile');

        const tileMarginFolder = folder.addFolder('Tile Margin');
        tileMarginFolder.close();
        this.addVector2(tileMarginFolder, renderer.tileMargin, 'Margin');
        const info = {
            texture: renderer.texture?.name || renderer.texture?.uuid || '(texture)',
            alphaMap: renderer.alphaMap?.name || renderer.alphaMap?.uuid || '(none)',
        };
        folder.add(info, 'texture').name('Texture').disable();
        folder.add(info, 'alphaMap').name('Alpha Map').disable();
        this.addTextureUpload(folder, 'Upload Texture', (texture) => {
            renderer.texture = texture;
            renderer.materialOptions = { ...renderer.materialOptions };
        });
        this.addTextureUpload(folder, 'Upload Alpha Map', (texture) => {
            renderer.alphaMap = texture;
            renderer.materialOptions = { ...renderer.materialOptions };
        });

        const materialOptionsFolder = folder.addFolder('Material Options');
        materialOptionsFolder.close();
        this.buildSpriteMaterialOptionsFolder(materialOptionsFolder, renderer);
    }

    buildSpriteMaterialOptionsFolder(folder, renderer) {
        const optionDefinitions = [
            ['opacity', 'Opacity', 0, 1, 0.01],
            ['alphaTest', 'Alpha Test', 0, 1, 0.001],
            ['roughness', 'Roughness', 0, 1, 0.01],
            ['metalness', 'Metalness', 0, 1, 0.01],
            ['normalStrength', 'Normal Strength', 0, 4, 0.01],
            ['normalLighting', 'Normal Lighting', 0, 1, 0.01],
            ['sphericalNormals', 'Spherical Normals', 0, 1, 0.01],
            ['transmission', 'Transmission', 0, 1, 0.01],
            ['distortionStrength', 'Distortion Strength', -64, 64, 0.1],
            ['envIntensity', 'Env Intensity', 0, 10, 0.01],
        ];

        optionDefinitions.forEach(([key, label, min, max, step]) => {
            const state = {
                [key]: renderer.materialOptions[key] ?? this.defaultSpriteMaterialOption(key),
            };

            folder
                .add(state, key, min, max, step)
                .name(label)
                .onChange((value) => {
                    renderer.materialOptions = {
                        ...renderer.materialOptions,
                        [key]: value,
                    };
                });
        });

        this.addTextureUpload(folder, 'Upload Normal Map', (texture) => {
            renderer.materialOptions = {
                ...renderer.materialOptions,
                normalMap: texture,
            };
        });
        this.addTextureUpload(folder, 'Upload Roughness Map', (texture) => {
            renderer.materialOptions = {
                ...renderer.materialOptions,
                roughnessMap: texture,
            };
        });
        this.addTextureUpload(folder, 'Upload Metalness Map', (texture) => {
            renderer.materialOptions = {
                ...renderer.materialOptions,
                metalnessMap: texture,
            };
        });
        this.addTextureUpload(folder, 'Upload Transmission Map', (texture) => {
            renderer.materialOptions = {
                ...renderer.materialOptions,
                transmissionMap: texture,
            };
        });
        this.addTextureUpload(folder, 'Upload Distortion Map', (texture) => {
            renderer.materialOptions = {
                ...renderer.materialOptions,
                distortionMap: texture,
            };
        });
    }

    defaultSpriteMaterialOption(key) {
        switch (key) {
            case 'opacity':
                return 1;
            case 'roughness':
                return 0.5;
            default:
                return 0;
        }
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
        lightOptions.open();
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
        const materialFolder = folder.addFolder('Material');
        materialFolder.close();
        this.buildMaterialFolder(materialFolder, renderer.mesh.material);
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

        const materialFolder = folder.addFolder('Material');
        materialFolder.close();
        this.buildTrailMaterialFolder(materialFolder, renderer);
    }

    buildTrailMaterialFolder(folder, renderer) {
        this.buildMaterialFolder(folder, renderer.material);
    }

    buildAudioRenderer(folder, renderer) {
        const hidden = new Set([
            'listener',
            'sound',
            'onCollisionSound',
            'onSpawnSound',
            'onDeathSound',
            'tags',
            ...LOD_GUI_KEYS,
        ]);

        Object.keys(renderer)
            .filter((key) => !key.startsWith('_') && !hidden.has(key))
            .forEach((key) => this.addValue(folder, renderer, key, this.prettyName(key)));

        const clipsFolder = folder.addFolder('Clips');
        clipsFolder.close();
        this.addAudioUpload(clipsFolder, renderer, 'sound', 'Loop Sound');
        this.addAudioUpload(clipsFolder, renderer, 'onCollisionSound', 'Collision Sound');
        this.addAudioUpload(clipsFolder, renderer, 'onSpawnSound', 'Spawn Sound');
        this.addAudioUpload(clipsFolder, renderer, 'onDeathSound', 'Death Sound');
    }

    buildMaterialFolder(folder, materialOrMaterials) {
        const materials = Array.isArray(materialOrMaterials)
            ? materialOrMaterials
            : [materialOrMaterials];

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

        const numericControls = [
            ['opacity', 'Opacity', 0, 1, 0.01],
            ['alphaTest', 'Alpha Test', 0, 1, 0.001],
            ['roughness', 'Roughness', 0, 1, 0.01],
            ['metalness', 'Metalness', 0, 1, 0.01],
            ['envMapIntensity', 'Env Map Intensity', 0, 10, 0.01],
            ['emissiveIntensity', 'Emissive Intensity', 0, 10, 0.01],
            ['ior', 'IOR', 1, 2.333, 0.001],
            ['reflectivity', 'Reflectivity', 0, 1, 0.01],
            ['clearcoat', 'Clearcoat', 0, 1, 0.01],
            ['clearcoatRoughness', 'Clearcoat Roughness', 0, 1, 0.01],
            ['transmission', 'Transmission', 0, 1, 0.01],
            ['thickness', 'Thickness', 0, 10, 0.01],
            ['attenuationDistance', 'Attenuation Distance', 0, 100, 0.01],
            ['sheen', 'Sheen', 0, 1, 0.01],
            ['sheenRoughness', 'Sheen Roughness', 0, 1, 0.01],
            ['iridescence', 'Iridescence', 0, 1, 0.01],
            ['iridescenceIOR', 'Iridescence IOR', 1, 2.333, 0.001],
            ['anisotropy', 'Anisotropy', 0, 1, 0.01],
        ];

        numericControls.forEach(([key, label, min, max, step]) => {
            if (!(key in material) || typeof material[key] !== 'number') {
                return;
            }

            folder
                .add(material, key, min, max, step)
                .name(label)
                .onChange(() => {
                    material.needsUpdate = true;
                });
        });

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

        if ('wireframe' in material) {
            folder
                .add(material, 'wireframe')
                .name('Wireframe');
        }

        if ('map' in material) {
            this.addTextureUpload(folder, 'Upload Map', (texture) => {
                material.map = texture;
                material.needsUpdate = true;
            });
        }
    }
    // -------------------------------------------------------------------------
    // File uploads
    // -------------------------------------------------------------------------
    reloadSpriteMaterial(renderer) {
        renderer.loadMaterial?.();
    }
}
