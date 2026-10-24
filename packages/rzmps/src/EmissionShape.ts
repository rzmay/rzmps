import * as THREE from 'three';
import { BufferAttribute } from 'three';
import { MeshSurfaceSampler } from 'three/examples/jsm/math/MeshSurfaceSampler.js';
import { MeshBVH } from 'three-mesh-bvh';
import { EmissionSource } from './enums/EmissionSource';
import { getGPUEmissionShapeSupport, type GPUEmissionSupportReport } from './gpu/Emission';
import isPointInMesh, {
  countDistinctRayHits,
  POINT_IN_MESH_DIRECTIONS,
} from './helpers/isPointInMesh';

/** Fixed table size or a logarithmic estimate derived from a small ray probe pass. */
export type VolumeSampleCount = number | 'auto';

/** One reusable interior sample used by CPU and GPU volume emission. */
export interface VolumeSample {
  position: THREE.Vector3;
  normal: THREE.Vector3;
  radius: number;
  neighbors?: number[];
}

export interface EmissionShapeOptions {
    /** Source mesh geometry; should be nondegenerate and suitable for the chosen sampling rule. */
    geometry: THREE.BufferGeometry;
    /** Volume, surface, or vertex sampling. Defaults to EmissionSource.Volume. */
    source: EmissionSource | `${EmissionSource}`;
    /** Number of shared CPU/GPU volume samples, or an automatically estimated count. Defaults to auto. */
    volumeSamples: VolumeSampleCount;
}

export type EmissionShapeFactoryOptions = Omit<Partial<EmissionShapeOptions>, 'geometry'>;

type BoxGeometryArgs = ConstructorParameters<typeof THREE.BoxGeometry>;
type SphereGeometryArgs = ConstructorParameters<typeof THREE.SphereGeometry>;
type ConeGeometryArgs = ConstructorParameters<typeof THREE.ConeGeometry>;
type TorusGeometryArgs = ConstructorParameters<typeof THREE.TorusGeometry>;

/** Samples geometry in parent space for emitter positions and normals; Object3D transforms move the source. */
class EmissionShape extends THREE.Object3D {
    static MAX_VOLUME_ITERATIONS = 32;

    static AUTO_VOLUME_PROBES = 32;

    static MIN_AUTO_VOLUME_SAMPLES = 256;

    static MAX_AUTO_VOLUME_SAMPLES = 4096;

    private static readonly _doubleSidedMaterial = new THREE.MeshBasicMaterial(
      { side: THREE.DoubleSide },
    );

    static Box(options: EmissionShapeFactoryOptions, ...args: BoxGeometryArgs): EmissionShape;
    static Box(...args: BoxGeometryArgs): EmissionShape;
    static Box(first?: EmissionShapeFactoryOptions | BoxGeometryArgs[0], ...rest: unknown[]): EmissionShape {
      const { options, geometryArgs } = EmissionShape.resolveFactoryArgs<BoxGeometryArgs>(first, rest);
      return new EmissionShape({ ...options, geometry: new THREE.BoxGeometry(...geometryArgs) });
    }

    static Sphere(options: EmissionShapeFactoryOptions, ...args: SphereGeometryArgs): EmissionShape;
    static Sphere(...args: SphereGeometryArgs): EmissionShape;
    static Sphere(first?: EmissionShapeFactoryOptions | SphereGeometryArgs[0], ...rest: unknown[]): EmissionShape {
      const { options, geometryArgs } = EmissionShape.resolveFactoryArgs<SphereGeometryArgs>(first, rest);
      return new EmissionShape({ ...options, geometry: new THREE.SphereGeometry(...geometryArgs) });
    }

    static Cone(options: EmissionShapeFactoryOptions, ...args: ConeGeometryArgs): EmissionShape;
    static Cone(...args: ConeGeometryArgs): EmissionShape;
    static Cone(first?: EmissionShapeFactoryOptions | ConeGeometryArgs[0], ...rest: unknown[]): EmissionShape {
      const { options, geometryArgs } = EmissionShape.resolveFactoryArgs<ConeGeometryArgs>(first, rest);
      return new EmissionShape({ ...options, geometry: new THREE.ConeGeometry(...geometryArgs) });
    }

