import * as THREE from 'three';
import Module, { ModuleOptions } from '../Module';
import Particle from '../Particle';
import type ParticleSystem from '../ParticleSystem';
import type { ValueByParameter } from '../types/ValueByParameter';
import evaluateByParameterNumber from '../helpers/evaluateByParameterNumber';

export interface DistortionByDepthOptions extends Partial<ModuleOptions> {
  distortionStrength: ValueByParameter<number>;
  /** Camera-distance interval mapped to zero through one; omitted endpoints use camera near/far when available. */
  depthRange?: [number, number];
}

/** Multiplies distortion strength using distance from the captured camera, normalized over depthRange; two-value parameter ranges interpolate rather than randomly sample. */
class DistortionByDepth extends Module {
  cameraPosition: THREE.Vector3 = new THREE.Vector3();
  depthRange?: [number, number];

  private _cameraDepthRange: [number, number] = [0, 100];

  /** Creates the modifier with its built-in priority and optional filtering/LOD settings. */
  constructor(public options: Partial<DistortionByDepthOptions> = {}) {

    super((particle: Particle) => {
      const t = THREE.MathUtils.clamp(
        THREE.MathUtils.mapLinear(
          particle.position.distanceTo(this.cameraPosition),
          this.depthRange?.[0] ?? this._cameraDepthRange[0],
          this.depthRange?.[1] ?? this._cameraDepthRange[1],
          0,
          1,
        ),
        0,
        1,
      );

      particle.distortionStrength *= evaluateByParameterNumber(
        this.options.distortionStrength ?? 1,
        t,
      );
    }, {
      ...options,
      priority: Module.Priority.Transient,
    });

    this.depthRange = options.depthRange;
  }

  public prepare(particleSystem: ParticleSystem): void {
    const camera = particleSystem.sceneCamera;

    if (camera) {
      camera.getWorldPosition(this.cameraPosition);

      if (particleSystem.simulationSpace !== 'world') {
        particleSystem.worldToLocal(this.cameraPosition);
      }

      if (camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera) {
        this._cameraDepthRange = [camera.near, camera.far];
      }
    }
  }

}

export default DistortionByDepth;
