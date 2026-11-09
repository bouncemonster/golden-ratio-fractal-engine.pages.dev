import { useEffect, useRef, useState, useCallback, RefObject } from 'react';
import { FractalParams, FractalType, TelemetryData, RenderStyle, CameraMode } from '../types/fractal';
import { WebGPUEngine } from '../engine/WebGPUEngine';
import { WebGLEngine } from '../engine/WebGLEngine';
import { WorkerWebGLEngine } from '../engine/WorkerWebGLEngine';
import { getFractalIndex } from '../engine/fractalMappers';
import { logger } from '../utils/logger';
import {
  DPR_CAP_DESKTOP, DPR_CAP_EMBEDDED, DPR_CAP_MOBILE,
  CANVAS_MAX_DIM_DESKTOP, CANVAS_MAX_DIM_MOBILE, CANVAS_MIN_DIM, CANVAS_MIN_HEIGHT,
  LOADER_FORCE_HIDE_MS, ENGINE_SETUP_TIMEOUT_MS,
  QUALITY_COOLDOWN_MS, QUALITY_DOWN_THRESHOLD_RATIO, QUALITY_UP_THRESHOLD_RATIO,
  CONSECUTIVE_ERROR_FLOOR,
  INERTIA_DECAY, INERTIA_THRESHOLD, INERTIA_ROT_SPEED,
  AUTO_ROTATE_RESUME_DELAY_MS, AUTO_ROTATE_SPEED,
  FPS_TARGET_DESKTOP, FPS_TARGET_MOBILE,
  PREFETCH_INITIAL_DELAY_MS, PREFETCH_RETRY_DELAY_MS, PREFETCH_COLD_START_DELAY_MS,
} from '../constants';

export interface UseRenderEngineOptions {
  forcedBackend: 'webgpu' | 'webgl2' | 'auto';
  isEmbeddedBrowser: boolean;
  isMobileDevice: boolean;
  paramsRef: RefObject<FractalParams>;
  onTelemetryUpdate: (telemetry: TelemetryData) => void;
  onEngineReady?: () => void;
  onNextSpecimen?: () => void;
  onPrevSpecimen?: () => void;
  // Predicted fractal types of the NEXT specimens (1st and 2nd ahead) — their shaders
  // are background-prefetched in parallel while the user views the current one
  // (see prefetch effect).
  nextSpecimenTypes?: FractalType[] | null;
  onInteraction?: (zoomDelta: number, orbitDelta: number) => void;
  // Commit a param change back through React state so it PERSISTS. The imperative
  // `paramsRef.current = {...}` writes get overwritten the next time the controlled
  // `params` prop re-syncs (App holds the source of truth), which is why the old
  // keyboard rotation-stop never stuck. FractalCanvas passes its onParamsChange here.
  commitParams?: (updater: (prev: FractalParams) => FractalParams) => void;
  screenshotRequested: boolean;
  onScreenshotCaptured: (dataUrl: string) => void;
}

export interface UseRenderEngineResult {
  activeEngineType: 'webgpu' | 'webgl2';
  isCompiling: boolean;
  // Real compile progress (0-100, 0 = unknown) of the shader swap the user is
  // waiting on — drives the "Initializing GPU… N%" chip instead of a blind pulse.
  shaderCompilePct: number;
  isEngineReady: boolean;
  // True when BOTH WebGPU and WebGL2 failed to initialize (silent failure — no throw,
  // so the React error boundary does not catch it). Lets the UI show a clear
  // "GPU unavailable" message instead of a blank canvas.
  initFailed: boolean;
  loadProgress: number;
  backendLabel: string;
  adapterInfo: string;
  fps: number;
  avgFps: number;
  frameTimeMs: number;
  onePercentLow: number;
  resolution: [number, number];
  canvasRef: RefObject<HTMLCanvasElement | null>;
  canvasKey: string;
  keysPressedRef: RefObject<Set<string>>;
  isDraggingRef: RefObject<boolean>;
  velocityRef: RefObject<{ x: number; y: number }>;
  lastMousePosRef: RefObject<{ x: number; y: number }>;
  lastInteractionReportTimeRef: RefObject<number>;
  lastMoveTimeRef: RefObject<number>;
  inertiaEnabledRef: RefObject<boolean>;
  stopRotation: () => void;
  toggleInertia: () => void;
  params: FractalParams | null;
}