    static Torus(options: EmissionShapeFactoryOptions, ...args: TorusGeometryArgs): EmissionShape;
    static Torus(...args: TorusGeometryArgs): EmissionShape;
    static Torus(first?: EmissionShapeFactoryOptions | TorusGeometryArgs[0], ...rest: unknown[]): EmissionShape {
      const { options, geometryArgs } = EmissionShape.resolveFactoryArgs<TorusGeometryArgs>(first, rest);
      return new EmissionShape({ ...options, geometry: new THREE.TorusGeometry(...geometryArgs) });
    }

    private static resolveFactoryArgs<T extends unknown[]>(
      first: unknown,
      rest: unknown[],
    ): { options: EmissionShapeFactoryOptions; geometryArgs: T } {
      if (first && typeof first === 'object' && !Array.isArray(first)) {
        return {
          options: first as EmissionShapeFactoryOptions,
          geometryArgs: rest as T,
        };
      }

      return {
        options: {},
        geometryArgs: (first === undefined ? rest : [first, ...rest]) as T,
      };
    }

    source: EmissionSource;

    private _volumeSamples: VolumeSampleCount = 'auto';

    private _version = 0;

    private _geometry: THREE.BufferGeometry;

    private _surfaceSampler: MeshSurfaceSampler;

    private _vertexNormals: THREE.Vector3[] = [];

    private _mesh: THREE.Mesh;

    private _volumeSampleCache?: {
      signature: string;
      samples: VolumeSample[];
    };

    /** Creates a shape with sphere geometry and volume sampling by default. */
    constructor(options: Partial<EmissionShapeOptions> = {}) {
      super();

      this._geometry = options.geometry ?? new THREE.SphereGeometry();
      this.source = (options.source as EmissionSource) ?? EmissionSource.Volume;
      this._volumeSamples = EmissionShape.normalizeVolumeSamples(options.volumeSamples ?? 'auto');

      this._mesh = new THREE.Mesh(this._geometry, EmissionShape._doubleSidedMaterial);
      this._surfaceSampler = new MeshSurfaceSampler(this._mesh)
        .build();

      this.computeVertexNormals();
      this._geometry.computeBoundingBox();
    }

    set geometry(value: THREE.BufferGeometry) {
      this._geometry = value;
      this._mesh = new THREE.Mesh(this._geometry, EmissionShape._doubleSidedMaterial);
      this._surfaceSampler = new MeshSurfaceSampler(this._mesh).build();
      this._volumeSampleCache = undefined;

      this.computeVertexNormals();
      this._geometry.computeBoundingBox();
      this._mesh.updateMatrix();
      this._version += 1;
    }

    get geometry() { return this._geometry; }

    get version(): number { return this._version; }

    set volumeSamples(value: VolumeSampleCount) {
      const next = EmissionShape.normalizeVolumeSamples(value);
      if (next === this._volumeSamples) return;
      this._volumeSamples = next;
      this._volumeSampleCache = undefined;
      this._version += 1;
    }

    get volumeSamples(): VolumeSampleCount { return this._volumeSamples; }

    /** Actual cached table size after automatic estimation and clamping. */
    get resolvedVolumeSamples(): number {
      return this.getVolumeSamples().length;
    }

    /** Reports whether this geometry exposes the attributes required by GPU emission. */
    getGPUEmissionSupport(): GPUEmissionSupportReport {
      return getGPUEmissionShapeSupport(this);
    }

    get vertices() {
      const vertices: BufferAttribute = this._geometry.getAttribute('position') as BufferAttribute;
      const res: THREE.Vector3[] = [];

      for (let i = 0; i < vertices.array.length; i += 3) {
        res.push(new THREE.Vector3(
          vertices.array[i],
          vertices.array[i + 1],
          vertices.array[i + 2],
        ));
      }

      return res;
    }

