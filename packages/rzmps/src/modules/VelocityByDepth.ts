import * as THREE from 'three';
import Module, { ModuleOptions } from '../Module';
import Particle from '../Particle';
import type ParticleSystem from '../ParticleSystem';
import type { ValueByParameter } from '../types/ValueByParameter';
import evaluateByParameterVector from '../helpers/evaluateByParameterVector3';

export interface VelocityByDepthOptions extends Partial<ModuleOptions> {
  velocity: ValueByParameter<THREE.Vector3>;
  depthRange?: [number, number];
}

class VelocityByDepth extends Module {
  cameraPosition: THREE.Vector3 = new THREE.Vector3();
  depthRange?: [number, number];

  private _cameraDepthRange: [number, number] = [0, 100];

  constructor(public options: Partial<VelocityByDepthOptions> = {}) {
    super((particle: Particle) => {
      particle.velocity = particle.start.velocity.clone().add(
        evaluateByParameterVector(
          this.options.velocity ?? new THREE.Vector3(),
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

export default VelocityByDepth;
