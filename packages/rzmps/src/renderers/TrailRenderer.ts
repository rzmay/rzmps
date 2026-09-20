import * as THREE from 'three';
import seedrandom from 'seedrandom';
import Renderer, { type RendererOptions } from '../Renderer';
import Particle from '../Particle';
import ParticleSystem from '../ParticleSystem';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicNumber from '../helpers/evaluateDynamicNumber';
import evaluateDynamicColor from '../helpers/evaluateDynamicColor';
import { TrailMode } from '../enums/TrailMode';
import { TrailTextureMode } from '../enums/TrailTextureMode';
import defaultTex from '../assets/textures/default.png';

export const TRAIL_RENDERER_USER_DATA_KEY = "__rzmps_trailRenderer";

export interface TrailRendererOptions extends RendererOptions {
  mode: TrailMode | `${TrailMode}`;
  texture: string | THREE.Texture;
  textureMode: TrailTextureMode | `${TrailTextureMode}`;

  ratio: number;
  lifetime: DynamicValue<number>;
  minimumVertexDistance: number;
  dieWithParticles: boolean;
  ribbonCount: number;

  width: DynamicValue<number>;
  widthOverTrail: DynamicValue<number>;

  sizeAffectsWidth: boolean;
  sizeAffectsLifetime: boolean;

  inheritParticleColor: boolean;
  colorOverLifetime: DynamicValue<THREE.Color>;
  colorOverTrail: DynamicValue<THREE.Color>;

  material: THREE.Material;
  materialOptions: THREE.MeshStandardMaterialParameters;

  castShadow: boolean;
  receiveShadow: boolean;
}

type TrailPoint = {
  position: THREE.Vector3;
  createdAt: number;
  expiresAt: number;
}

type ParticleTrail = {
  particleId: string;
  points: TrailPoint[];
  alive: boolean;
  headPosition: THREE.Vector3;

  particleTime: number;
  particleColor: THREE.Color;
  particleAlpha: number;
  particleSize: number;
}

type RenderPoint = {
  position: THREE.Vector3;
  particleTime: number;
  particleColor: THREE.Color;
  particleAlpha: number;
  particleSize: number;
  particleId: string;
}

class TrailRenderer extends Renderer {
  mode: TrailMode = TrailMode.Particle;

  texture: THREE.Texture;

  ratio = 1;

  lifetime: DynamicValue<number> = 1;

  minimumVertexDistance = 0.1;

  dieWithParticles = true;

  ribbonCount = 1;

  textureMode: TrailTextureMode = TrailTextureMode.Stretch;

  width: DynamicValue<number> = 1;

  sizeAffectsWidth = false;

  sizeAffectsLifetime = false;

  inheritParticleColor = true;

  colorOverLifetime: DynamicValue<THREE.Color> =
    new THREE.Color(0xffffff);

  widthOverTrail: DynamicValue<number> = 1;

  colorOverTrail: DynamicValue<THREE.Color> =
    new THREE.Color(0xffffff);

  geometry: THREE.BufferGeometry;

  material: THREE.Material | THREE.Material[];

  mesh: THREE.Mesh;

  castShadow = false;

  receiveShadow = false;

  private particles: Particle[] = [];

  private trails: Map<string, ParticleTrail> =
    new Map();

  private elapsedTime = 0;

  constructor(
    options: Partial<TrailRendererOptions> = {},
  ) {
    super(options);

    const textureLoader = new THREE.TextureLoader();
    if (options.texture) {
      this.texture = typeof options.texture === 'string' ? textureLoader.load(options.texture) : options.texture;
    } else {
      // If a map is provided via material options, use that before using the default texture
      this.texture = options.materialOptions?.map ?? new THREE.TextureLoader().load(defaultTex);
    }

    this.mode = (options.mode as TrailMode) ?? this.mode;
    this.ratio = options.ratio ?? this.ratio;
    this.lifetime = options.lifetime ?? this.lifetime;
    this.minimumVertexDistance = options.minimumVertexDistance ?? this.minimumVertexDistance;
    this.dieWithParticles = options.dieWithParticles ?? this.dieWithParticles;
    this.ribbonCount = options.ribbonCount ?? this.ribbonCount;
    this.textureMode = (options.textureMode as TrailTextureMode) ?? this.textureMode;

    this.width = options.width ?? this.width;
    this.sizeAffectsWidth = options.sizeAffectsWidth ?? this.sizeAffectsWidth;
    this.sizeAffectsLifetime = options.sizeAffectsLifetime ?? this.sizeAffectsLifetime;
    this.widthOverTrail = options.widthOverTrail ?? this.widthOverTrail;

    this.inheritParticleColor = options.inheritParticleColor ?? this.inheritParticleColor;
    this.colorOverLifetime = options.colorOverLifetime ?? this.colorOverLifetime;
    this.colorOverTrail = options.colorOverTrail ?? this.colorOverTrail;

    this.castShadow = options.castShadow ?? this.castShadow;
    this.receiveShadow = options.receiveShadow ?? this.receiveShadow;

    this.geometry = new THREE.BufferGeometry();
    this.setEmptyGeometry();

    this.material = options.material ?? new THREE.MeshStandardMaterial({
      map: this.texture,
      vertexColors: true,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,

      ...options.materialOptions,
    });
    this.preprocessMaterial(this.material);

    this.mesh = new THREE.Mesh(
      this.geometry,
      this.material,
    );

    // Add user data to the mesh so we can recognize it elsewhere
    this.mesh.userData[TRAIL_RENDERER_USER_DATA_KEY] = true;

    this.mesh.frustumCulled = false;
  }

