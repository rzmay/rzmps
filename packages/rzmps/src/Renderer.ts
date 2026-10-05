import Particle from './Particle';
import ParticleSystem from './ParticleSystem';
import type { StrictMultiple } from './types/Multiple';
import type { Tag } from './types/Tag';
import acceptMultiple from './helpers/acceptMultiple';
import tagsIntersect from './helpers/tagsIntersect';
import LODHelper, { type LODSettings } from './LODHelper';

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

    public update(
        particles: Particle[],
        system: ParticleSystem,
        deltaTime: number = 0,
    ): void {
        const distanceSq = system.cameraDistanceSq;
        if (this.useUpdateLOD && !this._lodHelper.shouldUpdate(Math.sqrt(distanceSq))) return;

        const visibleParticles = particles.filter((p) => !this.tags || tagsIntersect(this.tags, p.tags ?? []));
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
    // Cleanup
    public abstract destroy(): void;
    public abstract clear(): void;
}
