import * as THREE from 'three';
import Module, { ModuleOptions } from '../Module';
import Particle from '../Particle';
import type ParticleSystem from '../ParticleSystem';
import type { ValueByParameter } from '../types/ValueByParameter';
import type { Node } from 'three/webgpu';
import { vec3 } from 'three/tsl';
import evaluateByParameterNumber from '../helpers/evaluateByParameterNumber';
import {
  evaluateByParameterNumberGPU,} from '../helpers/evaluateByParameterGPU';

export interface DistortionByDepthOptions extends Partial<ModuleOptions> {
  distortionStrength: ValueByParameter<number>;
  depthRange?: [number, number];
}

class DistortionByDepth extends Module {
  cameraPosition: THREE.Vector3 = new THREE.Vector3();
  depthRange?: [number, number];

  private _cameraDepthRange: [number, number] = [0, 100];

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
      priority: 1,
      ...options,
      modifyGPU: (particle) => {
          particle.distortionStrength.assign(
            particle.distortionStrength.mul(evaluateByParameterNumberGPU(
              this.options.distortionStrength ?? 1,
              this.getDepthTimeGPU(particle.position),
              1,
            )),
          );
        }
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

  private getDepthTimeGPU(position: Node<'vec3'>) {
    const min = this.depthRange?.[0] ?? this._cameraDepthRange[0];
    const max = this.depthRange?.[1] ?? this._cameraDepthRange[1];

    return position.sub(vec3(this.cameraPosition)).length().sub(min).div(max - min || 1).clamp(0, 1);
  }
}

export default DistortionByDepth;
