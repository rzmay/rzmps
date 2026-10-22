import * as THREE from 'three';
import Module, { ModuleOptions } from '../Module';
import Particle from '../Particle';
import type ParticleSystem from '../ParticleSystem';
import type { ValueByParameter } from '../types/ValueByParameter';
import type { Node } from 'three/webgpu';
import { uniform } from 'three/tsl';
import evaluateByParameterVector from '../helpers/evaluateByParameterVector3';

export interface ScaleByDepthOptions extends Partial<ModuleOptions> {
  scale: ValueByParameter<THREE.Vector3>;
  scalarVelocity: ValueByParameter<THREE.Vector3>;
  scalarAcceleration: ValueByParameter<THREE.Vector3>;
  /** Camera-distance interval mapped to zero through one; omitted endpoints use camera near/far when available. */
  depthRange?: [number, number]
}

/** Multiplies scale and adds scalar channels using distance from the captured camera, normalized over depthRange; two-value parameter ranges interpolate rather than randomly sample. */
class ScaleByDepth extends Module {
  cameraPosition: THREE.Vector3 = new THREE.Vector3();
  private readonly _gpuCameraPosition = uniform(this.cameraPosition, 'vec3');
  private readonly _gpuDepthRange = uniform(new THREE.Vector2(), 'vec2');
  depthRange?: [number, number];

  private _cameraDepthRange: [number, number] = [0, 100];

  /** Creates the modifier with its built-in priority and optional filtering/LOD settings. */
  constructor(public options: ScaleByDepthOptions) {

    super((particle: Particle) => {
      const time = THREE.MathUtils.clamp(
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

      particle.scale.multiply(
        evaluateByParameterVector(
          this.options.scale ?? new THREE.Vector3(1, 1, 1),
          time,
        ),
      );
      particle.scalarVelocity.add(
        evaluateByParameterVector(
          this.options.scalarVelocity ?? new THREE.Vector3(),
          time,
        ),
      );
      particle.scalarAcceleration.add(
        evaluateByParameterVector(
          this.options.scalarAcceleration ?? new THREE.Vector3(),
          time,
        ),
      );
    }, {
      ...options,
      priority: Module.Priority.Transient,
      modifyGPU: (particle) => {
          const time = this.getDepthTimeGPU(particle.position);

          particle.scale.assign(
            particle.scale.mul(this.gpuParameters.parameterVector(
              'scale', () => this.options.scale,
              time,
              new THREE.Vector3(1, 1, 1),
            )),
          );
          particle.scalarVelocity.assign(
            particle.scalarVelocity.add(this.gpuParameters.parameterVector(
              'scalarVelocity', () => this.options.scalarVelocity,
              time,
            )),
          );
          particle.scalarAcceleration.assign(
            particle.scalarAcceleration.add(this.gpuParameters.parameterVector(
              'scalarAcceleration', () => this.options.scalarAcceleration,
              time,
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

export default ScaleByDepth;
