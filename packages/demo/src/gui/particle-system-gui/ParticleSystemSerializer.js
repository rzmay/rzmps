import * as THREE from 'three';
import {
    Audio,
    Collision,
    EmissionSource,
    EndBehavior,
    ExternalForces,
    LightRenderer,
    MeshRenderer,
    NoiseModule,
    SpriteRenderer,
    Textures,
    TrailRenderer,
} from '@rzmps/rzmps';
import { AUDIO_BUFFER_SOURCE_KEY, RAW_CODE } from './constants';

export class ParticleSystemSerializer {
    constructor(host) {
        this.host = host;
    }

    get system() {
        return this.host.system;
    }

    serializeParticleSystem() {
        const imports = new Set(['EndBehavior', 'ParticleSystem', 'Emitter', 'EmissionShape', 'EmissionSource']);
        this.collectImports(this.system, imports);
        this.usesEasing = false;

        const counter = { value: 0 };
        const rootName = 'particleSystem';
        const systemLines = this.serializeParticleSystemTree(this.system, rootName, counter);

        const lines = [
            `import * as THREE from 'three';`,
            `import { ${Array.from(imports).sort().join(', ')} } from '@rzmps/rzmps';`,
        ];

        if (this.usesEasing) {
            lines.push(`import { Easing } from 'eaz';`);
        }

        lines.push(...systemLines, '', `export default ${rootName};`, '');
        this.usesEasing = false;
        return lines.join('\n');
    }