  setup(system: ParticleSystem): void {
    system.addRendererObject(this.mesh);

    this.mesh.onBeforeRender = (renderer, _scene, camera) => {
      if (!(renderer as { isWebGPURenderer?: boolean }).isWebGPURenderer) return;

      this.rebuildGeometry(camera);
    };
  }

  _update(particles: Particle[], system: ParticleSystem, deltaTime: number): void {
    this.particles = particles;
    this.elapsedTime += Math.max(0, deltaTime);

    this.mesh.castShadow = this.castShadow;
    this.mesh.receiveShadow = this.receiveShadow;

    if (this.mode === TrailMode.Particle) {
      this.updateParticleTrails(
        particles,
      );
    }

    if (system.sceneCamera) {
      this.rebuildGeometry(system.sceneCamera);
    }
  }

  destroy(): void {
    this.geometry.dispose();

    this.trails.clear();

    this.mesh.removeFromParent();
  }

  private updateParticleTrails(particles: Particle[]): void {
    const now = this.elapsedTime;
    const aliveParticles = new Set<string>();

    // Adding new trail points
    particles.forEach((particle) => {
      aliveParticles.add(particle.id);

      if (!this.particleHasTrail(particle.id)) {
        return;
      }

      let trail = this.trails.get(particle.id);

      if (!trail) {
        trail = {
          particleId: particle.id,
          points: [],
          alive: true,
          headPosition: particle.position.clone(),
          particleTime: particle.time,
          particleColor: particle.color.clone(),
          particleAlpha: particle.alpha,
          particleSize: this.getParticleSize(particle),
        };

        this.trails.set(particle.id, trail);

        this.addTrailPoint(
          trail,
          particle,
          now,
        );
      }

      trail.alive = true;
      trail.headPosition.copy(particle.position);
      trail.particleTime = particle.time;
      trail.particleColor.copy(particle.color);
      trail.particleAlpha = particle.alpha;

      trail.particleSize = this.getParticleSize(particle);

      const lastPoint = trail.points[trail.points.length - 1];

      if (
        !lastPoint
        || lastPoint.position.distanceTo(particle.position) >= this.minimumVertexDistance
      ) {
        this.addTrailPoint(
          trail,
          particle,
          now,
        );
      }
    });

    // Disposing of dead trails
    for (const [id, trail] of this.trails) {
      if (!aliveParticles.has(id)) {
        trail.alive = false;

        if (this.dieWithParticles) {
          this.trails.delete(id);

          continue;
        }
      }

      while (trail.points.length > 0 && trail.points[0].expiresAt <= now) {
        trail.points.shift();
      }

      if (!trail.alive && trail.points.length === 0) {
        this.trails.delete(id);
      }
    }
  }

  private addTrailPoint(trail: ParticleTrail, particle: Particle, now: number): void {
    let vertexLifetime = particle.lifetime * evaluateDynamicNumber(
      this.lifetime,
      particle.time,
      particle.id,
    );

    if (this.sizeAffectsLifetime) {
      vertexLifetime *= this.getParticleSize(
        particle,
      );
    }

    trail.points.push({
      position: particle.position.clone(),
      createdAt: now,
      expiresAt: now + Math.max(
        0,
        vertexLifetime,
      ),
    });
  }

  private getPaths(): RenderPoint[][] {
    if (this.mode === TrailMode.Ribbon) {
      return this.getRibbonPaths();
    }

    return this.getParticlePaths();
  }

  private getParticlePaths(): RenderPoint[][] {
    const paths: RenderPoint[][] = [];

    for (const trail of this.trails.values()) {
      if (trail.points.length === 0) {
        continue;
      }

      const path = trail.points.map((point): RenderPoint => ({
        position: point.position,
        particleTime: trail.particleTime,
        particleColor: trail.particleColor,
        particleAlpha: trail.particleAlpha,
        particleSize: trail.particleSize,
        particleId: trail.particleId,
      }));

      if (trail.alive) {
        const lastPosition = path[path.length - 1].position;

        if (lastPosition.distanceToSquared(trail.headPosition) > 0) {
          path.push({
            position: trail.headPosition,
            particleTime: trail.particleTime,
            particleColor: trail.particleColor,
            particleAlpha: trail.particleAlpha,
            particleSize: trail.particleSize,
            particleId: trail.particleId,
          });
        }
      }

      if (path.length >= 2) {
        paths.push(path);
      }
    }

    return paths;
  }

