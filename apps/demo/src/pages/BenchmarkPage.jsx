/* eslint-disable react/no-unknown-property */
import PropTypes from 'prop-types';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  selectBenchmarkCases,
  readBenchmarkOptions,
  updateBenchmarkSystem,
} from '../../../../benchmarks/lib/benchmark-selection.mjs';
import { isBenchmarkMeasurementComplete } from '../../../../benchmarks/lib/benchmark-payload.mjs';
import { recordBenchmarkFrame } from '../../../../benchmarks/lib/benchmark-measurement.mjs';
import { profileRenderer, ParticleSystem } from '@rzmps/rzmps';
import {
  createBenchmarkRenderer,
  DEFAULT_DURATION_MS,
  DEFAULT_WARMUP_MS,
  getNumberParam,
  getStringParam,
  createSystem,
  summarize,
} from '../../benchmarks/benchmark.utils.js';
import { createBenchmarkCases } from '../../benchmarks/index.js';

const benchmarkOptions = readBenchmarkOptions(window.location.search);

function BenchmarkScene({ onComplete, onProgress }) {
  const { scene, gl, camera, setFrameloop } = useThree();
  const active = useRef(null);
  const starting = useRef(false);
  const failed = useRef(false);
  const caseIndex = useRef(-1);
  const results = useRef([]);
  const lastFrame = useRef();

  useEffect(() => {
    const shutdown = async () => {
      failed.current = true;
      setFrameloop('never');
      try {
        await gl.backend.device.queue.onSubmittedWorkDone();
      } finally {
        active.current?.system.destroy();
        active.current?.sceneObjects?.forEach(object => object.removeFromParent());
        active.current = null;
        gl.dispose();
      }
    };
    window.__RZMPS_BENCHMARK_SHUTDOWN__ = shutdown;
    return () => {
      delete window.__RZMPS_BENCHMARK_SHUTDOWN__;
    };
  }, [gl, setFrameloop]);

  const fail = error => {
    failed.current = true;
    setFrameloop('never');
    window.__RZMPS_BENCHMARK_ERROR__ = { message: error.message ?? String(error), stack: error.stack };
    window.__RZMPS_BENCHMARK_PROGRESS__ = {
      ...window.__RZMPS_BENCHMARK_PROGRESS__,
      phase: 'failed',
      error: error.message ?? String(error),
    };
    throw error;
  };
  const durationMs = getNumberParam('durationMs', DEFAULT_DURATION_MS);
  const warmupMs = getNumberParam('warmupMs', DEFAULT_WARMUP_MS);
  const suite = getStringParam('suite');
  const caseFilter = getStringParam('case').toLowerCase();
  const ciProfile = new URLSearchParams(window.location.search).get('profile') === 'ci';

  if (gl.compute && !gl.__rzmpsBenchmarkComputeWrapped) {
    const originalCompute = gl.compute.bind(gl);
    gl.__rzmpsBenchmarkComputeDispatches = 0;
    gl.compute = (...args) => {
      gl.__rzmpsBenchmarkComputeDispatches += 1;
      return originalCompute(...args);
    };
    gl.__rzmpsBenchmarkComputeWrapped = true;
  }

  const allCases = useMemo(
    () => createBenchmarkCases({ ciProfile }, suite, benchmarkOptions.selection),
    [ciProfile, suite],
  );
  const cases = useMemo(() => {
    const selected = selectBenchmarkCases(
      allCases,
      suite ? 'full' : benchmarkOptions.selection,
      Object.fromEntries(
        ['name', 'path', 'feature', 'backend'].flatMap(key => {
          const value = new URLSearchParams(window.location.search).get(key);
          return value ? [[key, value]] : [];
        }),
      ),
    );
    return caseFilter ? selected.filter(({ name }) => name.toLowerCase().includes(caseFilter)) : selected;
  }, [allCases, caseFilter, suite]);

  const startNextCase = async () => {
    if (starting.current) return;
    starting.current = true;
    setFrameloop('never');
    // Let the current render callback finish submitting before draining its work.
    await Promise.resolve();
    window.__RZMPS_BENCHMARK_CASES__ = cases.map(entry => entry.name);
    if (active.current?.system) {
      // Case transitions are outside measurement; reclaim storage only after queued work completes.
      await gl.backend.device.queue.onSubmittedWorkDone();
      active.current.system.destroy();
      active.current.sceneObjects?.forEach(object => object.removeFromParent());
      active.current = null;
    }

    caseIndex.current += 1;

    const nextCase = cases[caseIndex.current];
    if (!nextCase) {
      window.__RZMPS_BENCHMARK_RESULTS__ = results.current;
      window.__RZMPS_BENCHMARK_PROGRESS__ = {
        ...window.__RZMPS_BENCHMARK_PROGRESS__,
        phase: 'complete',
        completed: results.current.length,
      };
      window.__RZMPS_BENCHMARK_DONE__ = true;
      onComplete(results.current);
      starting.current = false;
      return;
    }

    // Report case transitions outside measurement so CLI users can see progress
    // without polling the measured browser render loop.
    console.info(
      `[benchmark] Case ${caseIndex.current + 1}/${cases.length}: ${nextCase.name} (${warmupMs / 1000}s warmup, ${
        Math.max(durationMs, nextCase.minimumDurationMs ?? 0) / 1000
      }s measurement)`,
    );
    ParticleSystem.Settings.GPU_READBACK_RATE = nextCase.readbackRate;
    const system = nextCase.createSystem
      ? await nextCase.createSystem()
      : createSystem({
          particleCount: nextCase.particleCount,
          ...nextCase.create(),
        });
    nextCase.configure?.(system);
    system._renderer = gl;
    system._scene = scene;
    system._camera = camera;
    system.__rzmpsBenchmarkComputeDispatches = 0;
    system.__rzmpsBenchmarkSimulationDispatches = 0;
    system.__rzmpsBenchmarkRenderOutputDispatches = 0;
    system.__rzmpsSimulationNodeBuilds = 0;
    const sceneObjects = nextCase.configureScene?.(scene) ?? [];

    const originalSimulationPhase = system.gpuSimulation._computeGPUSimulationPhase.bind(system.gpuSimulation);
    system.gpuSimulation._computeGPUSimulationPhase = (...args) => {
      system.__rzmpsBenchmarkComputeDispatches += 1;
      system.__rzmpsBenchmarkSimulationDispatches += 1;
      return originalSimulationPhase(...args);
    };

    const originalRenderOutputPhase = system.gpuSimulation._computeGPURenderOutputPhase.bind(system.gpuSimulation);
    system.gpuSimulation._computeGPURenderOutputPhase = (...args) => {
      system.__rzmpsBenchmarkComputeDispatches += 1;
      system.__rzmpsBenchmarkRenderOutputDispatches += 1;
      return originalRenderOutputPhase(...args);
    };

    scene.add(system);
    active.current = {
      ...nextCase,
      system,
      sceneObjects,
      phase: 'warmup',
      phaseStartedAt: performance.now(),
      benchmarks: system.benchmarks,
      simulationNodes: new WeakSet(),
      simulationNodeBuilds: 0,
      maxHeapMB: 0,
      measuredFrames: 0,
      rendererType: gl.isWebGPURenderer ? 'WebGPURenderer' : gl.constructor.name,
    };
    lastFrame.current = undefined;
    onProgress(nextCase.name);
    starting.current = false;
    setFrameloop('always');
    window.__RZMPS_BENCHMARK_PROGRESS__ = {
      activeCase: nextCase.name,
      phase: 'warmup',
      completed: results.current.length,
    };
  };

  useFrame(() => {
    if (failed.current || starting.current) return;

    if (!active.current) {
      void startNextCase().catch(error => {
        setTimeout(() => fail(error));
      });
      return;
    }

    const frameStart = performance.now();
    const endUpdate =
      active.current.phase === 'measure' ? active.current.benchmarks.begin('benchmark/update') : undefined;
    const computeDispatchesBefore =
      suite === 'emitter-instances'
        ? gl.__rzmpsBenchmarkComputeDispatches
        : (active.current.system.__rzmpsBenchmarkComputeDispatches ?? gl.__rzmpsBenchmarkComputeDispatches ?? 0);
    const simulationDispatchesBefore = active.current.system.__rzmpsBenchmarkSimulationDispatches ?? 0;
    const renderOutputDispatchesBefore = active.current.system.__rzmpsBenchmarkRenderOutputDispatches ?? 0;
    active.current.beforeUpdate?.(active.current.system, frameStart - active.current.phaseStartedAt);
    try {
      updateBenchmarkSystem(active.current.system, benchmarkOptions.simulationClock);
    } catch (error) {
      fail(error);
    }
    const simulationNode = active.current.system.gpuSimulation._gpuSimulationComputeCache?.node;
    if (simulationNode && !active.current.simulationNodes.has(simulationNode)) {
      active.current.simulationNodes.add(simulationNode);
      active.current.simulationNodeBuilds += 1;
      active.current.system.__rzmpsSimulationNodeBuilds = active.current.simulationNodeBuilds;
    }
    const computeDispatchesAfter =
      suite === 'emitter-instances'
        ? gl.__rzmpsBenchmarkComputeDispatches
        : (active.current.system.__rzmpsBenchmarkComputeDispatches ??
          gl.__rzmpsBenchmarkComputeDispatches ??
          computeDispatchesBefore);
    const simulationDispatchesAfter =
      active.current.system.__rzmpsBenchmarkSimulationDispatches ?? simulationDispatchesBefore;
    const renderOutputDispatchesAfter =
      active.current.system.__rzmpsBenchmarkRenderOutputDispatches ?? renderOutputDispatchesBefore;
    endUpdate?.();
    let elapsed = frameStart - active.current.phaseStartedAt;

    if (active.current.phase === 'warmup') {
      if (elapsed >= warmupMs) {
        active.current.benchmarks.start({ maxSamples: 100000 });
        active.current.phase = 'measure';
        active.current.phaseStartedAt = frameStart;
        lastFrame.current = frameStart;
        window.__RZMPS_BENCHMARK_PROGRESS__.phase = 'measure';
      }
      return;
    }

    const caseDurationMs = Math.max(durationMs, active.current.minimumDurationMs ?? 0);
    const awaitingExpectedEvents =
      active.current.expectedDeathEvents &&
      (active.current.system.__rzmpsBenchmarkDeathEvents ?? 0) < active.current.expectedDeathEvents;
    if (active.current.phase === 'drain') {
      if (awaitingExpectedEvents && elapsed < 5000) {
        lastFrame.current = frameStart;
        return;
      }
      elapsed = active.current.measuredDurationMs;
    }

    recordBenchmarkFrame(active.current, lastFrame.current, frameStart, undefined, {
      compute: computeDispatchesAfter - computeDispatchesBefore,
      simulation: simulationDispatchesAfter - simulationDispatchesBefore,
      renderOutput: renderOutputDispatchesAfter - renderOutputDispatchesBefore,
    });
    lastFrame.current = frameStart;

    if (active.current.requireGPU && !active.current.system.isGPUProcessingActive) {
      fail(new Error(`${active.current.name} did not activate GPU processing.`));
    }

    const heapBytes = performance.memory?.usedJSHeapSize;
    if (Number.isFinite(heapBytes)) {
      active.current.maxHeapMB = Math.max(active.current.maxHeapMB, heapBytes / (1024 * 1024));
    }

    // Software rendering or a delayed frame can consume the entire time window.
    // Keep measuring until the payload validator's minimum frame count is met.
    if (isBenchmarkMeasurementComplete(elapsed, caseDurationMs, active.current.measuredFrames)) {
      if (active.current.phase === 'measure' && awaitingExpectedEvents) {
        active.current.phase = 'drain';
        active.current.phaseStartedAt = frameStart;
        return;
      }
      if (
        active.current.expectedDeathEvents &&
        (active.current.system.__rzmpsBenchmarkDeathEvents ?? 0) < active.current.expectedDeathEvents
      ) {
        fail(
          new Error(
            `${active.current.name} dispatched ${active.current.system.__rzmpsBenchmarkDeathEvents ?? 0}` +
              ` GPU death events; expected ${active.current.expectedDeathEvents}.`,
          ),
        );
      }
      try {
        active.current.validate?.(active.current.system);
        active.current.benchmarks.assert(active.current.assertions ?? []);
      } catch (error) {
        fail(error);
      }
      results.current.push(summarize(active.current));
      active.current.benchmarks.stop();
      window.__RZMPS_BENCHMARK_RESULTS__ = [...results.current];
      gl.info.reset();
      void startNextCase().catch(error => {
        setTimeout(() => fail(error));
      });
    }
  });

  // R3F's default render follows the update callback; profiling preserves that ordering and timestep.
  useFrame((_state, delta) => {
    profileRenderer(active.current?.benchmarks, gl, () => gl.render(scene, camera), delta * 1000);
  }, 1);

  return null;
}

function BenchmarkPage() {
  const [results, setResults] = useState([]);
  const [activeCase, setActiveCase] = useState('Starting');
  const status = results.length > 0 ? `${results.length} cases completed` : 'warming up';

  return (
    <div className="demo-shell">
      <Canvas
        camera={{ position: [0, 0, 8], near: 0.1, far: 100 }}
        gl={createBenchmarkRenderer}
        onCreated={({ gl }) => gl.setClearColor('#202020')}
      >
        <ambientLight intensity={1} />
        <BenchmarkScene onComplete={setResults} onProgress={setActiveCase} />
      </Canvas>

      <div className="benchmark-status">
        <strong>Benchmark</strong>
        <span>{activeCase}</span>
        <small>{status}</small>
      </div>

      <pre className="code-panel">
        <code>{JSON.stringify({ activeCase, results }, null, 2)}</code>
      </pre>
    </div>
  );
}

export default BenchmarkPage;

BenchmarkScene.propTypes = { onComplete: PropTypes.func.isRequired, onProgress: PropTypes.func };
