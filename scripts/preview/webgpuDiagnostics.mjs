/** Runs before page scripts, so initialization failures are observed as well as rendering failures. */
export function installWebGPUDiagnostics() {
  const report = (phase, details = {}) => {
    void globalThis.rzmpsPreviewReport?.({ phase, ...details });
  };
  const limits = object =>
    Object.fromEntries(
      Object.getOwnPropertyNames(Object.getPrototypeOf(object))
        .filter(key => typeof object[key] === 'number')
        .map(key => [key, object[key]]),
    );
  if (!navigator.gpu) {
    report('gpu-unavailable');
    return;
  }
  const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
  navigator.gpu.requestAdapter = async options => {
    report('adapter-request', { options });
    const adapter = await requestAdapter(options);
    if (!adapter) {
      report('adapter-unavailable', { options });
      return null;
    }
    const info = adapter.info;
    report('adapter-ready', {
      options,
      info: info && {
        vendor: info.vendor,
        architecture: info.architecture,
        device: info.device,
        description: info.description,
        isFallbackAdapter: info.isFallbackAdapter,
      },
      features: [...adapter.features].sort(),
      limits: limits(adapter.limits),
    });
    const requestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async descriptor => {
      report('device-request', { descriptor });
      let device;
      try {
        device = await requestDevice(descriptor);
      } catch (error) {
        report('device-request-failed', { message: error.message });
        throw error;
      }
      report('device-ready', { features: [...device.features].sort(), limits: limits(device.limits) });
      device.lost.then(info => report('device-lost', { reason: info.reason, message: info.message }));
      device.addEventListener('uncapturederror', event => {
        report('gpu-error', { name: event.error.name, message: event.error.message });
      });
      const createShader = device.createShaderModule.bind(device);
      device.createShaderModule = descriptor => {
        const module = createShader(descriptor);
        report('shader-module', { label: descriptor.label, code: descriptor.code });
        void module
          .getCompilationInfo()
          .then(info => {
            for (const message of info.messages) {
              if (message.type === 'error')
                report('shader-error', {
                  label: descriptor.label,
                  message: message.message,
                  line: message.lineNum,
                  column: message.linePos,
                });
            }
          })
          .catch(error => report('shader-info-failed', { message: error.message }));
        return module;
      };
      for (const name of [
        'createRenderPipeline',
        'createRenderPipelineAsync',
        'createComputePipeline',
        'createComputePipelineAsync',
      ]) {
        const original = device[name].bind(device);
        device[name] = descriptor => {
          const label = descriptor.label;
          report('pipeline-start', { method: name, label });
          const started = performance.now();
          const result = original(descriptor);
          if (result?.then)
            return result.then(
              pipeline => {
                report('pipeline-ready', {
                  method: name,
                  label,
                  durationMs: performance.now() - started,
                });
                return pipeline;
              },
              error => {
                report('pipeline-failed', { method: name, message: error.message });
                throw error;
              },
            );
          report('pipeline-ready', { method: name, label, durationMs: performance.now() - started });
          return result;
        };
      }
      return device;
    };
    return adapter;
  };
}