  private getRibbonPaths(): RenderPoint[][] {
    const ribbonCount = Math.max(
      1,
      Math.floor(
        this.ribbonCount,
      ),
    );

    // Ordering based on age
    const particles = this.particles
      .filter((particle) => this.particleHasTrail(particle.id))
      .sort((a, b) => a.startTime - b.startTime);

    const ribbons: RenderPoint[][] = Array.from({ length: ribbonCount }, () => []);

    particles.forEach((particle, index) => {
      const ribbonIndex = index % ribbonCount;

      ribbons[ribbonIndex].push({
        position: particle.position,
        particleTime: particle.time,
        particleColor: particle.color,
        particleAlpha: particle.alpha,
        particleSize: this.getParticleSize(particle),
        particleId: particle.id,
      });
    });

    return ribbons.filter((ribbon) => ribbon.length >= 2);
  }

  private rebuildGeometry(camera: THREE.Camera): void {
    const paths = this.getPaths();

    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];

    const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
    this.mesh.worldToLocal(cameraPosition);

    for (const path of paths) {
      this.appendPathGeometry(
        path,
        cameraPosition,
        positions,
        normals,
        uvs,
        colors,
        indices,
      );
    }

    if (positions.length === 0) {
      this.setEmptyGeometry();
      return;
    }

