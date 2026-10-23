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
import type { GPUParticleReadbackField } from './gpu/SelectiveReadback';

export interface RendererOptions {
    /** Filters the simulated population by tag before rendering. */
    tags: StrictMultiple<Tag>;
    /** Enables distance-based renderer update skipping. */
    useUpdateLOD: boolean;
    /** Distance-based renderer update quality. */
    updateLOD: Partial<LODSettings>;
    /** Reduces the number of rendered particles with distance without deleting simulated particles. */
    countLOD: Partial<LODSettings>;
    /** Temporarily enlarges retained particles when count LOD reduces visibility.
     * @defaultValue false */
    compensateSize: boolean;
}

/** Base renderer that filters particles and applies renderer LOD before delegating to a backend-compatible view. */
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

    /** Configures particle filtering and distance-based update/count quality. */
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
    /** Creates rendering resources when attached to a system. */
    public abstract setup(system: ParticleSystem): void;

    protected abstract _update(
        particles: Particle[],
        system: ParticleSystem,
        deltaTime: number,
    ): void;

    /** Whether this renderer can consume GPU particle buffers without a selective CPU readback. */
    get supportsGPUInput(): boolean {
        return this.updateGPU !== Renderer.prototype.updateGPU;
    }

    /** Synchronizes runtime values and invalidates structural GPU changes. */
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

    /** Consumes GPU simulation or render-output storage without materializing CPU particles. */
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

    /** Filters particles, applies renderer LOD and temporary size compensation, then delegates to the view. */
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

    /**
     * Selectively reads GPU particle fields and forwards the resulting particles through
     * {@link update}. Use this from {@link updateGPU} when a renderer consumes CPU particle
     * objects instead of GPU storage directly. Omit `fields` only when the renderer needs the
     * complete particle state.
     */
    protected updateCPUFromGPU(
        buffers: GPUParticleBufferState | GPUParticleRenderBufferState,
        system: ParticleSystem,
        deltaTime: number,
        limit = buffers.count,
        fields?: readonly GPUParticleReadbackField[],
    ): void {
        if (this._gpuReadbackPending) return;
        const sequence = this._gpuReadbackSequence + 1;
        this._gpuReadbackSequence = sequence;
        this._gpuReadbackPending = true;
        void system.selectiveReadback(Math.min(buffers.count, limit), fields)
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

    /** Restores transient backend state while retaining reusable rendering resources. */
    public reset(): void {
        this.cancelGPUSelectiveReadback();
    }

    // Cleanup
    /** Permanently releases owned rendering resources. */
    public abstract destroy(): void;
    /** Removes displayed particles while retaining resources for reuse. */
    public abstract clear(): void;
}