export function useRenderEngine(
  containerRef: RefObject<HTMLDivElement | null>,
  options: UseRenderEngineOptions,
): UseRenderEngineResult {
  const {
    forcedBackend,
    isEmbeddedBrowser,
    isMobileDevice,
    paramsRef,
    onTelemetryUpdate,
    onEngineReady,
    onNextSpecimen,
    onPrevSpecimen,
    nextSpecimenTypes,
    onInteraction,
    commitParams,
    screenshotRequested,
    onScreenshotCaptured,
  } = options;

  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Engine type state — always default to WebGL2 in auto mode
  const [activeEngineType, setActiveEngineType] = useState<'webgpu' | 'webgl2'>(() => {
    if (forcedBackend === 'webgl2') return 'webgl2';
    if (forcedBackend === 'webgpu') {
      if (isEmbeddedBrowser) return 'webgl2';
      return 'webgpu';
    }
    return 'webgl2';
  });

  const [workerEnabled, setWorkerEnabled] = useState(() =>
    typeof window !== 'undefined' && window !== window.top &&
    typeof Worker !== 'undefined' && typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function'
  );
  const useWorker = workerEnabled && activeEngineType === 'webgl2';
  const canvasKey = useWorker ? (isMobileDevice ? 'webgl2-worker-mobile' : 'webgl2-worker') : activeEngineType;

  const [isCompiling, setIsCompiling] = useState<boolean>(true);
  const [shaderCompilePct, setShaderCompilePct] = useState<number>(0);
  const [isEngineReady, setIsEngineReady] = useState<boolean>(false);
  const [initFailed, setInitFailed] = useState<boolean>(false);
  // Real loading progress (0-1) synced to actual device init + shader compile +
  // first rendered frame — NOT a fixed timer.
  const [loadProgress, setLoadProgress] = useState<number>(0);
  const [backendLabel, setBackendLabel] = useState<string>('Initializing...');
  const [adapterInfoState, setAdapterInfoState] = useState<string>('');
  const [fpsState, setFpsState] = useState(0);
  const [avgFpsState, setAvgFpsState] = useState(0);
  const [frameTimeState, setFrameTimeState] = useState(0);
  const [onePercentLowState, setOnePercentLowState] = useState(0);
  const [resolutionState, setResolutionState] = useState<[number, number]>([0, 0]);

  const webgpuEngineRef = useRef<WebGPUEngine | null>(null);
  const webglEngineRef = useRef<WebGLEngine | WorkerWebGLEngine | null>(null);
  const activeBackendLabelRef = useRef<string>('Initializing...');

  // Callback refs for stable render loop
  const onTelemetryUpdateRef = useRef(onTelemetryUpdate);
  onTelemetryUpdateRef.current = onTelemetryUpdate;
  const onScreenshotCapturedRef = useRef(onScreenshotCaptured);
  onScreenshotCapturedRef.current = onScreenshotCaptured;
  const onNextSpecimenRef = useRef(onNextSpecimen);
  onNextSpecimenRef.current = onNextSpecimen;
  const onPrevSpecimenRef = useRef(onPrevSpecimen);
  onPrevSpecimenRef.current = onPrevSpecimen;
  const onInteractionRef = useRef(onInteraction);
  onInteractionRef.current = onInteraction;
  const commitParamsRef = useRef(commitParams);
  commitParamsRef.current = commitParams;
  const onEngineReadyRef = useRef(onEngineReady);
  onEngineReadyRef.current = onEngineReady;

  // Performance telemetry refs
  // Rising-edge timestamp of isSwappingShader — the swap overlay only appears when
  // a swap actually exceeds this grace window (cached swaps never set the guard).
  const swapGraceStartRef = useRef<number>(0);
  const frameTimesRef = useRef<number[]>([]);
  const lastTelemetryDispatchRef = useRef<number>(0);
  const lastHealthLogRef = useRef<number>(0);
  const rafIdRef = useRef<number | null>(null);
  const simTimeRef = useRef<number>(0);

  // Engine lifecycle refs
  const webgpuFailedRef = useRef(false);
  const keysPressedRef = useRef<Set<string>>(new Set());
  const contextLostRef = useRef(false);
  const isVisibleRef = useRef(true);
  const engineReadyRef = useRef(false);
  const screenshotRequestedRef = useRef(false);

  // Pointer interaction refs (shared with component for event handlers)
  const isDraggingRef = useRef(false);
  const lastMousePosRef = useRef({ x: 0, y: 0 });
  const velocityRef = useRef({ x: 0, y: 0 });
  const lastMoveTimeRef = useRef(0);
  const lastInteractionReportTimeRef = useRef<number>(0);
  const inertiaDecay = INERTIA_DECAY;
  const inertiaThreshold = INERTIA_THRESHOLD;
  const inertiaEnabledRef = useRef(true); // Allow toggling inertia on/off
  const AUTO_ROTATION_RESUME_DELAY = AUTO_ROTATE_RESUME_DELAY_MS;
  // Auto-rotation is an ACCUMULATED angle stored here (not an absolute simTime term added
  // to rotX each frame), so pausing simply stops accumulating and the view holds perfectly
  // still, and resuming eases the spin back in from zero via the ease factor — no snap.
  const autoRotAccumRef = useRef(0);   // accumulated auto-rotation yaw (rad)
  const autoRotPhaseRef = useRef(0);   // phase for the gentle auto-rotation pitch wobble
  const autoRotateEaseRef = useRef(0); // 0..1 ease-in multiplier when rotation (re)starts
  const firstRenderDoneRef = useRef(false); // Track first successful render for loading overlay
  const lastQualityChangeRef = useRef<number>(0); // Cooldown for DynamicQuality to prevent rapid oscillation

  // Keep screenshot ref in sync
  useEffect(() => {
    screenshotRequestedRef.current = screenshotRequested;
  }, [screenshotRequested]);

  // Sync forcedBackend changes
  useEffect(() => {
    if (forcedBackend === 'webgl2') {
      setActiveEngineType('webgl2');
    } else if (forcedBackend === 'webgpu') {
      if (isEmbeddedBrowser) {
        logger.warn('[useRenderEngine] WebGPU blocked in embedded browser — using WebGL2');
        webgpuFailedRef.current = true;
        setActiveEngineType('webgl2');
        return;
      }
      webgpuFailedRef.current = false;
      setActiveEngineType('webgpu');
    } else if (forcedBackend === 'auto') {
      setActiveEngineType('webgl2');
    }
  }, [forcedBackend, isEmbeddedBrowser]);

  // Resize handler — always syncs canvas buffer to container CSS size × DPR
  // Mobile: cap at 1.0 DPR and max 1280px to prevent GPU overload
  const handleResize = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    // Mobile: stricter DPR and resolution limits to prevent GPU crashes
    const maxDpr = isMobileDevice ? DPR_CAP_MOBILE : (isEmbeddedBrowser ? DPR_CAP_EMBEDDED : DPR_CAP_DESKTOP);
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    const clientW = container.clientWidth || window.innerWidth || 800;
    const clientH = container.clientHeight || window.innerHeight || 600;

    // Cap resolution for mobile GPUs (max 1280px on longest side)
    const maxMobileDim = isMobileDevice ? CANVAS_MAX_DIM_MOBILE : CANVAS_MAX_DIM_DESKTOP;
    let width = Math.max(Math.floor(clientW * dpr), CANVAS_MIN_DIM);
    let height = Math.max(Math.floor(clientH * dpr), CANVAS_MIN_HEIGHT);
    
    // Enforce max dimension cap
    if (Math.max(width, height) > maxMobileDim) {
      const scale = maxMobileDim / Math.max(width, height);
      width = Math.floor(width * scale);
      height = Math.floor(height * scale);
    }

    const engine = webglEngineRef.current;
    if (engine instanceof WorkerWebGLEngine && engine.canvas === canvas) {
      engine.resize(width, height);
      return;
    }
    if (canvas.width !== width || canvas.height !== height) {
      const oldW = canvas.width, oldH = canvas.height;
      canvas.width = width;
      canvas.height = height;
      logger.info(`[Resize] Canvas buffer: ${oldW}x${oldH} → ${width}x${height} (container: ${clientW}x${clientH}, DPR: ${dpr.toFixed(2)}${isMobileDevice ? ', MOBILE' : ''})`);
    }
  }, [isEmbeddedBrowser, isMobileDevice]);

  // Engine initialization
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    handleResize();
    let isDestroyed = false;

    // Failsafe only — must stay ABOVE worst-case real-hardware cold compile (ANGLE
    // driver init + first shaders measurably exceed 12s on desktop GPUs, so a 12s
    // cut exposed the undrawn canvas mid-init). The honest dismissal is the first
    // rendered frame; this only trips on a genuinely hung pipeline.
    const forceHideTimeoutId = setTimeout(() => {
      if (!isDestroyed && !firstRenderDoneRef.current) {
        logger.info('[useRenderEngine] Force-hiding loading overlay after 60s (engine never produced a first frame)');
        setIsCompiling(false);
      }
    }, LOADER_FORCE_HIDE_MS);

    const setupTimeoutId = setTimeout(() => {
      if (!engineReadyRef.current && !isDestroyed) {
        logger.error('[useRenderEngine] Engine setup timed out after 20s — GPU unavailable');
        // Force-hide loading overlay so user can interact with fallback UI
        setIsCompiling(false);
      }
    }, ENGINE_SETUP_TIMEOUT_MS);

    function fallBackFromWorker(message: string) {
      if (isDestroyed) return;
      logger.warn('[useRenderEngine] ' + message + ' — restarting WebGL2 on a fresh canvas');
      engineReadyRef.current = false;
      setIsEngineReady(false);
      setWorkerEnabled(false);
    }

    async function setup() {
      if (!canvas) return;
      logger.info('[useRenderEngine] Setup starting, activeEngineType=', activeEngineType);
      setIsCompiling(true);
      setInitFailed(false);
      engineReadyRef.current = false;
      // Per-engine first-frame bookkeeping: a backend re-init must earn its own
      // first rendered frame before the loader/overlay dismissal logic counts it.
      firstRenderDoneRef.current = false;
      setIsEngineReady(false);

      if (webgpuEngineRef.current) {
        webgpuEngineRef.current.destroy();
        webgpuEngineRef.current = null;
      }
      if (webglEngineRef.current) {
        webglEngineRef.current.destroy();
        webglEngineRef.current = null;
      }

      if (activeEngineType === 'webgpu') {
        logger.info('[useRenderEngine] Attempting WebGPU init...');
        const gpuEngine = new WebGPUEngine(canvas);
        const success = await gpuEngine.init();
        if (success && !isDestroyed) {
          webgpuEngineRef.current = gpuEngine;
          engineReadyRef.current = true;
          setIsEngineReady(true);
          activeBackendLabelRef.current = 'WebGPU (WGSL)';
          setBackendLabel('WebGPU (WGSL)');
          setAdapterInfoState(gpuEngine.adapterInfo);
          // Context acquired → real init baseline. Completion (1.0 + onEngineReady)
          // fires on the first RENDERED frame in the render loop, so the loader
          // lifetime equals actual device init time. No fixed-timer fake progress.
          setLoadProgress(0.12);
          
          // ADAPTIVE QUALITY: Set quality level based on device
          const qualityLevel = isMobileDevice ? 0 : 1; // medium for desktop/embedded
          gpuEngine.setQualityLevel(qualityLevel);
          logger.info(`[useRenderEngine] Quality level set to ${qualityLevel} (mobile=${isMobileDevice}, embedded=${isEmbeddedBrowser})`);
          
          // NOTE: isCompiling stays true until first successful render (shader compilation is deferred)
          logger.info(`[DIAG] Engine ready: WebGPU | ${gpuEngine.adapterInfo} | ${canvas.width}x${canvas.height} | fractal=${paramsRef.current.type} | palette=${paramsRef.current.paletteId} | renderStyle=${paramsRef.current.renderStyle} | paletteSeed=${paramsRef.current.paletteSeed ?? 0}`);
          return;
        } else {
          webgpuFailedRef.current = true;
          if (!isDestroyed) {
            setActiveEngineType('webgl2');
          } else {
            setIsCompiling(false);
          }
          return;
        }
      }

      // WebGL2
      logger.info('[useRenderEngine] Attempting WebGL2 init...');
      // Yield before transferring ownership so React's development effect replay
      // can cancel the first setup without consuming the DOM canvas.
      if (useWorker) {
        await Promise.resolve();
        if (isDestroyed) return;
      }
      const glEngine = useWorker
        ? new WorkerWebGLEngine(canvas, fallBackFromWorker)
        : new WebGLEngine(canvas);
      if (glEngine instanceof WorkerWebGLEngine) webglEngineRef.current = glEngine;
      const success = glEngine instanceof WorkerWebGLEngine ? await glEngine.init() : glEngine.init();
      if (isDestroyed) {
        glEngine.destroy();
        return;
      }
      if (!success && glEngine instanceof WorkerWebGLEngine) {
        if (glEngine.leavingDocument) return;
        fallBackFromWorker('WebGL worker could not initialize');
        return;
      }
      if (success) {
        webglEngineRef.current = glEngine;
        engineReadyRef.current = true;
        setIsEngineReady(true);
        activeBackendLabelRef.current = 'WebGL2 (GLSL)';
        setBackendLabel('WebGL2 (GLSL)');
        setAdapterInfoState(glEngine.rendererInfo);
        // Context acquired → real init baseline; the remaining progress comes from
        // the ACTUAL per-stage shader compile/link, and completion (1.0 +
        // onEngineReady) fires only on the first RENDERED frame. The loading
        // animation is therefore synced to real device init time on every device.
        setLoadProgress(0.12);
        glEngine.onCompileProgress = (_stage, pct) => {
          // Monotonic: real compile stages only ever push the bar forward, never rewind.
          setLoadProgress((prev) => Math.max(prev, 0.12 + (pct / 100) * 0.8));
        };
        
        // ADAPTIVE QUALITY: Set quality level based on device
        const qualityLevel = isMobileDevice ? 0 : 1; // medium for desktop/embedded
        glEngine.setQualityLevel(qualityLevel);
        logger.info(`[useRenderEngine] Quality level set to ${qualityLevel} (mobile=${isMobileDevice}, embedded=${isEmbeddedBrowser})`);
        
        // NOTE: isCompiling stays true until first successful render (shader compilation is deferred)
        logger.info(`[DIAG] Engine ready: WebGL2 | ${glEngine.rendererInfo} | ${canvas.width}x${canvas.height} | fractal=${paramsRef.current.type} | palette=${paramsRef.current.paletteId} | renderStyle=${paramsRef.current.renderStyle} | paletteSeed=${paramsRef.current.paletteSeed ?? 0}`);
      } else {
        // Init failed — dismiss the loader so the fallback UI stays reachable.
        setInitFailed(true);
        setIsCompiling(false);
        setLoadProgress(1);
        onEngineReadyRef.current?.();
      }
    }

    setup().catch((err) => {
      if (isDestroyed) return;
      if (useWorker) {
        fallBackFromWorker(err instanceof Error ? err.message : String(err));
        return;
      }
      logger.error('[useRenderEngine] Engine setup crashed:', err);
      setInitFailed(true);
      setIsCompiling(false);
      setLoadProgress(1);
      onEngineReadyRef.current?.();
    });

    // Delayed resize re-check: ensures canvas buffer matches container after layout settles
    // This fixes horizontal split artifacts caused by initial size mismatch
    const delayedResizeId = setTimeout(() => {
      if (!isDestroyed) {
        handleResize();
        // Also force a second check after a frame to catch any late layout shifts
        requestAnimationFrame(() => {
          if (!isDestroyed) handleResize();
        });
      }
    }, 100);

    const handleContextLost = (e: Event) => {
      e.preventDefault();
      contextLostRef.current = true;
    };
    const handleContextRestored = () => {
      contextLostRef.current = false;
      // Guard: don't re-init if component unmounted during context loss
      if (!isDestroyed) {
        setup().catch((err) => {
          logger.error('[useRenderEngine] Context restore setup failed:', err);
        });
      }
    };

    if (!useWorker) {
      canvas.addEventListener('webglcontextlost', handleContextLost, false);
      canvas.addEventListener('webglcontextrestored', handleContextRestored, false);
    }

    const container = containerRef.current;
    let resizeObserver: ResizeObserver | null = null;
    let resizeDebounceId: ReturnType<typeof setTimeout> | null = null;
    if (container) {
      resizeObserver = new ResizeObserver(() => {
        if (!isDestroyed) {
          // Debounce resize to prevent multiple canvas reallocations during window drag/resize
          if (resizeDebounceId) clearTimeout(resizeDebounceId);
          resizeDebounceId = setTimeout(() => {
            if (!isDestroyed) handleResize();
          }, 50);
        }
      });
      resizeObserver.observe(container);
    }

    return () => {
      isDestroyed = true;
      clearTimeout(setupTimeoutId);
      clearTimeout(forceHideTimeoutId);
      clearTimeout(delayedResizeId);
      if (resizeDebounceId) clearTimeout(resizeDebounceId);
      canvas.removeEventListener('webglcontextlost', handleContextLost);
      canvas.removeEventListener('webglcontextrestored', handleContextRestored);
      if (resizeObserver) resizeObserver.disconnect();
      webgpuEngineRef.current?.destroy();
      webglEngineRef.current?.destroy();
      webglEngineRef.current = null;
      // Clear keyboard state to prevent stuck keys after unmount
      keysPressedRef.current.clear();
    };
  }, [activeEngineType, handleResize, useWorker]);

  // Main render loop
  useEffect(() => {
    let isRunning = true;
    let renderPaused = false;
    let lastRenderTimestamp = performance.now();
    let consecutiveRenderErrors = 0; // Track consecutive render failures for quality recovery

    // Test harness pause/resume (headless browser screenshots)
    (window as any).__pauseRender = () => { renderPaused = true; };
    (window as any).__resumeRender = () => { renderPaused = false; lastRenderTimestamp = performance.now(); };
    // ?test=1&pauseRender=1 → auto-freeze after 3 rendered frames so slow software
    // compositors (design-qa screenshot capture) finish before the CDP 30s timeout.
    // Inert unless BOTH flags are present in the query string.
    const harnessSearch = typeof window !== 'undefined' ? window.location.search : '';
    let autoPauseAfterFrames = harnessSearch.includes('test=1') && harnessSearch.includes('pauseRender=1') ? 3 : -1;

    const handleVisibilityChange = () => {
      isVisibleRef.current = !document.hidden;
      if (isVisibleRef.current) {
        lastRenderTimestamp = performance.now();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const loop = (timestamp: number) => {
      if (!isRunning) return;
      if (renderPaused) {
        rafIdRef.current = requestAnimationFrame(loop);
        return;
      }
      if (contextLostRef.current) {
        rafIdRef.current = requestAnimationFrame(loop);
        return;
      }
      if (!isVisibleRef.current) {
        rafIdRef.current = requestAnimationFrame(loop);
        return;
      }
      if (!engineReadyRef.current) {
        setTimeout(() => {
          if (isRunning) rafIdRef.current = requestAnimationFrame(loop);
        }, 1000);
        return;
      }

      const currentParams = paramsRef.current;
      const elapsedSinceLast = timestamp - lastRenderTimestamp;
      // Mobile: cap at 30 FPS to prevent GPU overheating and browser crashes
      const defaultTargetFps = isMobileDevice ? 30 : 60;
      const targetFps = currentParams.targetFps || defaultTargetFps;
      const effectiveTargetFps = isMobileDevice ? Math.min(targetFps, 30) : targetFps;
      const targetInterval = effectiveTargetFps >= 240 ? 0 : (1000 / effectiveTargetFps);

      if (targetInterval <= 0 || elapsedSinceLast >= targetInterval - 0.75) {
        const deltaMs = Math.min(elapsedSinceLast, 100);
        lastRenderTimestamp = timestamp;
        if (autoPauseAfterFrames >= 0 && --autoPauseAfterFrames === 0) renderPaused = true;

        simTimeRef.current += (deltaMs / 1000.0);
        // Wrap simTime to prevent float32 precision loss after extended runtime
        // Shader uses sin/cos (periodic), so wrapping is mathematically transparent
        if (simTimeRef.current > 3600) simTimeRef.current %= 3600;
        const simTime = simTimeRef.current;

        // Fly-through keyboard movement
        if (currentParams.cameraMode === 'flyThrough') {
          const yaw = currentParams.rotX;
          const pitch = currentParams.rotY;
          const cy = Math.cos(yaw);
          const sy = Math.sin(yaw);
          const cp = Math.cos(pitch);
          const sp = Math.sin(pitch);
          const forward = [sy * cp, sp, -cy * cp];
          const right = [cy, 0, sy];
          const up = [0, 1, 0];

          let moveSpeed = 1.4 * (deltaMs / 1000.0);
          if (keysPressedRef.current.has('ShiftLeft') || keysPressedRef.current.has('ShiftRight')) {
            moveSpeed *= 2.8;
          }

          let dx = 0, dy = 0, dz = 0;
          if (keysPressedRef.current.has('KeyW') || keysPressedRef.current.has('ArrowUp')) {
            dx += forward[0] * moveSpeed; dy += forward[1] * moveSpeed; dz += forward[2] * moveSpeed;
          }
          if (keysPressedRef.current.has('KeyS') || keysPressedRef.current.has('ArrowDown')) {
            dx -= forward[0] * moveSpeed; dy -= forward[1] * moveSpeed; dz -= forward[2] * moveSpeed;
          }
          if (keysPressedRef.current.has('KeyA') || keysPressedRef.current.has('ArrowLeft')) {
            dx -= right[0] * moveSpeed; dz -= right[2] * moveSpeed;
          }
          if (keysPressedRef.current.has('KeyD') || keysPressedRef.current.has('ArrowRight')) {
            dx += right[0] * moveSpeed; dz += right[2] * moveSpeed;
          }
          if (keysPressedRef.current.has('KeyE') || keysPressedRef.current.has('Space')) {
            dy += up[1] * moveSpeed;
          }
          if (keysPressedRef.current.has('KeyQ') || keysPressedRef.current.has('KeyC')) {
            dy -= up[1] * moveSpeed;
          }

          if (dx !== 0 || dy !== 0 || dz !== 0) {
            paramsRef.current = {
              ...currentParams,
              camPosX: (currentParams.camPosX ?? 0) + dx,
              camPosY: (currentParams.camPosY ?? 0) + dy,
              camPosZ: (currentParams.camPosZ ?? 0) + dz,
            };
          }
        }

        // Auto rotation — PAUSED during interaction (drag/zoom), holds absolutely still
        // for the idle window, then eases the spin back in. Accumulated incrementally into
        // autoRotAccumRef (see ref comment) so there is NO jump when grabbing/releasing:
        // the old absolute `simTime * speed` term was re-added every frame on top of rotX
        // but never persisted, so it disappeared the instant interaction began (the reported
        // "вращение / остановить-запустить работает плохо" — the figure snapped backward).
        const timeSinceLastMove = timestamp - lastMoveTimeRef.current;
        const isInteracting = isDraggingRef.current || timeSinceLastMove < AUTO_ROTATION_RESUME_DELAY;
        const wantAutoRotate = currentParams.autoRotate && !isInteracting;
        autoRotateEaseRef.current = wantAutoRotate
          ? Math.min(1, autoRotateEaseRef.current + deltaMs / 1200)
          : 0;
        if (autoRotateEaseRef.current > 0) {
          const spinRate = (currentParams.autoRotateSpeed ?? AUTO_ROTATE_SPEED) * 0.5; // rad/sec at full ease
          autoRotAccumRef.current += spinRate * autoRotateEaseRef.current * (deltaMs / 1000);
          autoRotPhaseRef.current += autoRotateEaseRef.current * (deltaMs / 1000) * 0.18;
          // Wrap the yaw to keep the float small; a full-turn wrap is visually identical so
          // it never reads as a jump.
          if (autoRotAccumRef.current > Math.PI * 2) autoRotAccumRef.current -= Math.PI * 2;
        }
        const autoRotX = autoRotAccumRef.current;
        const autoRotY = Math.sin(autoRotPhaseRef.current) * 0.05;

        // Inertia - frame-rate independent decay (was per-frame, now per-second)
        let inertiaRotX = 0, inertiaRotY = 0;
        if (inertiaEnabledRef.current && !isDraggingRef.current && (Math.abs(velocityRef.current.x) > inertiaThreshold || Math.abs(velocityRef.current.y) > inertiaThreshold)) {
          // Reuse the EXACT drag rotation factor so the release glide continues the
          // drag with no speed discontinuity. The previous zoom-dependent
          // dynamicSensitivity diverged from the fixed drag rotationSpeed, so at close
          // zooms the figure visibly stalled the instant the pointer was released.
          const dtSec = deltaMs / 1000.0;
          inertiaRotX = velocityRef.current.x * deltaMs * INERTIA_ROT_SPEED;
          inertiaRotY = velocityRef.current.y * deltaMs * INERTIA_ROT_SPEED;
          // Frame-rate independent decay: 0.94 at 60fps → same feel at any FPS
          const frameRateIndependentDecay = Math.pow(inertiaDecay, dtSec * 60);
          velocityRef.current.x *= frameRateIndependentDecay;
          velocityRef.current.y *= frameRateIndependentDecay;
          if (Math.abs(velocityRef.current.x) < inertiaThreshold) velocityRef.current.x = 0;
          if (Math.abs(velocityRef.current.y) < inertiaThreshold) velocityRef.current.y = 0;
        }

        const effectiveParams: FractalParams = {
          ...currentParams,
          rotX: currentParams.rotX + autoRotX + inertiaRotX,
          rotY: Math.max(-1.52, Math.min(1.52, currentParams.rotY + autoRotY + inertiaRotY)),
        };

        // Render — wrapped in try/catch to prevent render loop crash
        const curCanvas = canvasRef.current;
        const workerEngine = webglEngineRef.current instanceof WorkerWebGLEngine ? webglEngineRef.current : null;
        const width = workerEngine?.width ?? curCanvas?.width ?? 0;
        const height = workerEngine?.height ?? curCanvas?.height ?? 0;
        let frameMs = workerEngine ? 0 : deltaMs;
        if (curCanvas && width > 0 && height > 0) {
          try {
            // Detect shader swap start — overlay shows only for swaps that take real
            // time: prefetched programs swap synchronously inside render() (guard never
            // set), and the 400ms grace absorbs single-frame cold swaps without a flash.
            const activeEngine = webglEngineRef.current || webgpuEngineRef.current;
            const isSwapping = activeEngine?.isShaderSwapping() === true;
            if (isSwapping && firstRenderDoneRef.current) {
              if (swapGraceStartRef.current === 0) {
                swapGraceStartRef.current = performance.now();
              } else if (performance.now() - swapGraceStartRef.current > 400) {
                setIsCompiling(true);
                // Honest percentage from the engine's live ShaderManager stages —
                // identical value most frames, so React bails without re-renders.
                setShaderCompilePct(activeEngine?.getSwapProgress() ?? 0);
              }
            } else {
              swapGraceStartRef.current = 0;
            }

            let drewFrame = false;
            if (webgpuEngineRef.current) {
              drewFrame = webgpuEngineRef.current.render(simTime, effectiveParams);
            } else if (webglEngineRef.current) {
              drewFrame = webglEngineRef.current.render(simTime, effectiveParams);
            }
            if (workerEngine && drewFrame) frameMs = workerEngine.frameIntervalMs;
            consecutiveRenderErrors = 0; // Reset on successful render

            // Hide loading overlay after first successful render OR after swap completes
            if (!firstRenderDoneRef.current) {
              // render() returns false on silent skips (program/pipeline still lazily
              // compiling). Only a REAL drawn frame — actual pixels on the canvas —
              // may dismiss the loader; otherwise the fade would expose a black canvas
              // on slow GPUs where compile outlives the 500+700ms dismiss.
              if (drewFrame) {
                firstRenderDoneRef.current = true;
                setIsCompiling(false);
                // First pixels are genuinely on screen → loading is truly done. This
                // is the signal that syncs the loader lifetime to real device init.
                logger.info('[useRenderEngine] First frame rendered — device init complete, dismissing loader');
                setLoadProgress(1);
                onEngineReadyRef.current?.();
              }
            } else if (!isSwapping) {
              // Swap completed — hide overlay
              setIsCompiling(false);
              setShaderCompilePct(0);
            }
          } catch (renderErr) {
            logger.error('[useRenderEngine] Render frame error:', renderErr);
            // Track consecutive errors — force minimum quality after 10 failures
            // to help GPU recover from persistent driver/hardware issues
            consecutiveRenderErrors++;
            if (consecutiveRenderErrors >= CONSECUTIVE_ERROR_FLOOR) {
              const errEngine = webglEngineRef.current || webgpuEngineRef.current;
              if (errEngine && errEngine.qualityLevel > 0) {
                errEngine.setQualityLevel(0);
                logger.warn('[useRenderEngine] 10+ consecutive render errors — forcing quality to minimum');
              }
              consecutiveRenderErrors = 0;
            }
            // Don't crash the loop — skip this frame
          }
        }

        // Screenshot
        if (screenshotRequestedRef.current && curCanvas) {
          try {
            if (workerEngine) {
              workerEngine.requestScreenshot(url => onScreenshotCapturedRef.current?.(url));
            } else {
              const dataUrl = curCanvas.toDataURL('image/png');
              onScreenshotCapturedRef.current?.(dataUrl);
            }
          } catch (e) {
            logger.error('Screenshot capture failed', e);
          }
        }

        // Telemetry
        const frameHistory = frameTimesRef.current;
        if (frameMs > 0) {
          frameHistory.push(frameMs);
          if (frameHistory.length > 40) frameHistory.shift();
        }

        if (frameMs > 0 && timestamp - lastTelemetryDispatchRef.current > 250) {
          lastTelemetryDispatchRef.current = timestamp;

          const avgFrameMs = frameHistory.reduce((a, b) => a + b, 0) / frameHistory.length;
          const currentFps = Math.round(1000 / frameMs);
          const avgFps = avgFrameMs > 0 ? Math.round(1000 / avgFrameMs) : 0;

          const sortedTimes = [...frameHistory].sort((a, b) => b - a);
          const lowIndex = Math.floor(sortedTimes.length * 0.05);
          const slowestTime = sortedTimes[lowIndex] || deltaMs;
          const onePercentLow = slowestTime > 0 ? Math.round(1000 / slowestTime) : 0;

          const adapter = webgpuEngineRef.current
            ? webgpuEngineRef.current.adapterInfo
            : (webglEngineRef.current ? webglEngineRef.current.rendererInfo : 'GPU Engine');

          const label = activeEngineType === 'webgpu' ? 'WebGPU (WGSL)' : 'WebGL2 (GLSL)';

          const telemetry: TelemetryData = {
            fps: currentFps,
            avgFps,
            frameTimeMs: parseFloat(frameMs.toFixed(2)),
            onePercentLow,
            backend: label as 'WebGPU (WGSL)' | 'WebGL2 (GLSL)',
            adapterName: adapter,
            resolution: [width, height],
            drsScale: 1.0,
            targetFps: currentParams.targetFps,
            interiorDistance: 0.0,
          };

          onTelemetryUpdateRef.current?.(telemetry);
          setFpsState(currentFps);
          setAvgFpsState(avgFps);
          setFrameTimeState(parseFloat(frameMs.toFixed(2)));
          setOnePercentLowState(onePercentLow);
          setResolutionState([width, height]);

          // Periodic health diagnostic every 30s
          if (!lastHealthLogRef.current) lastHealthLogRef.current = timestamp;
          if (timestamp - lastHealthLogRef.current > 30000) {
            lastHealthLogRef.current = timestamp;
            const p = paramsRef.current;
            logger.info(`[DIAG] Health: fps=${currentFps} avg=${avgFps} 1%=${onePercentLow} | fractal=${p.type} hybrid=${p.hybridType} | style=${p.renderStyle} cam=${p.cameraMode} | palette=${p.paletteId} seed=${p.paletteSeed ?? 0} rot=${p.paletteRotation} | audio=${p.enableAudio} tuning=${p.audioTuning} | res=${width}x${height}`);
          }

          // DYNAMIC QUALITY: Auto-adjust based on FPS with hysteresis and cooldown
          // Uses separate thresholds for up/down to prevent oscillation
          // Cooldown: minimum 3s between quality changes to avoid rapid flipping
          const engine = webglEngineRef.current || webgpuEngineRef.current;
          if (engine) {
            const currentQuality = engine.qualityLevel;
            const mobileTargetFps = isMobileDevice ? Math.min(currentParams.targetFps || FPS_TARGET_MOBILE, FPS_TARGET_MOBILE) : (currentParams.targetFps || FPS_TARGET_DESKTOP);
            const downThreshold = mobileTargetFps * QUALITY_DOWN_THRESHOLD_RATIO;
            const upThreshold = mobileTargetFps * QUALITY_UP_THRESHOLD_RATIO;
            const now = performance.now();
            const qualityCooldown = QUALITY_COOLDOWN_MS;
            
            if (avgFps < downThreshold && currentQuality > 0 && (now - lastQualityChangeRef.current) > qualityCooldown) {
              engine.setQualityLevel(currentQuality - 1);
              lastQualityChangeRef.current = now;
              logger.warn(`[DynamicQuality] FPS ${avgFps} < ${downThreshold.toFixed(1)} → quality ${currentQuality} → ${currentQuality - 1}`);
            } else if (avgFps > upThreshold && currentQuality < 2 && (now - lastQualityChangeRef.current) > qualityCooldown) {
              engine.setQualityLevel(currentQuality + 1);
              lastQualityChangeRef.current = now;
              logger.info(`[DynamicQuality] FPS ${avgFps} > ${upThreshold.toFixed(1)} → quality ${currentQuality} → ${currentQuality + 1}`);
            }
          }
        }
      }

      rafIdRef.current = requestAnimationFrame(loop);
    };

    rafIdRef.current = requestAnimationFrame(loop);

    return () => {
      isRunning = false;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
    };
  }, [activeEngineType]);

  // Background prefetch: while the user views/controls the current fractal, pre-compile
  // the predicted NEXT (and next-after-that) specimen shaders into the WebGL engine's
  // LRU cache in parallel (non-blocking KHR poll loop, GPU-process side). The actual
  // switch then takes the synchronous cached fast path — no skipped frames, no
  // "Initializing GPU" chip. Two-ahead + parallel in flight is what covers the fast
  // clicker: on real hardware one cold ANGLE compile still takes seconds-to-tens-of-
  // seconds, so a single serial prefetch could not finish before the next click.
  // Retries until the engine reports prefetch safety (no swap in flight, queue room).
  useEffect(() => {
    const types = (nextSpecimenTypes ?? []).filter(Boolean) as FractalType[];
    if (!types.length) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tryPrefetch = () => {
      if (cancelled) return;
      const engine = webglEngineRef.current;
      if (!engine) {
        // WebGPU backend has no prefetch path — stop instead of spinning forever;
        // while WebGL is still setting up, keep retrying until the ref exists.
        if (activeEngineType === 'webgpu') return;
        timer = setTimeout(tryPrefetch, PREFETCH_RETRY_DELAY_MS);
        return;
      }
      // Cold-start guard: ANGLE/D3D11 serializes the driver-side LINK step, so launching
      // background prefetches while the FIRST fractal is still compiling pushes the
      // critical-path shader's completion behind them and delays the first painted frame.
      // Hold prefetch until the first real frame is on screen; after that, warming the
      // next figures still makes subsequent switches instant (the original goal).
      if (!firstRenderDoneRef.current) {
        timer = setTimeout(tryPrefetch, PREFETCH_COLD_START_DELAY_MS);
        return;
      }
      if (engine.canPrefetch) {
        // prefetchFractal self-gates on canPrefetch/queue room, so listing every
        // predicted type just fills the parallel queue by priority order.
        for (const t of types) engine.prefetchFractal(getFractalIndex(t));
        return;
      }
      timer = setTimeout(tryPrefetch, PREFETCH_RETRY_DELAY_MS);
    };
    timer = setTimeout(tryPrefetch, PREFETCH_INITIAL_DELAY_MS);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [nextSpecimenTypes, activeEngineType]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const targetTag = (e.target as HTMLElement)?.tagName;
      if (targetTag === 'INPUT' || targetTag === 'TEXTAREA' || targetTag === 'SELECT') return;
      // Space/Enter on a focused BUTTON belong to native button activation — firing
      // onNext here too would double-advance the feed (window handler + button click).
      if (targetTag === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;
      if (e.repeat) return;
      keysPressedRef.current.add(e.code);

      if (paramsRef.current.cameraMode !== 'flyThrough') {
        if (e.key === ' ' || e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown') {
          e.preventDefault();
          onNextSpecimenRef.current?.();
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') {
          e.preventDefault();
          onPrevSpecimenRef.current?.();
        } else if (e.key === 's' || e.key === 'S' || e.key === 'ы' || e.key === 'Ы') {
          // Toggle auto-rotation start/stop (S or Russian Ы). Committed through React state
          // (commitParams) so it PERSISTS — the previous direct paramsRef write was reverted
          // the next time the controlled `params` prop re-synced, so stopping never stuck.
          e.preventDefault();
          velocityRef.current = { x: 0, y: 0 };
          const nextAutoRotate = !paramsRef.current.autoRotate;
          if (commitParamsRef.current) {
            commitParamsRef.current(prev => ({ ...prev, autoRotate: nextAutoRotate }));
          } else if (paramsRef.current) {
            paramsRef.current = { ...paramsRef.current, autoRotate: nextAutoRotate };
          }
          logger.info(`[Controls] Auto-rotation ${nextAutoRotate ? 'started' : 'stopped'} (S key)`);
        } else if (e.key === 'i' || e.key === 'I' || e.key === 'ш' || e.key === 'Ш') {
          // Toggle inertia (I or Russian Ш)
          e.preventDefault();
          inertiaEnabledRef.current = !inertiaEnabledRef.current;
          if (!inertiaEnabledRef.current) {
            velocityRef.current = { x: 0, y: 0 };
          }
          logger.info(`[Controls] Inertia ${inertiaEnabledRef.current ? 'enabled' : 'disabled'} (I key)`);
        } else if (/^[1-9]$/.test(e.key) || e.key === '0') {
          // Quick render mode switch: keys 1-9 → styles 1-9, key 0 → style 10 (neon)
          e.preventDefault();
          const RENDER_STYLE_NAMES: RenderStyle[] = ['solid', 'xray', 'topo', 'hologram', 'iridescent', 'quantum', 'gemstone', 'wireframe', 'heatmap', 'neon'];
          const renderStyleIndex = e.key === '0' ? 9 : parseInt(e.key) - 1;
          const renderStyleName = RENDER_STYLE_NAMES[renderStyleIndex] || 'solid';
          if (paramsRef.current) {
            paramsRef.current = {
              ...paramsRef.current,
              renderStyle: renderStyleName,
            };
          }
          logger.info(`[Controls] Render mode: ${renderStyleName} (${e.key} key)`);
        } else if (e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К') {
          // Reset camera position (R or Russian К)
          e.preventDefault();
          velocityRef.current = { x: 0, y: 0 };
          if (paramsRef.current) {
            paramsRef.current = {
              ...paramsRef.current,
              rotX: 0,
              rotY: 0,
              zoom: 2.5,
              camPosX: 0,
              camPosY: 0,
              camPosZ: 0,
            };
          }
          logger.info('[Controls] Camera reset (R key)');
        }
      }

      // F-key toggle works in ALL camera modes (was trapped inside !== 'flyThrough' guard)
      if (e.key === 'f' || e.key === 'F' || e.key === 'а' || e.key === 'А') {
        e.preventDefault();
        if (paramsRef.current) {
          const newMode: CameraMode = paramsRef.current.cameraMode === 'flyThrough' ? 'orbit' : 'flyThrough';
          paramsRef.current = {
            ...paramsRef.current,
            cameraMode: newMode,
          };
          logger.info(`[Controls] Camera mode: ${newMode} (F key)`);
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      keysPressedRef.current.delete(e.code);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // Stop rotation function - immediately stops all rotation and inertia (persisted via
  // commitParams so a later prop re-sync cannot silently restart the auto-spin).
  const stopRotation = useCallback(() => {
    velocityRef.current = { x: 0, y: 0 };
    if (commitParamsRef.current) {
      commitParamsRef.current(prev => ({ ...prev, autoRotate: false }));
    } else if (paramsRef.current) {
      paramsRef.current = { ...paramsRef.current, autoRotate: false };
    }
  }, []);

  // Toggle inertia on/off
  const toggleInertia = useCallback(() => {
    inertiaEnabledRef.current = !inertiaEnabledRef.current;
    if (!inertiaEnabledRef.current) {
      // If disabling inertia, stop all rotation immediately
      velocityRef.current = { x: 0, y: 0 };
    }
  }, []);

  return {
    activeEngineType,
    isCompiling,
    shaderCompilePct,
    isEngineReady,
    initFailed,
    loadProgress,
    backendLabel,
    adapterInfo: adapterInfoState,
    fps: fpsState,
    avgFps: avgFpsState,
    frameTimeMs: frameTimeState,
    onePercentLow: onePercentLowState,
    resolution: resolutionState,
    canvasRef,
    canvasKey,
    keysPressedRef,
    isDraggingRef,
    velocityRef,
    lastMousePosRef,
    lastInteractionReportTimeRef,
    lastMoveTimeRef,
    inertiaEnabledRef,
    stopRotation,
    toggleInertia,
    params: paramsRef.current,
  };
}