    computeVertexNormals(): void {
      this._geometry.computeVertexNormals();
      const vertexNormals: BufferAttribute = this._geometry.getAttribute('normal') as BufferAttribute;
      const res: THREE.Vector3[] = [];

      for (let i = 0; i < vertexNormals.array.length; i += 3) {
        res.push(new THREE.Vector3(
          vertexNormals.array[i],
          vertexNormals.array[i + 1],
          vertexNormals.array[i + 2],
        ));
      }

      this._vertexNormals = res;
    }

    private _toParentPosition(localPosition: THREE.Vector3): THREE.Vector3 {
      this.updateWorldMatrix(true, false);

      const worldPosition = localPosition.clone().applyMatrix4(
        this.matrixWorld,
      );

      return this.parent
        ? this.parent.worldToLocal(worldPosition)
        : worldPosition;
    }

    private _toParentNormal(localNormal: THREE.Vector3): THREE.Vector3 {
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(
        this.matrix,
      );

      return localNormal
        .clone()
        .applyNormalMatrix(normalMatrix)
        .normalize();
    }

    /** Samples position and normal in parent space; volume rejection falls back to surface sampling after a bounded number of attempts. */
    getPoint(overrideSource?: EmissionSource): { position: THREE.Vector3, normal: THREE.Vector3 } {
      switch (overrideSource ?? this.source) {
        case EmissionSource.Vertices:
          // Select random vertex
          const { vertices } = this;
          const vertexIndex = Math.floor(Math.random() * vertices.length);
          return {
            position: this._toParentPosition(vertices[vertexIndex]),
            normal: this._toParentNormal(this._vertexNormals[vertexIndex]),
          };

        case EmissionSource.Surface:
          // Use surface sampler to find random point on surface
          const position: THREE.Vector3 = new THREE.Vector3(0, 0, 0);
          const normal: THREE.Vector3 = new THREE.Vector3(0, 0, 0);
          this._surfaceSampler.sample(position, normal);
          return {
            position: this._toParentPosition(position),
            normal: this._toParentNormal(normal),
          };

        case EmissionSource.Volume:
        default:
          const samples = this.getVolumeSamples();
          if (samples.length === 0) return this.getPoint(EmissionSource.Surface);
          const sampleIndex = Math.floor(Math.random() * samples.length);
          const sample = samples[sampleIndex];
          const z = Math.random() * 2 - 1;
          const angle = Math.random() * Math.PI * 2;
          const radial = Math.sqrt(Math.max(0, 1 - z * z));
          const jitter = new THREE.Vector3(
            Math.cos(angle) * radial,
            Math.sin(angle) * radial,
            z,
          ).multiplyScalar(Math.random() * sample.radius);
          const sampledPosition = sample.position.clone().add(jitter);
          const sampledNormal = new THREE.Vector3();
          let totalWeight = 0;
          [sampleIndex, ...(sample.neighbors ?? [])].forEach((neighborIndex) => {
            const neighbor = samples[neighborIndex];
            const weight = 1 / Math.max(
              sampledPosition.distanceToSquared(neighbor.position),
              1e-8,
            );
            sampledNormal.addScaledVector(neighbor.normal, weight);
            totalWeight += weight;
          });
          if (totalWeight > 0) sampledNormal.divideScalar(totalWeight).normalize();
          if (sampledNormal.lengthSq() <= Number.EPSILON) sampledNormal.copy(sample.normal);
          return {
            position: this._toParentPosition(sampledPosition),
            normal: this._toParentNormal(sampledNormal),
          };
      }
    }

