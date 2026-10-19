import Particle from './Particle';
import ParticleSystem from './ParticleSystem';
import type { StrictMultiple } from './types/Multiple';
import type { Tag } from './types/Tag';
import acceptMultiple from './helpers/acceptMultiple';
import tagsIntersect from './helpers/tagsIntersect';
import LODHelper, { type LODSettings } from './LODHelper';
import type { GPUParticleBufferState, GPUParticleRenderBufferState } from './gpu/Particle';
import type { Node } from 'three/webgpu';
import { bitAnd, float, hash, uint, uniform } from 'three/tsl';
import { GPUDynamicParameterStore } from './helpers/evaluateDynamicGPU';

export interface RendererOptions {
    tags: StrictMultiple<Tag>;
    useUpdateLOD: boolean;
    updateLOD: Partial<LODSettings>;
    countLOD: Partial<LODSettings>;
    compensateSize: boolean;
}

export default abstract class Renderer {
    tags?: Tag[];
    useUpdateLOD: boolean;
    updateLOD?: Partial<LODSettings>;
    countLOD?: Partial<LODSettings>;
    compensateSize: boolean;
    private _lodHelper: LODHelper;
    private _countLODHelper: LODHelper;
    private readonly _gpuCountScale = uniform(1, 'float');
    private _gpuReadbackPending = false;
    private _gpuReadbackSequence = 0;
    private _version = 0;
    private _gpuConfigurationSignature = '';
    private _gpuParameterVersion = 0;
    protected readonly gpuParameters = new GPUDynamicParameterStore();

    get version(): number {
        return this._version;
    }

    get gpuParameterUploadCount(): number {
        return this.gpuParameters.uploadCount;
    }

    set needsUpdate(value: boolean) {
        if (value) {
            this._version += 1;
            this.onGPUConfigurationChange();
        }
    }

    constructor(options: Partial<RendererOptions> = {}) {
        this.tags = acceptMultiple(options.tags);
        this.updateLOD = options.updateLOD;
        this.useUpdateLOD = options.useUpdateLOD ?? Boolean(this.updateLOD);
        this.countLOD = options.countLOD;
        this.compensateSize = options.compensateSize ?? false;
        this._lodHelper = new LODHelper(this.updateLOD);
        this._countLODHelper = new LODHelper(this.countLOD);
    }

    // Runs once, when the renderer is added to the system
    public abstract setup(system: ParticleSystem): void;

    protected abstract _update(
        particles: Particle[],
        system: ParticleSystem,
        deltaTime: number,
    ): void;

    get supportsGPUInput(): boolean {
        return this.updateGPU !== Renderer.prototype.updateGPU;
    }

    public syncGPUConfiguration(): void {
        this._lodHelper.configure(this.updateLOD);
        this._countLODHelper.configure(this.countLOD);
        this.gpuParameters.sync();
        if (this.gpuParameters.version !== this._gpuParameterVersion) {
            this._gpuParameterVersion = this.gpuParameters.version;
            this._version += 1;
            this.onGPUConfigurationChange();
        }

        const signature = [
            this.tags?.join('|') ?? '',
            this.useUpdateLOD ? 1 : 0,
            this.countLOD ? 'count-lod' : 'no-count-lod',
            this.compensateSize ? 1 : 0,
            this.getGPUConfigurationSignature(),
        ].join(';');
        if (this._gpuConfigurationSignature && signature !== this._gpuConfigurationSignature) {
            this._version += 1;
            this.onGPUConfigurationChange();
        }
        this._gpuConfigurationSignature = signature;
    }

    protected getGPUConfigurationSignature(): string {
        return '';
    }

    protected onGPUConfigurationChange(): void { }

    public updateGPU(
        buffers: GPUParticleBufferState | GPUParticleRenderBufferState,
        system: ParticleSystem,
        deltaTime: number = 0,
    ): void {
        void buffers;
        void system;
        void deltaTime;
        throw new Error('This particle renderer does not support GPU particle buffers.');
    }

