import React, { useRef, useCallback, useEffect } from 'react';
import { FractalParams, FractalType, TelemetryData } from '../types/fractal';
import { useRenderEngine } from '../hooks/useRenderEngine';
import { userProblemLogger } from '../engine/UserProblemLogger';
import { INERTIA_ROT_SPEED } from '../constants';

interface FractalCanvasProps {
  params: FractalParams;
  onParamsChange: (updater: (prev: FractalParams) => FractalParams) => void;
  onTelemetryUpdate: (telemetry: TelemetryData) => void;
  screenshotRequested: boolean;
  onScreenshotCaptured: (dataUrl: string) => void;
  forcedBackend?: 'webgpu' | 'webgl2' | 'auto';
  onInteraction?: (zoomDelta: number, orbitDelta: number) => void;
  onNextSpecimen?: () => void;
  onPrevSpecimen?: () => void;
  onEngineReady?: () => void;
  onLoadProgress?: (progress: number) => void;
  // Predicted next specimen types (1st and 2nd ahead) — their shaders are background-
  // prefetched in parallel by the engine while the user views the current fractal,
  // making the upcoming switches instant.
  nextSpecimenTypes?: FractalType[] | null;
  scrollMode?: 'feed' | 'zoom';
}

export const FractalCanvas: React.FC<FractalCanvasProps> = ({
  params,
  onParamsChange,
  onTelemetryUpdate,
  screenshotRequested,
  onScreenshotCaptured,
  forcedBackend = 'auto' as const,
  onInteraction,
  onNextSpecimen,
  onPrevSpecimen,
  onEngineReady,
  onLoadProgress,
  nextSpecimenTypes,
  scrollMode = 'zoom',
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  // Detect embedded/sandboxed browser environments where WebGPU may crash the GPU process
  const isEmbeddedBrowser = typeof window !== 'undefined' && (
    window !== window.top ||
    /\bqoder\b/i.test(navigator.userAgent) ||
    /\belectron\b/i.test(navigator.userAgent)
  );
  const isMobileDevice = typeof window !== 'undefined' && (
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && window.innerWidth < 1024)
  );

  // Params Ref so animation loop never re-subscribes or drops frames
  const paramsRef = useRef<FractalParams>(params);
  // Keep ref in sync with prop
  paramsRef.current = params;

  // Touch pinch zoom state (UI-only, not needed in render loop)
  const touchDistanceRef = useRef<number | null>(null);
  const lastWheelTimeRef = useRef<number>(0);
  const lastFeedNavRef = useRef<number>(0); // debounce wheel-driven feed navigation

  // Use the render engine hook
  const engine = useRenderEngine(containerRef, {
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
    commitParams: onParamsChange,
    screenshotRequested,
    onScreenshotCaptured,
  });

  const { canvasRef, canvasKey, isDraggingRef, velocityRef, lastMousePosRef, lastInteractionReportTimeRef, lastMoveTimeRef, activeEngineType, isCompiling, shaderCompilePct, initFailed, loadProgress, stopRotation, toggleInertia, inertiaEnabledRef } = engine;

  // Surface REAL loading progress (device init + shader compile + first frame) so
  // the top-level loader can sync its animation to actual initialization time.
  useEffect(() => {
    onLoadProgress?.(loadProgress);
  }, [loadProgress, onLoadProgress]);

  // Native wheel/touch listeners with passive:false + capture:true
  // capture:true ensures our listeners fire BEFORE React's document-level passive listeners
  // This is the only reliable way to preventDefault() wheel/touch in React 19
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      userProblemLogger.log({
        level: 'error',
        category: 'render',
        message: 'FractalCanvas: canvas ref is null on mount'
      });
      return;
    }

    userProblemLogger.log({
      level: 'info',
      category: 'render',
      message: 'FractalCanvas: mounted',
      details: {
        width: canvas.width,
        height: canvas.height,
        activeEngineType
      }
    });

    const wheelHandler = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation(); // Prevent React 19 root-level passive listener from also calling preventDefault
      lastMoveTimeRef.current = performance.now(); // Pause auto-rotation during zoom
      // Honor the scroll-mode toggle (previously ignored here — the canvas always zoomed,
      // so the "Лента / Зум" switch was purely cosmetic). Feed mode navigates specimens
      // with a 250ms debounce (a trackpad emits a burst of tiny deltas per gesture); zoom
      // mode scales the camera.
      if (scrollMode === 'feed') {
        const now = performance.now();
        if (now - lastFeedNavRef.current < 250) return;
        lastFeedNavRef.current = now;
        onInteraction?.(Math.abs(e.deltaY) * 0.015, 0);
        if (e.deltaY > 0) onNextSpecimen?.();
        else onPrevSpecimen?.();
        return;
      }
      // Zoom mode: proportional curve (removed the old Math.sign hard-cap that made a
      // trackpad's small continuous deltas barely move the view while a wheel notch jumped).
      const norm = Math.max(-1.5, Math.min(1.5, e.deltaY / 100));
      const zoomFactor = Math.exp(-norm * 0.12); // scroll down = zoom out, up = zoom in
      onInteraction?.(Math.abs(e.deltaY) * 0.015, 0);
      onParamsChange(prev => ({
        ...prev,
        zoom: Math.max(0.01, Math.min(100.0, prev.zoom * zoomFactor)),
      }));
    };
    canvas.addEventListener('wheel', wheelHandler, { passive: false, capture: true });

    const touchStartHandler = (e: TouchEvent) => {
      // Always prevent default on touch to avoid duplicate pointer events on mobile
      // and prevent browser gestures (pull-to-refresh, swipe nav) from interfering
      e.preventDefault();
      lastMoveTimeRef.current = performance.now(); // Pause auto-rotation during touch
      if (e.touches.length === 2) {
        e.stopPropagation(); // Prevent React 19 root-level passive listener conflict
        const t1 = e.touches[0], t2 = e.touches[1];
        touchDistanceRef.current = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      }
    };
    canvas.addEventListener('touchstart', touchStartHandler, { passive: false, capture: true });

    const touchMoveHandler = (e: TouchEvent) => {
      e.preventDefault(); // Prevent browser scroll/zoom gestures
      lastMoveTimeRef.current = performance.now(); // Pause auto-rotation during touch
      if (e.touches.length === 2) {
        e.stopPropagation(); // Prevent React 19 root-level passive listener conflict
        const t1 = e.touches[0], t2 = e.touches[1];
        const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        if (touchDistanceRef.current !== null && touchDistanceRef.current > 5) {
          const ratio = touchDistanceRef.current / Math.max(dist, 1);
          const touchFactor = Math.pow(ratio, 0.95);
          onInteraction?.(Math.abs(touchDistanceRef.current - dist) * 0.04, 0);
          onParamsChange(prev => ({
            ...prev,
            zoom: Math.max(0.01, Math.min(100.0, prev.zoom * touchFactor)),
          }));
        }
        touchDistanceRef.current = dist;
      }
    };
    canvas.addEventListener('touchmove', touchMoveHandler, { passive: false, capture: true });

    return () => {
      canvas.removeEventListener('wheel', wheelHandler, { capture: true });
      canvas.removeEventListener('touchstart', touchStartHandler, { capture: true });
      canvas.removeEventListener('touchmove', touchMoveHandler, { capture: true });
    };
  }, [canvasRef, canvasKey, onParamsChange, onInteraction, scrollMode, onNextSpecimen, onPrevSpecimen, lastMoveTimeRef]);

  // Pointer Handlers for 3D Orbit with Inertia
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    isDraggingRef.current = true;
    lastMousePosRef.current = { x: e.clientX, y: e.clientY };
    // STOP ROTATION: When user clicks/holds, stop all rotation immediately
    velocityRef.current = { x: 0, y: 0 };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDraggingRef.current) return;
    const dx = e.clientX - lastMousePosRef.current.x;
    const dy = e.clientY - lastMousePosRef.current.y;
    const now = performance.now();
    const dt = Math.max(1, now - lastMoveTimeRef.current);
    lastMoveTimeRef.current = now;
    lastMousePosRef.current = { x: e.clientX, y: e.clientY };

    const orbitMagnitude = Math.hypot(dx, dy);
    if (now - lastInteractionReportTimeRef.current > 300) {
      lastInteractionReportTimeRef.current = now;
      onInteraction?.(0, orbitMagnitude);
    }

    // BRAKING LOGIC: If moving opposite to current velocity, apply braking
    const prevVelX = velocityRef.current.x;
    const prevVelY = velocityRef.current.y;
    const newVelX = dx / dt;
    const newVelY = dy / dt;
    
    // Check if direction changed (opposite movement)
    const directionChangedX = (prevVelX > 0.001 && newVelX < -0.001) || (prevVelX < -0.001 && newVelX > 0.001);
    const directionChangedY = (prevVelY > 0.001 && newVelY < -0.001) || (prevVelY < -0.001 && newVelY > 0.001);
    
    // If direction changed, stop rotation immediately
    if (directionChangedX || directionChangedY) {
      velocityRef.current = { x: 0, y: 0 };
    } else {
      // Exponential moving average of the instantaneous velocity instead of the raw
      // last-sample value. The old code stored a single pointermove delta, so a small
      // final move before lifting (people decelerate to aim) zeroed the flick, and a
      // lone spike over-shot it. Averaging over a ~30ms recent-motion window makes a
      // sharp flick-and-release throw with consistent, predictable momentum on mouse,
      // touch and pen alike.
      const velBlend = 1 - Math.exp(-dt / 30);
      velocityRef.current = {
        x: prevVelX + (newVelX - prevVelX) * velBlend,
        y: prevVelY + (newVelY - prevVelY) * velBlend,
      };
    }
    
    // If velocity is very low, stop completely
    if (Math.abs(velocityRef.current.x) < 0.0005 && Math.abs(velocityRef.current.y) < 0.0005) {
      velocityRef.current = { x: 0, y: 0 };
    }

    // Apply rotation with improved sensitivity
    const rotationSpeed = INERTIA_ROT_SPEED; // shared with useRenderEngine inertia (single source)
    const rotDeltaX = dx * rotationSpeed;
    const rotDeltaY = dy * rotationSpeed;

    onParamsChange(prev => ({
      ...prev,
      rotX: ((prev.rotX + rotDeltaX + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI,
      rotY: Math.max(-1.5, Math.min(1.5, prev.rotY + rotDeltaY)),
    }));

  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    isDraggingRef.current = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
  };

  const handleTouchEnd = () => {
    touchDistanceRef.current = null;
  };

  return (
    <div
      ref={containerRef}
      id="fractal-canvas-container"
      className="absolute inset-0 w-full h-full overflow-hidden bg-black select-none touch-none overscroll-none cursor-grab active:cursor-grabbing"
    >
      {/* Clear user-facing message when no GPU backend could initialize (silent failure,
          not caught by the React error boundary) — instead of a blank black canvas. */}
      {initFailed && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-neutral-950 text-neutral-100 p-8 text-center">
          <h2 className="text-xl font-semibold mb-3">3D rendering unavailable</h2>
          <p className="text-neutral-400 max-w-md mb-2">
            This app needs WebGL2 or WebGPU, which could not be started on this device or browser.
          </p>
          <p className="text-neutral-500 text-sm max-w-md mb-6">
            Try updating your browser, enabling hardware acceleration, or using a different GPU.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="px-6 py-3 bg-indigo-600 hover:bg-indigo-500 rounded-lg font-medium transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Visual indicator when GPU pipeline is compiling shaders. The percentage is the
          REAL ShaderManager stage progress of the pending swap (getSwapProgress), so on
          slow cold compiles the user sees honest movement instead of a blind pulse. */}
      {isCompiling && (
        <div
          id="gpu-pipeline-loading-overlay"
          className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-neutral-950/60 backdrop-blur-xs pointer-events-none transition-opacity duration-300"
        >
          <div className="flex flex-col items-center gap-2 px-4 py-2.5 rounded-2xl bg-neutral-900/90 border border-amber-500/30 text-amber-300 text-xs font-mono shadow-2xl">
            <div className="flex items-center gap-2 animate-pulse">
              <div className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
              <span>
                Initializing GPU ({activeEngineType === 'webgpu' ? 'WebGPU WGSL' : 'WebGL2 GLSL'})
                {shaderCompilePct > 0 ? ` — ${shaderCompilePct}%` : '...'}
              </span>
            </div>
            {shaderCompilePct > 0 && (
              <div className="w-44 h-1 rounded-full bg-neutral-800 overflow-hidden">
                <div
                  className="h-full bg-amber-400/80 rounded-full transition-all duration-500 ease-out"
                  style={{ width: `${Math.min(shaderCompilePct, 100)}%` }}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* A transferred canvas cannot be reused when switching renderers. */}
      <canvas
        key={canvasKey}
        ref={canvasRef}
        id="fractal-canvas"
        className="w-full h-full block touch-none"
        role="img"
        aria-label={`3D фрактал: ${params.type} (WebGL2/WebGPU raymarcher)`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onTouchEnd={handleTouchEnd}
      />
    </div>
  );
};