    /** Returns the local-space sample table shared by CPU and GPU volume emission. */
    getVolumeSamples(): readonly VolumeSample[] {
      const position = this._geometry.getAttribute('position');
      const index = this._geometry.index;
      const signature = [
        this._version,
        position?.count ?? 0,
        getAttributeVersion(position),
        index?.count ?? 0,
        index?.version ?? 0,
      ].join(':');
      if (this._volumeSampleCache?.signature === signature) {
        return this._volumeSampleCache.samples;
      }

      if (!position || position.count < 3) {
        this._volumeSampleCache = { signature, samples: [] };
        return this._volumeSampleCache.samples;
      }

      // Build on a clone because MeshBVH may generate or reorder an index buffer.
      const samplingGeometry = this._geometry.clone();
      samplingGeometry.computeBoundingBox();
      const bounds = samplingGeometry.boundingBox;
      if (!bounds || bounds.isEmpty()) {
        samplingGeometry.dispose();
        this._volumeSampleCache = { signature, samples: [] };
        return this._volumeSampleCache.samples;
      }

      const bvh = new MeshBVH(samplingGeometry);
      const boundsSize = bounds.getSize(new THREE.Vector3());
      const boundsDiagonal = Math.max(boundsSize.length(), Number.EPSILON);
      const rayDirection = POINT_IN_MESH_DIRECTIONS[0];
      const negativeRayDirection = rayDirection.clone().negate();
      const candidate = new THREE.Vector3();
      // Rotate the Halton set per bake to retain even coverage without fixing
      // every geometry to the same sequence alignment.
      const sequenceOffset = new THREE.Vector3(Math.random(), Math.random(), Math.random());
      let candidateIndex = 1;

      const distinctHitCount = (origin: THREE.Vector3, direction: THREE.Vector3): number => {
        return countDistinctRayHits(origin, direction, bvh, boundsDiagonal * 1e-7);
      };

      let sampleCount = typeof this._volumeSamples === 'number' ? this._volumeSamples : 256;
      if (this._volumeSamples === 'auto') {
        const crossings: number[] = [];
        const safeRadii: number[] = [];
        const probeDirection = new THREE.Vector3();
        const probeClosest = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
        for (let probe = 1; probe <= EmissionShape.AUTO_VOLUME_PROBES; probe += 1) {
          candidate.set(
            THREE.MathUtils.lerp(bounds.min.x, bounds.max.x, halton(probe, 2)),
            THREE.MathUtils.lerp(bounds.min.y, bounds.max.y, halton(probe, 3)),
            THREE.MathUtils.lerp(bounds.min.z, bounds.max.z, halton(probe, 5)),
          );
          const probeZ = halton(probe, 7) * 2 - 1;
          const probeAngle = halton(probe, 11) * Math.PI * 2;
          const probeRadial = Math.sqrt(Math.max(0, 1 - probeZ * probeZ));
          probeDirection.set(
            Math.cos(probeAngle) * probeRadial,
            Math.sin(probeAngle) * probeRadial,
            probeZ,
          );
          const forwardCrossings = distinctHitCount(candidate, probeDirection);
          const count = forwardCrossings
            + distinctHitCount(candidate, probeDirection.clone().negate());
          if (count > 0) crossings.push(count);
          if (forwardCrossings % 2 === 1) {
            const result = bvh.closestPointToPoint(candidate, probeClosest);
            if (result && result.distance > 0) safeRadii.push(result.distance);
          }
        }
        crossings.sort((a, b) => a - b);
        safeRadii.sort((a, b) => a - b);
        const percentileIndex = Math.floor(Math.max(0, crossings.length - 1) * 0.9);
        const layers = Math.max(1, (crossings[percentileIndex] ?? 2) / 2);
        const medianRadius = safeRadii[Math.floor(safeRadii.length / 2)] ?? boundsDiagonal;
        const radiusComplexity = boundsDiagonal / Math.max(medianRadius, boundsDiagonal * 1e-6);
        const estimated = 256 * (
          1
          + Math.log2(layers)
          + 0.5 * Math.log2(Math.max(1, radiusComplexity / 24))
        );
        sampleCount = THREE.MathUtils.clamp(
          Math.ceil(estimated / 128) * 128,
          EmissionShape.MIN_AUTO_VOLUME_SAMPLES,
          EmissionShape.MAX_AUTO_VOLUME_SAMPLES,
        );
      }

      const samples: VolumeSample[] = [];
      const closest = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
      const triangle = new THREE.Triangle();
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      const c = new THREE.Vector3();
      const samplingPosition = samplingGeometry.getAttribute('position');
      const samplingIndex = samplingGeometry.index;
      for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
        let found = false;
        for (let attempt = 0; attempt < EmissionShape.MAX_VOLUME_ITERATIONS; attempt += 1) {
          const sequencePoint = candidateIndex;
          candidateIndex += 1;
          candidate.set(
            THREE.MathUtils.lerp(
              bounds.min.x,
              bounds.max.x,
              (halton(sequencePoint, 2) + sequenceOffset.x) % 1,
            ),
            THREE.MathUtils.lerp(
              bounds.min.y,
              bounds.max.y,
              (halton(sequencePoint, 3) + sequenceOffset.y) % 1,
            ),
            THREE.MathUtils.lerp(
              bounds.min.z,
              bounds.max.z,
              (halton(sequencePoint, 5) + sequenceOffset.z) % 1,
            ),
          );
          if (isPointInMesh(candidate, bvh, boundsDiagonal)) {
            found = true;
            break;
          }
        }

        if (!found) {
          const surfacePosition = new THREE.Vector3();
          const surfaceNormal = new THREE.Vector3();
          this._surfaceSampler.sample(surfacePosition, surfaceNormal);
          samples.push({
            position: surfacePosition,
            normal: surfaceNormal.normalize(),
            radius: 0,
            neighbors: [],
          });
          continue;
        }

        const closestResult = bvh.closestPointToPoint(candidate, closest);
        if (!closestResult) continue;
        const triangleOffset = closestResult.faceIndex * 3;
        const ia = samplingIndex?.getX(triangleOffset) ?? triangleOffset;
        const ib = samplingIndex?.getX(triangleOffset + 1) ?? triangleOffset + 1;
        const ic = samplingIndex?.getX(triangleOffset + 2) ?? triangleOffset + 2;
        a.fromBufferAttribute(samplingPosition, ia);
        b.fromBufferAttribute(samplingPosition, ib);
        c.fromBufferAttribute(samplingPosition, ic);
        const normal = triangle.set(a, b, c).getNormal(new THREE.Vector3());
        samples.push({
          position: candidate.clone(),
          normal,
          radius: Math.max(0, closestResult.distance - boundsDiagonal * 1e-6),
          neighbors: [],
        });
      }