    public update(
        particles: Particle[],
        system: ParticleSystem,
        deltaTime: number = 0,
    ): void {
        const distanceSq = system.cameraDistanceSq;
        if (this.useUpdateLOD && !this._lodHelper.shouldUpdate(Math.sqrt(distanceSq))) return;

        const visibleParticles = particles.filter((p) => (
            p.alive
            && (!this.tags || tagsIntersect(this.tags, p.tags ?? []))
        ));
        const countScale = this.countLOD ? this._countLODHelper.getScale(Math.sqrt(distanceSq)) : 1;

        if (countScale < 1) {
            visibleParticles.length = Math.floor(visibleParticles.length * countScale);
        }

        const scaleMultiplier = this.compensateSize && countScale < 1
            ? 1 / Math.max(countScale, Number.EPSILON)
            : 1;

        if (scaleMultiplier !== 1) visibleParticles.forEach(p => p.scale.multiplyScalar(scaleMultiplier));

        // Call update on particles in the group
        this._update(
            visibleParticles,
            system,
            deltaTime,
        );

        // Undo scale multiplication if necessary
        if (scaleMultiplier !== 1) visibleParticles.forEach(p => p.scale.divideScalar(scaleMultiplier));
    }

    protected prepareGPUVisibility(system: ParticleSystem): void {
        this._gpuCountScale.value = this.countLOD
            ? this._countLODHelper.getScale(Math.sqrt(system.cameraDistanceSq))
            : 1;
    }

    protected getGPUVisibilityNode(
        particle: {
            index: Node<'uint'>;
            alive: Node<'uint'>;
            tagMask: Node<'uint'>;
            generation: Node<'uint'>;
        },
        system: ParticleSystem,
    ): Node<'float'> {
        let visible = particle.alive.notEqual(uint(0));
        const tagMask = system.getGPURendererTagMask(this.tags);
        if (tagMask !== undefined) {
            visible = visible.and(bitAnd(particle.tagMask, uint(tagMask)).notEqual(uint(0)));
        }
        if (this.countLOD) {
            const selected = hash(particle.index.add(particle.generation.mul(65537)))
                .lessThan(this._gpuCountScale);
            visible = visible.and(selected);
        }
        return visible.select(float(1), float(0)) as Node<'float'>;
    }

    protected getGPUScaleMultiplierNode(): Node<'float'> {
        if (!this.compensateSize || !this.countLOD) return float(1);
        return float(1).div(this._gpuCountScale.max(float(Number.EPSILON))) as Node<'float'>;
    }

    protected updateGPUFromSelectiveReadback(
        buffers: GPUParticleBufferState | GPUParticleRenderBufferState,
        system: ParticleSystem,
        deltaTime: number,
        limit = buffers.count,
    ): void {
        if (this._gpuReadbackPending) return;
        const requests = system.createGPUSelectiveReadbackRequests(Math.min(buffers.count, limit));
        if (requests.length <= 0) {
            this.update([], system, deltaTime);
            return;
        }

        const sequence = this._gpuReadbackSequence + 1;
        this._gpuReadbackSequence = sequence;
        this._gpuReadbackPending = true;
        void system.readbackGPUParticlesSelective(requests)
            .then((results) => {
                if (sequence !== this._gpuReadbackSequence) return;
                this.update(
                    results.filter((result) => result.valid).map((result) => result.particle),
                    system,
                    deltaTime,
                );
            })
            .finally(() => {
                if (sequence === this._gpuReadbackSequence) this._gpuReadbackPending = false;
            });
    }

    protected cancelGPUSelectiveReadback(): void {
        this._gpuReadbackSequence += 1;
        this._gpuReadbackPending = false;
    }
    // Cleanup
    public abstract destroy(): void;
    public abstract clear(): void;
}
