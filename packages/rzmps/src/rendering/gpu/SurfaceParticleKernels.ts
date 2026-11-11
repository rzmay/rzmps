import { If, float, max, mix, pow, smoothstep, sqrt, uniform, vec3, vec4 } from 'three/tsl';
import type { ComputeNode, Node } from 'three/webgpu';
import type ParticleSpatialGrid from '../../spatial/structures/ParticleSpatialGrid';

type Vectors = { element(index: Node | number): Node<'vec4'> };

/** Reconstruction-only neighborhood settings; radii multiply each particle's visual radius. @internal */
export interface SurfaceKernelOptions {
  influenceRadius: number;
  anisotropy: number;
  anisotropyRadius: number;
  anisotropyMinNeighbors: number;
  anisotropyMaxStretch: number;
  dropletSupportMin: number;
  dropletSupportMax: number;
}

/** Shares the render-time query grid with rasterization, including transient/child particles. @internal */
export default class SurfaceParticleKernels {
  readonly influence = uniform(2.2);
  readonly strength = uniform(0);
  readonly neighborhood = uniform(2);
  readonly minimumNeighbors = uniform(6);
  readonly maximumStretch = uniform(2);
  readonly supportMin = uniform(1);
  readonly supportMax = uniform(4);
  readonly isoLevel = uniform(0.2);

  constructor(private readonly cellSize: number) {}

  sync(options: SurfaceKernelOptions, isoLevel: number): void {
    this.influence.value = options.influenceRadius;
    this.strength.value = options.anisotropy;
    this.neighborhood.value = options.anisotropyRadius;
    this.minimumNeighbors.value = options.anisotropyMinNeighbors;
    this.maximumStretch.value = options.anisotropy > 0 ? options.anisotropyMaxStretch : 1;
    this.supportMin.value = options.dropletSupportMin;
    this.supportMax.value = options.dropletSupportMax;
    this.isoLevel.value = isoLevel;
  }

  bulk(support: Node<'float'>): Node<'float'> {
    return smoothstep(this.supportMin, this.supportMax, support) as Node<'float'>;
  }

  /** Three vec4 rows per particle: inverse axes, amplitude, support, and actual support radius. */
  build(grid: ParticleSpatialGrid, output: Vectors, anisotropic: boolean): ComputeNode {
    return grid.computeParticles(particle => {
      const index = particle.index.mul(3);
      output.element(index).assign(vec4(1, 0, 0, 0));
      output.element(index.add(1)).assign(vec4(0, 1, 0, 0));
      output.element(index.add(2)).assign(vec4(0, 0, 1, 0));
      If(particle.alive.notEqual(0), () => {
        const radius = particle.mass.mul(this.neighborhood);
        const support = float(0).toVar('surfaceSupport');
        const count = float(0).toVar();
        const center = vec3(0).toVar();
        const diagonal = vec3(0).toVar();
        const offDiagonal = vec3(0).toVar();
        grid.forEachParticleInRadius(
          particle.position,
          radius,
          (neighbor, distanceSq) => {
            const weight = pow(max(float(1).sub(distanceSq.div(max(radius.mul(radius), 1e-12))), 0), 3);
            support.addAssign(weight);
            count.addAssign(1);
            if (anisotropic) {
              const offset = neighbor.position.sub(particle.position);
              center.addAssign(offset.mul(weight));
              diagonal.addAssign(offset.mul(offset).mul(weight));
              offDiagonal.addAssign(
                vec3(offset.x.mul(offset.y), offset.x.mul(offset.z), offset.y.mul(offset.z)).mul(weight),
              );
            }
          },
          { excludeIndex: particle.index },
        );
        const bulk = this.bulk(support).toVar();
        // A sub-voxel isolated droplet needs at least one interior sample at any grid phase.
        const visualRadius = mix(max(particle.speed, this.cellSize), particle.speed, bulk).toVar();
        const h = visualRadius.mul(this.influence).toVar();
        const ratio = visualRadius.div(h);
        const isolated = this.isoLevel.div(pow(float(1).sub(ratio.mul(ratio)), 3).max(1e-6));
        // Constant integral for bulk kernels as influence support changes; not global dilation.
        const massAmplitude = pow(ratio, 3).mul(0.8 * (2.4 / 1.55) ** 3);
        const amplitude = mix(isolated, massAmplitude, bulk).toVar();
        const axes = [vec3(1, 0, 0).toVar(), vec3(0, 1, 0).toVar(), vec3(0, 0, 1).toVar()];
        const stretch = vec3(1).toVar();
        if (anisotropic)
          If(count.greaterThanEqual(this.minimumNeighbors).and(support.greaterThan(1e-6)), () => {
            const mean = center.div(support).toVar();
            const d = diagonal
              .div(support)
              .sub(mean.mul(mean))
              .max(vec3(h.mul(h).mul(0.001)))
              .toVar();
            const o = offDiagonal
              .div(support)
              .sub(vec3(mean.x.mul(mean.y), mean.x.mul(mean.z), mean.y.mul(mean.z)))
              .toVar();
            const matrix = [
              [d.x, o.x, o.y],
              [o.x, d.y, o.z],
              [o.y, o.z, d.z],
            ];
            // Fixed Jacobi sweeps avoid convergence loops and handle rank-deficient sheets/streams.
            for (let sweep = 0; sweep < 4; sweep++)
              for (const [p, q] of [
                [0, 1],
                [0, 2],
                [1, 2],
              ]) {
                const apq = matrix[p][q];
                If(apq.abs().greaterThan(h.mul(h).mul(1e-7)), () => {
                  const tau = matrix[q][q].sub(matrix[p][p]).div(apq.mul(2)).toVar();
                  const t = tau
                    .greaterThanEqual(0)
                    .select(1, -1)
                    .div(tau.abs().add(sqrt(tau.mul(tau).add(1))))
                    .toVar();
                  const cosine = sqrt(t.mul(t).add(1)).reciprocal().toVar();
                  const sine = t.mul(cosine).toVar();
                  matrix[p][p].subAssign(t.mul(apq));
                  matrix[q][q].addAssign(t.mul(apq));
                  const r = 3 - p - q;
                  const arp = matrix[r][p].toVar(),
                    arq = matrix[r][q].toVar();
                  matrix[r][p].assign(cosine.mul(arp).sub(sine.mul(arq)));
                  matrix[r][q].assign(sine.mul(arp).add(cosine.mul(arq)));
                  apq.assign(0);
                  const vp = axes[p].toVar(),
                    vq = axes[q].toVar();
                  axes[p].assign(vp.mul(cosine).sub(vq.mul(sine)));
                  axes[q].assign(vp.mul(sine).add(vq.mul(cosine)));
                });
              }
            const eigenvalues = d.max(vec3(h.mul(h).mul(0.001)));
            const geometricMean = pow(eigenvalues.x.mul(eigenvalues.y).mul(eigenvalues.z), 1 / 3);
            stretch.assign(
              eigenvalues
                .div(geometricMean.max(1e-12))
                .sqrt()
                .clamp(this.maximumStretch.reciprocal(), this.maximumStretch),
            );
            stretch.assign(mix(vec3(1), stretch, this.strength.mul(bulk)));
          });
        const determinant = stretch.x.mul(stretch.y).mul(stretch.z).max(1e-6);
        output.element(index).assign(vec4(axes[0].div(stretch.x), amplitude.div(determinant)));
        output.element(index.add(1)).assign(vec4(axes[1].div(stretch.y), support));
        output.element(index.add(2)).assign(vec4(axes[2].div(stretch.z), h));
      });
    });
  }
}
