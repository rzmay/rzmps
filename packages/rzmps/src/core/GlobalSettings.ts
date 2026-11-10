/** Process-wide defaults and tuning controls shared by all particle systems.
 * Set through ParticleSystem.Settings or import this class internally.
 */
class GlobalSettings {
  static GPU_DYNAMIC_VALUE_RESOLUTION = 16;
  static GPU_INITIAL_BUFFER_SIZE = 256;
  static GPU_READBACK_RATE = 24;
  static GPU_EVENT_BUFFER_CAPACITY = 4096;
  static GPU_SELECTIVE_READBACK_POOL_SIZE = 8;
  static GPU_DEBUG = false;
  static GPU_DEBUG_INTERVAL = 30;
  static BOID_RANGE_INFLUENCE_THRESHOLD = 1e-6;
}

export default GlobalSettings;