      // Bake a small neighborhood once so runtime normal interpolation does
      // not scan the complete sample table for every emitted particle.
      samples.forEach((sample, sampleIndex) => {
        const nearest: Array<{ index: number; distanceSq: number }> = [];
        samples.forEach((candidateSample, candidateIndex) => {
          if (candidateIndex === sampleIndex) return;
          const distanceSq = sample.position.distanceToSquared(candidateSample.position);
          const insertAt = nearest.findIndex((entry) => distanceSq < entry.distanceSq);
          if (insertAt < 0) {
            if (nearest.length < 3) nearest.push({ index: candidateIndex, distanceSq });
          } else {
            nearest.splice(insertAt, 0, { index: candidateIndex, distanceSq });
            if (nearest.length > 3) nearest.pop();
          }
        });
        sample.neighbors = nearest.map((entry) => entry.index);
      });

      // Keep the cache local-space; transforms can change without rebaking geometry.
      this._volumeSampleCache = { signature, samples };
      samplingGeometry.dispose();
      return samples;
    }

    private static normalizeVolumeSamples(value: VolumeSampleCount): VolumeSampleCount {
      if (value === 'auto') return value;
      return Math.max(1, Math.floor(Number.isFinite(value) ? value : 256));
    }
}

function halton(index: number, base: number): number {
  let result = 0;
  let fraction = 1 / base;
  let value = index;
  while (value > 0) {
    result += fraction * (value % base);
    value = Math.floor(value / base);
    fraction /= base;
  }
  return result;
}

function getAttributeVersion(attribute?: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): number {
  if (!attribute) return 0;
  return 'data' in attribute ? attribute.data.version : attribute.version;
}

export default EmissionShape;