    collectImports(system, imports) {
        system.modules.forEach((module) => imports.add(module.constructor.name));
        system.renderers.forEach((renderer) => {
            imports.add(renderer.constructor.name);
            if (this.rendererUsesBuiltInTexture(renderer)) {
                imports.add('Textures');
            }
        });
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
            `  prewarm: ${this.serializeValue(system.prewarm)},`,
            `  prewarmFPS: ${this.serializeValue(system.prewarmFPS)},`,
            `  looping: ${this.serializeValue(system.looping)},`,
            `  endBehavior: ${this.serializeEndBehavior(system.endBehavior)},`,
            `  maxParticles: ${this.serializeValue(system.maxParticles)},`,
            `  maxCullingMode: ${this.serializeValue(system.maxCullingMode)},`,
            `  simulationDistance: ${this.serializeValue(system.simulationDistance)},`,
            `  useUpdateLOD: ${this.serializeValue(system.useUpdateLOD)},`,
            `  updateLOD: ${this.serializeValue(system.updateLOD)},`,
            `  useLiveCubemap: ${this.serializeValue(system.useLiveCubemap)},`,
            `  liveCubemapFPS: ${this.serializeValue(system.liveCubemap.fps)},`,
            `  liveCubemapResolutionScale: ${this.serializeValue(system.liveCubemap.resolutionScale)},`,
            `  liveCubemapIntensity: ${this.serializeValue(system.liveCubemap.intensity)},`,
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
            inheritVelocity: options.inheritVelocity,
            impulseAffectsScale: options.impulseAffectsScale,
            impulseAffectsSpeed: options.impulseAffectsSpeed,
            impulseAffectsLifetime: options.impulseAffectsLifetime,
            impulseAffectsMass: options.impulseAffectsMass,
            impulseAffectsAlignment: options.impulseAffectsAlignment,
            impulseThreshhold: options.impulseThreshhold,
        });
    }

    serializeEmitter(emitter) {
        const initialValues = this.serializeValue(emitter.initialValues);
        const bursts = this.serializeValue(emitter.bursts.map(({ time, count }) => ({ time, count })));
        const lodOptions = this.serializeLODOptions(emitter, true);
        return [
            'new Emitter({',
            `  source: ${this.serializeEmissionShape(emitter.source)},`,
            `  rate: ${this.serializeValue(emitter.rate)},`,
            `  radialSpeed: ${this.serializeValue(emitter.radialSpeed)},`,
            `  alignment: ${this.serializeValue(emitter.alignment)},`,
            ...lodOptions,
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
                ...this.getLODOptions(module),
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
                ...this.getLODOptions(runtime),
                tags: runtime.tags,
            })})`;
        }

        if (module instanceof ExternalForces) {
            const options = {
                multiplier: module.multiplier,
                ...this.getLODOptions(module),
                tags: module.tags,
            };

            if (Array.isArray(module.explicitForceFields)) {
                options.forceFields = module.explicitForceFields;
            }

            return `new ExternalForces(${this.serializeValue(options)})`;
        }

        if (module instanceof Audio) {
            const options = {
                loop: module.loop,
                maxClips: module.maxClips,
                ratio: module.ratio,
                collisionRatio: module.collisionRatio,
                pitch: module.pitch,
                volume: module.volume,
                highPass: module.highPass,
                lowPass: module.lowPass,
                sizeAffectsPitch: module.sizeAffectsPitch,
                sizeAffectsVolume: module.sizeAffectsVolume,
                alphaAffectsPitch: module.alphaAffectsPitch,
                alphaAffectsVolume: module.alphaAffectsVolume,
                speedAffectsPitch: module.speedAffectsPitch,
                speedAffectsVolume: module.speedAffectsVolume,
                impulseAffectsPitch: module.impulseAffectsPitch,
                impulseAffectsVolume: module.impulseAffectsVolume,
                impulseAffectsHighPass: module.impulseAffectsHighPass,
                impulseAffectsLowPass: module.impulseAffectsLowPass,
                impulseThreshhold: module.impulseThreshhold,
                ...this.getLODOptions(module),
                tags: module.tags,
            };

            if (module.sound?.length) {
                options.sound = this.rawCode(this.serializeAudioBuffers(module.sound));
            }

            if (module.onCollisionSound?.length) {
                options.onCollisionSound = this.rawCode(this.serializeAudioBuffers(module.onCollisionSound));
            }

            if (module.onSpawnSound?.length) {
                options.onSpawnSound = this.rawCode(this.serializeAudioBuffers(module.onSpawnSound));
            }

            if (module.onDeathSound?.length) {
                options.onDeathSound = this.rawCode(this.serializeAudioBuffers(module.onDeathSound));
            }

            return `new Audio(${this.serializeValue(options)})`;
        }

        const runtime = module;
        const args = runtime.options !== undefined
            ? this.serializeValue({
                ...runtime.options,
                ...this.getLODOptions(runtime),
                tags: runtime.tags,
            })
            : this.serializeValue(this.getSerializableRuntimeOptions(runtime));
        return `new ${module.constructor.name}(${args})`;
    }

    serializeRenderer(renderer) {
        if (renderer instanceof SpriteRenderer) {
            const texture = this.serializeTexture(renderer.texture);
            const options = this.serializeValue({
                fps: renderer.fps,
                sizeAttenuation: renderer.sizeAttenuation,
                tileSize: renderer.tileSize,
                tileMargin: renderer.tileMargin,
                gridSize: renderer.gridSize,
                frames: renderer.frames,
                castShadow: renderer.castShadow,
                softParticleDistance: renderer.softParticleDistance,
                ...this.getLODOptions(renderer, true, true),
                tags: renderer.tags,
                alphaMap: renderer.alphaMap ? this.rawCode(this.serializeTexture(renderer.alphaMap)) : undefined,
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
                ...this.getLODOptions(renderer, true, true),
                tags: renderer.tags,
                lightOptions: renderer.lightOptions,
            })})`;
        }
        if (renderer instanceof MeshRenderer) {
            return `new MeshRenderer(${this.serializeValue({
                mesh: this.rawCode(this.serializeMesh(renderer.mesh)),
                maxParticles: renderer.instances.instanceMatrix.count,
                castShadow: renderer.castShadow,
                receiveShadow: renderer.receiveShadow,
                ...this.getLODOptions(renderer, true, true),
                tags: renderer.tags,
            })})`;
        }
        if (renderer instanceof TrailRenderer) {
            const lodOptions = this.serializeLODOptions(renderer, true, true);
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
                ...lodOptions,
                `  tags: ${this.serializeValue(renderer.tags)},`,
                `  colorOverLifetime: ${this.serializeValue(renderer.colorOverLifetime)},`,
                `  colorOverTrail: ${this.serializeValue(renderer.colorOverTrail)},`,
                `  materialOptions: ${this.serializeMaterialOptions(renderer.material)},`,
                '})',
            ].join('\n');
        }
        return `new ${renderer.constructor.name}(${this.serializeValue(this.getSerializableRuntimeOptions(renderer))})`;
    }

    getLODOptions(target, includeCount = false, includeSize = false) {
        const options = {};
        if (target.updateLOD || target.useUpdateLOD) {
            options.useUpdateLOD = target.useUpdateLOD;
            options.updateLOD = target.updateLOD;
        }
        if (includeCount && target.countLOD) {
            options.countLOD = target.countLOD;
        }
        if (includeSize && target.compensateSize) {
            options.compensateSize = target.compensateSize;
        }
        return options;
    }

    serializeLODOptions(target, includeCount = false, includeSize = false) {
        return Object.entries(this.getLODOptions(target, includeCount, includeSize))
            .map(([key, value]) => `  ${key}: ${this.serializeValue(value)},`);
    }

    getSerializableRuntimeOptions(target) {
        const hidden = new Set([
        ]);
        return Object.fromEntries(
            Object.entries(target).filter(([key]) => !key.startsWith('_') && !hidden.has(key)),
        );
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

        if (material.map) {
            options.map = this.rawCode(this.serializeTexture(material.map));
        }

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
        const reference = this.textureReference(source);
        return reference
            ?? (source !== undefined
                ? JSON.stringify(source)
                : `undefined /* texture ${JSON.stringify(texture?.name || texture?.uuid)} must be supplied manually */`);
    }

    serializeAudioBuffers(buffers) {
        const values = buffers.map((buffer) => {
            const source = this.audioBufferSource(buffer);

            return source
                ? `await new THREE.AudioLoader().loadAsync(${JSON.stringify(source)})`
                : `undefined /* audio clip ${JSON.stringify(this.audioBufferLabel(buffer))} must be supplied manually */`;
        });

        return values.length === 1
            ? values[0]
            : `[\n${values.map((value) => `  ${value},`).join('\n')}\n]`;
    }

    audioBufferSource(buffer) {
        return buffer?.[AUDIO_BUFFER_SOURCE_KEY]?.url;
    }

    audioBufferLabel(buffer) {
        const source = buffer?.[AUDIO_BUFFER_SOURCE_KEY];
        return source?.name || source?.url || `${buffer?.duration?.toFixed?.(2) ?? '?'}s clip`;
    }

    setAudioBufferSource(buffer, url, name = url) {
        if (!buffer) return buffer;

        Object.defineProperty(buffer, AUDIO_BUFFER_SOURCE_KEY, {
            value: { url, name },
            configurable: true,
        });

        return buffer;
    }

    textureReference(source) {
        if (source === undefined)
            return undefined;

        const references = {
            'Textures.Default': Textures.Default,
            'Textures.Circle': Textures.Circle,
            'Textures.Simple': Textures.Simple,
        };

        return Object.entries(references)
            .find(([, value]) => value === source)?.[0];
    }

    rendererUsesBuiltInTexture(renderer) {
        if (renderer instanceof SpriteRenderer) {
            return Boolean(
                this.textureReference(this.textureSource(renderer.texture))
                || this.textureReference(this.textureSource(renderer.alphaMap)),
            );
        }

        if (renderer instanceof TrailRenderer) {
            return Boolean(this.textureReference(this.textureSource(renderer.material?.map)));
        }

        return false;
    }

    rawCode(code) {
        return { [RAW_CODE]: code };
    }

    textureSource(texture) {
        const image = texture?.image;
        return image?.currentSrc || image?.src || undefined;
    }

    serializeValue(value, seen = new WeakSet()) {
        if (value?.[RAW_CODE])
            return value[RAW_CODE];
        if (value === undefined)
            return 'undefined';
        if (value === null)
            return 'null';
        if (typeof value === 'string')
            return JSON.stringify(value);
        if (typeof value === 'number' || typeof value === 'boolean')
            return String(value);
        if (typeof value === 'function')
            return this.serializeFunction(value);
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
        if (value instanceof Set) {
            return `new Set([${Array.from(value).map((item) => this.serializeValue(item, seen)).join(', ')}])`;
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

    serializeFunction(value) {
        const source = value.toString();
        if (/\bEasing\./.test(source)) {
            this.usesEasing = true;
        }
        return source;
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
    // -------------------------------------------------------------------------
    // Display helpers / styles
    // -------------------------------------------------------------------------
}
