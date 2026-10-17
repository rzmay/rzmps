import * as THREE from 'three';
import Module, { ModuleOptions } from '../Module';
import Particle from '../Particle';
import type ParticleSystem from '../ParticleSystem';
import type { ValueByParameter } from '../types/ValueByParameter';
import type { Node } from 'three/webgpu';
import { uniform } from 'three/tsl';
import evaluateByParameterNumber from '../helpers/evaluateByParameterNumber';

export interface DistortionByDepthOptions extends Partial<ModuleOptions> {
  distortionStrength: ValueByParameter<number>;
  depthRange?: [number, number];
}

class DistortionByDepth extends Module {
  cameraPosition: THREE.Vector3 = new THREE.Vector3();
  private readonly _gpuCameraPosition = uniform(this.cameraPosition, 'vec3');
  private readonly _gpuDepthRange = uniform(new THREE.Vector2(), 'vec2');
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
      ...options,
      priority: Module.Priority.Transient,
      modifyGPU: (particle) => {
          particle.distortionStrength.assign(
            particle.distortionStrength.mul(this.gpuParameters.parameterNumber(
              'distortionStrength',
              () => this.options.distortionStrength,
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
    this._gpuDepthRange.value.set(
      this.depthRange?.[0] ?? this._cameraDepthRange[0],
      this.depthRange?.[1] ?? this._cameraDepthRange[1],
    );
  }

  private getDepthTimeGPU(position: Node<'vec3'>) {
    return position.sub(this._gpuCameraPosition).length().sub(this._gpuDepthRange.x)
      .div(this._gpuDepthRange.y.sub(this._gpuDepthRange.x).max(Number.EPSILON)).clamp(0, 1);
  }
}

export default DistortionByDepth;
