import * as THREE from 'three';
import Module, { ModuleOptions } from '../Module';
import Particle from '../Particle';
import type ParticleSystem from '../ParticleSystem';
import type { ValueByParameter } from '../types/ValueByParameter';
import evaluateByParameterNumber from '../helpers/evaluateByParameterNumber';

export interface SpeedByDepthOptions extends Partial<ModuleOptions> {
  speed: ValueByParameter<number>;
  depthRange?: [number, number];
}

class SpeedByDepth extends Module {
  cameraPosition: THREE.Vector3 = new THREE.Vector3();
  depthRange?: [number, number];

  private _cameraDepthRange: [number, number] = [0, 100];

  constructor(public options: Partial<SpeedByDepthOptions> = {}) {
    super((particle: Particle) => {
      particle.speed = particle.start.speed * evaluateByParameterNumber(
        this.options.speed ?? 1,
        THREE.MathUtils.clamp(
          THREE.MathUtils.mapLinear(
            particle.position.distanceTo(this.cameraPosition),
            this.depthRange?.[0] ?? this._cameraDepthRange[0],
            this.depthRange?.[1] ?? this._cameraDepthRange[1],
            0,
            1,
          ),
          0,
          1,
        ),
      );
    }, options);

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

export default SpeedByDepth;