    this.geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        positions,
        3,
      ),
    );

    this.geometry.setAttribute(
      'normal',
      new THREE.Float32BufferAttribute(
        normals,
        3,
      ),
    );

    this.geometry.setAttribute(
      'uv',
      new THREE.Float32BufferAttribute(
        uvs,
        2,
      ),
    );

    this.geometry.setAttribute(
      'color',
      new THREE.Float32BufferAttribute(
        colors,
        4,
      ),
    );

    this.geometry.setIndex(indices);
    this.geometry.setDrawRange(0, Infinity);

    if (positions.length > 0) {
      this.geometry.computeBoundingSphere();
    } else {
      this.geometry.boundingSphere = null;
    }
  }

  private setEmptyGeometry(): void {
    this.geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        new Float32Array(12),
        3,
      ),
    );

    this.geometry.setAttribute(
      'normal',
      new THREE.Float32BufferAttribute(
        new Float32Array([
          0, 0, 1,
          0, 0, 1,
          0, 0, 1,
          0, 0, 1,
        ]),
        3,
      ),
    );

    this.geometry.setAttribute(
      'uv',
      new THREE.Float32BufferAttribute(
        new Float32Array(8),
        2,
      ),
    );

    this.geometry.setAttribute(
      'color',
      new THREE.Float32BufferAttribute(
        new Float32Array([
          1, 1, 1, 0,
          1, 1, 1, 0,
          1, 1, 1, 0,
          1, 1, 1, 0,
        ]),
        4,
      ),
    );

    this.geometry.setIndex([0, 1, 2, 1, 3, 2]);
    this.geometry.setDrawRange(0, 0);
    this.geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(),
      0,
    );
  }

  private appendPathGeometry(
    path: RenderPoint[],
    cameraPosition: THREE.Vector3,
    positions: number[],
    normals: number[],
    uvs: number[],
    colors: number[],
    indices: number[],
  ): void {
    if (path.length < 2) {
      return;
    }

    const baseVertex = positions.length / 3;
    const distances = new Array<number>(path.length);

    distances[0] = 0;

    for (let i = 1; i < path.length; i++) {
      distances[i] = distances[i - 1] + path[i].position.distanceTo(
        path[i - 1].position,
      );
    }

    const totalDistance = distances[distances.length - 1];

    let previousSide: THREE.Vector3 | undefined;

    for (let i = 0; i < path.length; i++) {
      const point = path[i];
      const trailT = totalDistance > 0 ? distances[i] / totalDistance : 0;
      const tangent = this.getTangent(path, i);

      const viewDirection = cameraPosition.clone().sub(point.position);

      if (viewDirection.lengthSq() > 0) {
        viewDirection.normalize();
      } else {
        viewDirection.set(0, 0, 1);
      }

      const side = new THREE.Vector3().crossVectors(tangent, viewDirection);

      if (side.lengthSq() < 0.000001) {
        if (previousSide) {
          side.copy(previousSide);
        } else {
          side.copy(this.getPerpendicular(tangent));
        }
      }

      side.normalize();

      if (previousSide && side.dot(previousSide) < 0) {
        side.negate();
      }

      previousSide = side.clone();

      const normal = new THREE.Vector3()
        .crossVectors(side, tangent)
        .normalize();

      let width = evaluateDynamicNumber(
        this.width,
        point.particleTime,
        point.particleId,
      );

      width *= evaluateDynamicNumber(
        this.widthOverTrail,
        trailT,
        point.particleId,
      );

      if (this.sizeAffectsWidth) {
        width *= point.particleSize;
      }

      const halfWidth = width * 0.5;
      const left = point.position
        .clone()
        .addScaledVector(side, -halfWidth);

      const right = point.position
        .clone()
        .addScaledVector(side, halfWidth);

      positions.push(
        left.x,
        left.y,
        left.z,

        right.x,
        right.y,
        right.z,
      );

      normals.push(
        normal.x,
        normal.y,
        normal.z,

        normal.x,
        normal.y,
        normal.z,
      );

      const u = this.getTextureU(
        i,
        path.length,
        distances[i],
        totalDistance,
      );

      uvs.push(u, 0, u, 1);

      const lifetimeColor = evaluateDynamicColor(
        this.colorOverLifetime,
        point.particleTime,
        point.particleId,
      ).clone();

      const trailColor = evaluateDynamicColor(
        this.colorOverTrail,
        trailT,
        point.particleId,
      ).clone();

      const finalColor = lifetimeColor.multiply(trailColor);

      if (this.inheritParticleColor) {
        finalColor.multiply(
          point.particleColor,
        );
      }

      const alpha = this.inheritParticleColor ? point.particleAlpha : 1;

      colors.push(
        finalColor.r,
        finalColor.g,
        finalColor.b,
        alpha,

        finalColor.r,
        finalColor.g,
        finalColor.b,
        alpha,
      );
    }

    // Build tris
    for (let i = 0; i < path.length - 1; i++) {
      const a = baseVertex + i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;

      indices.push(a, b, c, b, d, c);
    }
  }

  private getTangent(path: RenderPoint[], index: number): THREE.Vector3 {
    const tangent = new THREE.Vector3();

    if (index === 0) {
      tangent.subVectors(
        path[1].position,
        path[0].position,
      );
    } else if (
      index === path.length - 1
    ) {
      tangent.subVectors(
        path[index].position,
        path[index - 1].position,
      );
    } else {
      tangent.subVectors(
        path[index + 1].position,
        path[index - 1].position,
      );
    }

    /*
     * Duplicate trail positions can otherwise give us an
     * unusable zero-length tangent.
     */
    if (tangent.lengthSq() < 0.000001) {
      if (index > 0) {
        tangent.subVectors(
          path[index].position,
          path[index - 1].position,
        );
      }

      if (tangent.lengthSq() < 0.000001 && index < path.length - 1) {
        tangent.subVectors(
          path[index + 1].position,
          path[index].position,
        );
      }
    }

    if (tangent.lengthSq() < 0.000001) {
      tangent.set(1, 0, 0);
    }

    return tangent.normalize();
  }

  private getPerpendicular(tangent: THREE.Vector3): THREE.Vector3 {
    const reference = Math.abs(tangent.z) < 0.9
      ? new THREE.Vector3(0, 0, 1)
      : new THREE.Vector3(0, 1, 0);

    return new THREE.Vector3()
      .crossVectors(
        tangent,
        reference,
      )
      .normalize();
  }

  private getTextureU(
    index: number,
    pointCount: number,
    distance: number,
    totalDistance: number,
  ): number {
    switch (this.textureMode) {
      case TrailTextureMode.Tile:
        return distance;

      case TrailTextureMode.RepeatPerSegment:
        return index;

      case TrailTextureMode.DistributePerSegment:
        return pointCount > 1 ? index / (pointCount - 1) : 0;

      case TrailTextureMode.Stretch:
      default:
        return totalDistance > 0 ? distance / totalDistance : 0;
    }
  }

  private getParticleSize(particle: Particle): number {
    return Math.max(
      Math.abs(particle.scale.x),
      Math.abs(particle.scale.y),
      Math.abs(particle.scale.z),
    );
  }

  private particleHasTrail(id: string): boolean {
    const ratio = THREE.MathUtils.clamp(this.ratio, 0, 1);

    if (ratio <= 0) {
      return false;
    }

    if (ratio >= 1) {
      return true;
    }

    const random = seedrandom(id).quick();
    return random < ratio;
  }

  private preprocessMaterial(material: THREE.Material | THREE.Material[]): void {
    if (Array.isArray(material)) {
      material.forEach((item) => this.preprocessMaterial(item));
      return;
    }

    material.vertexColors = true;
    material.transparent = true;
    material.needsUpdate = true;
  }
}

export default TrailRenderer;
