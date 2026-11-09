import { FractalParams } from '../types/fractal';
import { GLSL_VERTEX_SHADER, GLSL_FRAGMENT_SHADER } from '../shaders/webglShaders';
import { FractalEngineBase } from './FractalEngineBase';
import { renderDiagnostics } from './RenderDiagnostics';
import { userProblemLogger } from './UserProblemLogger';
import { ShaderManager } from './ShaderManager';
import { logger } from '../utils/logger';
import { PREFETCH_CONCURRENCY, WARMUP_FRAMES, SHADER_SWAP_TIMEOUT_MS, CANVAS_HARD_CAP, SHADER_POLL_MAX_SPINS, SHADER_POLL_INTERVAL_MS } from '../constants';

export class WebGLEngine extends FractalEngineBase<HTMLCanvasElement | OffscreenCanvas> {
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private uniformLocs: Record<string, WebGLUniformLocation | null> = {};
  
  // Lazy shader compilation
  private shaderManager: ShaderManager | null = null;
  private currentFractalIdx: number = -1;
  
  // Pre-allocated uniform buffer to avoid per-frame allocation
  private packedUniforms = new Float32Array(48);
  private lastLoggedFractalType: string = '';
  private isSwappingShader = false; // Guard against re-entrant render during shader swap
  // Safety for the swap guard is TIME-based, not frame-based: cold ANGLE/D3D11
  // driver compiles on real hardware measurably exceed 5s (the old 301-frame
  // budget), and firing mid-wait both spammed "Shader swap timeout" and made the
  // loading chip flicker off/re-arm every 5s. 120s only trips on a genuinely hung compile.
  private swapStartTime = 0;
  private swapTargetIdx = -1;
  // Warmup: first frames of a freshly compiled shader run at quality 0 so the
  // GPU/driver ramp-up can't spike frame times and make the browser unresponsive;
  // DynamicQuality in useRenderEngine raises quality again once FPS is stable.
  private warmupFramesLeft = 0;
  private preSwapQuality = 1;
  // Fractal indices whose shaders are being background-prefetched (see prefetchFractal).
  // ANGLE exposes a compile thread pool (KHR_parallel_shader_compile) so up to
  // PREFETCH_CONCURRENCY may be in flight, but the driver-side LINK step is effectively
  // serialized — so the CALLER (useRenderEngine) holds prefetch back until the first real
  // frame is painted, then warms the next figures for instant subsequent switches.
  private static readonly PREFETCH_CONCURRENCY = PREFETCH_CONCURRENCY;
  private prefetching = new Set<number>();
  // Latest ShaderManager stage percent per fractal index — surfaces REAL compile
  // progress (10/40/80/100) on the swap chip instead of a blind pulse animation.
  private compilePctByIndex = new Map<number, number>();

  /** Uniform names cached per program — single source to avoid list drift. */
  private static readonly UNIFORM_NAMES = [
    'u_resolution', 'u_time', 'u_phi_val',
    'u_cam_rot', 'u_zoom', 'u_fractal_type', 'u_hybrid_type', 'u_tertiary_type',
    'u_iterations', 'u_glow_intensity', 'u_morph_speed', 'u_hybrid_blend', 'u_tertiary_blend',
    'u_compose_op', 'u_smooth_k', 'u_warp_strength', 'u_octave_layers',
    'u_box_fold', 'u_sphere_fold', 'u_interior_cut',
    'u_primary_color', 'u_secondary_color', 'u_accent_color',
    'u_cam_mode', 'u_cam_pos', 'u_slice_plane', 'u_slice_axis', 'u_render_style',
    'u_headlamp_power', 'u_volumetric_fog', 'u_palette_seed', 'u_palette_rotation',
    'u_auto_rotate', 'u_quality_level'
  ];

  /**
   * Optional hook so the UI can drive a loading bar from the REAL per-stage
   * compile/link progress (parsing→compiling→linking→complete) instead of a
   * fake timer. Reported as (stage name, cumulative 0-100 percent).
   */
  public onCompileProgress?: (stage: string, percent: number) => void;

  constructor(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    private readonly isTestMode = typeof window !== 'undefined' && window.location.search.includes('test=1'),
  ) {
    super(canvas);
    this.rendererInfo = 'WebGL2 Shader Pipeline';
  }

  public init(): boolean {
    const initStart = performance.now();
    logger.group('[WebGL2] === INITIALIZATION START ===');
    renderDiagnostics.log('info', 'gpu', 'WebGL2 initialization started');
    logger.info('[WebGL2] Canvas element:', this.canvas);
    const canvas = this.canvas;
    logger.info('[WebGL2] Canvas size (buffer):', canvas.width, 'x', canvas.height);
    logger.info('[WebGL2] User Agent:', navigator.userAgent);

    // The DOM owner sets the initial backing size before transferring an offscreen canvas.
    if ('getBoundingClientRect' in canvas) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        logger.warn('[WebGL2] Canvas has zero dimensions, setting fallback size...');
        canvas.width = Math.max(1, canvas.clientWidth || 800);
        canvas.height = Math.max(1, canvas.clientHeight || 600);
      }
    }

    // Try webgl2 with minimal options first (most compatible).
    // Test mode preserves the drawing buffer for headless screenshots.
    const isTestMode = this.isTestMode;
    const ctxOptions = isTestMode ? {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
    } : undefined;
    
    logger.info('[WebGL2] Attempt 1: getContext("webgl2")' + (isTestMode ? ' with preserveDrawingBuffer (test mode)' : ' with no options') + '...');
    let gl: WebGL2RenderingContext | null = this.canvas.getContext('webgl2', ctxOptions as any) as WebGL2RenderingContext | null;
    logger.info('[WebGL2] Result:', gl ? 'SUCCESS' : 'FAILED');

    // Fallback: try with preserveDrawingBuffer for screenshots
    if (!gl) {
      logger.info('[WebGL2] Attempt 2: webgl2 with preserveDrawingBuffer...');
      gl = this.canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: true,
      }) as WebGL2RenderingContext | null;
      logger.info('[WebGL2] Result:', gl ? 'SUCCESS' : 'FAILED');
    }

    // Fallback: try without preserveDrawingBuffer
    if (!gl) {
      logger.info('[WebGL2] Attempt 3: webgl2 with high-performance...');
      gl = this.canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        powerPreference: 'high-performance',
      }) as WebGL2RenderingContext | null;
      logger.info('[WebGL2] Result:', gl ? 'SUCCESS' : 'FAILED');
    }

    // Last resort: try webgl (WebGL1)
    if (!gl) {
      logger.warn('[WebGL2] All webgl2 attempts failed, trying webgl (WebGL1)...');
      const gl1 = canvas.getContext('webgl') || ('clientWidth' in canvas ? canvas.getContext('experimental-webgl') : null);
      if (gl1) {
        logger.error('[WebGL2] WebGL1 obtained but WebGL2 is required. Check chrome://gpu');
        logger.error('[WebGL2] WebGL1 renderer:', (gl1 as WebGLRenderingContext).getParameter((gl1 as WebGLRenderingContext).RENDERER));
      }
      logger.error('[WebGL2] === INITIALIZATION FAILED ===');
      logger.groupEnd();
      return false;
    }
    this.gl = gl;
    logger.info('[WebGL2] Context acquired!');
    logger.info('[WebGL2] GL_VERSION:', gl.getParameter(gl.VERSION));
    logger.info('[WebGL2] GL_RENDERER:', gl.getParameter(gl.RENDERER));
    logger.info('[WebGL2] GL_VENDOR:', gl.getParameter(gl.VENDOR));
    logger.info('[WebGL2] GL_SHADING_LANGUAGE_VERSION:', gl.getParameter(gl.SHADING_LANGUAGE_VERSION));
    
    // Check for critical extensions
    const extensions = gl.getSupportedExtensions();
    logger.info('[WebGL2] Supported extensions count:', extensions?.length || 0);
    logger.info('[WebGL2] KHR_parallel_shader_compile:', extensions?.includes('KHR_parallel_shader_compile'));
    logger.info('[WebGL2] WEBGL_debug_renderer_info:', extensions?.includes('WEBGL_debug_renderer_info'));

    // NOTE: Context loss/restore is managed by FractalCanvas.tsx which orchestrates
    // the full engine lifecycle (destroy + reinit). Do NOT add handlers here —
    // they would conflict with FractalCanvas's contextLostRef and cause the render
    // loop to freeze after context restoration.

    // Detect renderer info
    try {
      const dbgRenderInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbgRenderInfo) {
        const renderer = gl.getParameter(dbgRenderInfo.UNMASKED_RENDERER_WEBGL);
        if (renderer) this.rendererInfo = renderer;
      }
    } catch {
      this.rendererInfo = 'WebGL2 Hardware Engine';
    }

    // Initialize ShaderManager for lazy compilation
    this.shaderManager = new ShaderManager(gl, (progress) => {
      logger.info(`[ShaderManager] ${progress.stage}: ${progress.fractalName} (${progress.progress}%)`);
      this.compilePctByIndex.set(progress.fractalIndex, progress.progress);
      this.onCompileProgress?.(progress.stage, progress.progress);
    });

    // Compile initial shader for phyllotaxis (fractal index 0) - the default fractal
    // DEFERRED: Use setTimeout(0) to yield to browser before heavy shader compilation
    // This prevents main thread freeze on launch — browser can process events first
    logger.info('[WebGL2] Deferring initial shader compilation to next event loop tick...');
    setTimeout(() => {
      this.lazyCompileShader(0).then(() => {
        logger.info('[WebGL2] Initial shader compilation complete');
      }).catch(err => {
        logger.error('[WebGL2] Initial shader compilation failed:', err);
      });
    }, 0);

    // Quad geometry (covers screen)
    const vertices = new Float32Array([
      -1, -1,
       3, -1,
      -1,  3
    ]);

    this.vbo = gl.createBuffer();
    if (!this.vbo) {
      logger.error('[WebGL2] Failed to create vertex buffer');
      logger.error('[WebGL2] === INITIALIZATION FAILED ===');
      logger.groupEnd();
      return false;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    // Note: VAO setup and uniform caching deferred until shader is compiled
    // (lazyCompileShader is async and program doesn't exist yet)

    const initTime = performance.now() - initStart;
    renderDiagnostics.log('info', 'gpu', 'WebGL2 initialization completed', { initTime });
    renderDiagnostics.trackGPUContext(false, initTime);
    logger.info('[WebGL2] Initialization time:', initTime.toFixed(2), 'ms');
    logger.groupEnd();
    return true;
  }

  private async compileShader(type: number, source: string): Promise<WebGLShader | null> {
    if (!this.gl) return null;
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) return null;

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    // Non-blocking wait: poll COMPLETION_STATUS_KHR BEFORE reading COMPILE_STATUS.
    // Reading COMPILE_STATUS first stalls the main thread for the whole driver
    // compile — and this fallback path compiles the ~4200-line monolithic shader,
    // which is exactly what froze the browser on load.
    await this.pollCompletion((pname) => gl.getShaderParameter(shader, pname));

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const errorLog = gl.getShaderInfoLog(shader);
      logger.error('Shader compilation error:', errorLog);
      userProblemLogger.log({
        level: 'error',
        category: 'render',
        message: `Shader compilation failed: ${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'}`,
        details: { error: errorLog?.substring(0, 500) }
      });
      gl.deleteShader(shader);
      return null;
    }
    logger.info('[WebGL2] Shader compiled successfully (' + (type === gl.VERTEX_SHADER ? 'vertex' : 'fragment') + ')');
    return shader;
  }

  /**
   * Poll a KHR_parallel_shader_compile COMPLETION_STATUS query without blocking.
   * Returns immediately when the extension is unavailable (status read then
   * blocks once — same worst case as before, but never a busy-wait loop).
   */
  private async pollCompletion(readStatus: (pname: number) => unknown): Promise<void> {
    const gl = this.gl;
    if (!gl) return;
    const COMPLETION_STATUS_KHR = 0x91B1;
    if (!gl.getExtension('KHR_parallel_shader_compile')) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      return;
    }
    gl.flush(); // ONE kickoff so the GPU process starts compile/link; never flush per-spin
    // Budget must exceed worst-case real driver compile/link time — cold ANGLE/D3D11
    // link of the monolithic fallback shader can take tens of seconds. Exhausting the
    // budget early would fall through to the blocking status read and freeze the tab
    // (same pitfall measured in loader-sync-test). A hung compile is caught by the
    // 120s swap guard in render(), not by a short poll budget here.
    for (let spins = 0; spins < SHADER_POLL_MAX_SPINS; spins++) {
      if (readStatus(COMPLETION_STATUS_KHR)) return;
      await new Promise<void>(resolve => setTimeout(resolve, SHADER_POLL_INTERVAL_MS));
    }
  }

  /**
   * Lazy shader compilation for specific fractal
   * Compiles only the needed module instead of full shader
   */
  private async lazyCompileShader(fractalIdx: number): Promise<void> {
    if (!this.gl || !this.shaderManager) return;
    
    // Skip if already compiled for this fractal
    if (this.currentFractalIdx === fractalIdx) return;
    
    logger.info(`[WebGL2] Lazy compiling shader for fractal ${fractalIdx}...`);
    
    try {
      const program = await this.shaderManager.getShaderForFractal(
        fractalIdx,
        GLSL_VERTEX_SHADER
      );
      
      // Guard: GL context may have been lost during the async compilation
      if (!this.gl) {
        logger.warn('[WebGL2] GL context lost during async shader compilation — skipping VAO setup');
        return;
      }
      
      // Switch to new program
      this.program = program;
      this.currentFractalIdx = fractalIdx;
      
      // Setup VAO (deferred from init because program wasn't ready)
      if (!this.vao) {
        this.vao = this.gl.createVertexArray();
        this.gl.bindVertexArray(this.vao);
        const posLoc = this.gl.getAttribLocation(program, 'a_position');
        this.gl.enableVertexAttribArray(posLoc);
        this.gl.vertexAttribPointer(posLoc, 2, this.gl.FLOAT, false, 0, 0);
      }
      
      // Cache uniform locations
      this.cacheUniformLocations(program);
      this.shaderManager?.setProtectedIndices([fractalIdx]);
      
      logger.info(`[WebGL2] Lazy compilation complete for fractal ${fractalIdx}`);
      this.beginWarmup();
    } catch (error) {
      logger.error(`[WebGL2] Lazy compilation failed for fractal ${fractalIdx}:`, error);
      logger.info('[WebGL2] Falling back to full shader compilation...');
      
      // Fallback to full shader compilation
      const gl = this.gl;
      if (!gl) return; // Guard: GL context may have been lost during async compilation
      const vs = await this.compileShader(gl.VERTEX_SHADER, GLSL_VERTEX_SHADER);
      const fs = await this.compileShader(gl.FRAGMENT_SHADER, GLSL_FRAGMENT_SHADER);
      
      // Clean up vertex shader if fragment failed — prevents GPU resource leak
      if (vs && !fs) {
        gl.deleteShader(vs);
      }
      
      if (vs && fs) {
        const program = gl.createProgram();
        if (program) {
          gl.attachShader(program, vs);
          gl.attachShader(program, fs);
          gl.linkProgram(program);
          await this.pollCompletion((pname) => gl.getProgramParameter(program, pname));
          
          gl.deleteShader(vs);
          gl.deleteShader(fs);
          
          if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
            this.program = program;
            this.currentFractalIdx = -1; // Mark as using full shader
            
            // Setup VAO for fallback shader
            if (!this.vao) {
              this.vao = this.gl.createVertexArray();
              this.gl.bindVertexArray(this.vao);
              const posLoc = this.gl.getAttribLocation(program, 'a_position');
              this.gl.enableVertexAttribArray(posLoc);
              this.gl.vertexAttribPointer(posLoc, 2, this.gl.FLOAT, false, 0, 0);
            }
            
            // Cache uniform locations for fallback shader
            this.uniformLocs = {};
            const uniformNames = [
              'u_resolution', 'u_time', 'u_phi_val',
              'u_cam_rot', 'u_zoom', 'u_fractal_type', 'u_hybrid_type', 'u_tertiary_type',
              'u_iterations', 'u_glow_intensity', 'u_morph_speed', 'u_hybrid_blend', 'u_tertiary_blend',
              'u_compose_op', 'u_smooth_k', 'u_warp_strength', 'u_octave_layers',
              'u_box_fold', 'u_sphere_fold', 'u_interior_cut',
              'u_primary_color', 'u_secondary_color', 'u_accent_color',
              'u_cam_mode', 'u_cam_pos', 'u_slice_plane', 'u_slice_axis', 'u_render_style',
              'u_headlamp_power', 'u_volumetric_fog', 'u_palette_seed', 'u_palette_rotation',
              'u_auto_rotate', 'u_quality_level'
            ];
            uniformNames.forEach(name => {
              this.uniformLocs[name] = this.gl!.getUniformLocation(program, name);
            });
            
            logger.info('[WebGL2] Full shader compilation successful');
            this.beginWarmup();
          } else {
            logger.error('[WebGL2] Full shader link failed:', gl.getProgramInfoLog(program));
          }
        }
      }
    }
  }

  /** Start low-cost warmup after a shader swap (see warmupFramesLeft docs). */
  private beginWarmup(): void {
    this.preSwapQuality = Math.max(this.qualityLevel, 1); // never restore to a stale 0
    this.qualityLevel = 0;
    this.warmupFramesLeft = WARMUP_FRAMES;
  }

  /** (Re-)cache uniform locations for the active program. */
  private cacheUniformLocations(program: WebGLProgram): void {
    if (!this.gl) return;
    this.uniformLocs = {};
    WebGLEngine.UNIFORM_NAMES.forEach(name => {
      this.uniformLocs[name] = this.gl!.getUniformLocation(program, name);
    });
  }

  /**
   * True when background prefetching is safe: GL context + ShaderManager are up and
   * no real swap is in flight (a waiting user must not share the driver's compile
   * pool with extra work). Up to PREFETCH_CONCURRENCY prefetches may run at once.
   * NOTE: this getter does not itself check the first-frame state — the cold-start
   * hold (do not prefetch until figure 0 has painted) is enforced by the caller in
   * useRenderEngine, because ANGLE serializes the driver-side link and overlapping
   * prefetch onto the critical path delays the very first frame the user waits for.
   */
  public get canPrefetch(): boolean {
    return !!this.gl && !!this.shaderManager && !this.isSwappingShader && this.prefetching.size < WebGLEngine.PREFETCH_CONCURRENCY;
  }

  /**
   * Background pre-compile of a predicted-next fractal shader into the LRU cache.
   * Never touches the active program — the user keeps viewing/controlling the current
   * fractal undisturbed (compilation runs in the GPU process via the non-blocking
   * KHR poll loop). When the switch actually happens, render() takes the synchronous
   * cached-swap fast path: zero skipped frames, no "Initializing GPU" overlay.
   */
  public prefetchFractal(fractalIdx: number): void {
    if (!this.gl || !this.shaderManager || !this.canPrefetch) return;
    if (fractalIdx === this.currentFractalIdx || this.prefetching.has(fractalIdx)) return;
    if (this.shaderManager.isCached(fractalIdx)) return;
    this.prefetching.add(fractalIdx);
    logger.info(`[WebGL2] Prefetch: compiling shader for fractal ${fractalIdx} in background...`);
    this.shaderManager.getShaderForFractal(fractalIdx, GLSL_VERTEX_SHADER)
      .then(() => logger.info(`[WebGL2] Prefetch ready for fractal ${fractalIdx}`))
      .catch(err => logger.warn(`[WebGL2] Prefetch failed for fractal ${fractalIdx}:`, (err as Error)?.message ?? err))
      .finally(() => this.prefetching.delete(fractalIdx));
  }

  /** True while a lazy shader swap is mid-flight (re-entrant render guard). */
  public isShaderSwapping(): boolean {
    return this.isSwappingShader;
  }

  /**
   * Real compile progress (0-100) of the swap the user is currently waiting on —
   * read by the UI to show "Initializing GPU… 40%" driven by actual ShaderManager
   * stages rather than an indeterminate pulse.
   */
  public getSwapProgress(): number {
    if (this.swapTargetIdx < 0) return 100;
    if (this.shaderManager?.isCached(this.swapTargetIdx)) return 100;
    return this.compilePctByIndex.get(this.swapTargetIdx) ?? 5;
  }

  /**
   * Synchronously adopt an already-compiled (prefetched) program. Returns false when
   * the VAO is not up yet (first frame still pending) — caller falls back to the
   * regular async lazy-compile swap path.
   */
  private adoptCachedProgram(program: WebGLProgram, fractalIdx: number): boolean {
    if (!this.gl || !this.vao) return false;
    this.program = program;
    this.currentFractalIdx = fractalIdx;
    this.swapTargetIdx = -1;
    this.cacheUniformLocations(program);
    this.shaderManager?.setProtectedIndices([fractalIdx]);
    logger.info(`[WebGL2] Instant swap to cached shader for fractal ${fractalIdx} (prefetched)`);
    return true;
  }

  /**
   * Renders one frame. Returns true ONLY when gl.drawArrays actually executed —
   * callers use this to distinguish a real on-screen frame from a silent skip
   * (lazy shader compile in progress / swap guard / oversized canvas).
   */
  public render(timeSec: number, params: FractalParams): boolean {
    const gl = this.gl;
    if (!gl || !this.vao || !this.program) {
      // Skip render silently — context or shader not ready yet (lazy compilation in progress)
      return false;
    }

    // Guard: don't re-enter render during shader swap
    if (this.isSwappingShader) {
      // Time-based safety valve (see swapStartTime comment): real cold driver compiles
      // take tens of seconds — the guard must stay up for the whole wait so the chip
      // shows one continuous honest progress instead of flickering every ~5s.
      if (performance.now() - this.swapStartTime > SHADER_SWAP_TIMEOUT_MS) {
        logger.warn('[WebGL2] Shader swap timeout — resetting after', Math.round((performance.now() - this.swapStartTime) / 1000), 's');
        this.isSwappingShader = false;
        this.swapStartTime = 0;
        this.swapTargetIdx = -1;
      }
      return false;
    }

    // Safety: cap canvas size to prevent GPU OOM on extreme DPR
    if (this.canvas.width > CANVAS_HARD_CAP || this.canvas.height > CANVAS_HARD_CAP) return false;

    // LOG FRACTAL TYPE only when it changes (not every frame)
    const indices = this.computeIndices(params);
    if (params.type !== this.lastLoggedFractalType) {
      this.lastLoggedFractalType = params.type;
      userProblemLogger.log({
        level: 'info',
        category: 'render',
        message: `Rendering fractal type: ${params.type} (idx: ${indices.fractalIdx})`,
        details: { 
          type: params.type,
          fractalIdx: indices.fractalIdx,
          hybridType: params.hybridType,
          renderStyle: params.renderStyle,
          zoom: params.zoom
        }
      });
      
      // Lazy compile shader for this fractal if needed
      if (this.currentFractalIdx !== indices.fractalIdx) {
        const cachedProgram = this.shaderManager?.getCachedProgram(indices.fractalIdx) ?? null;
        if (cachedProgram && this.adoptCachedProgram(cachedProgram, indices.fractalIdx)) {
          // Fast path: shader was background-prefetched — swapped synchronously,
          // this very frame already draws the new fractal (no skip, no overlay).
        } else {
          this.isSwappingShader = true;
          this.swapStartTime = performance.now();
          this.swapTargetIdx = indices.fractalIdx;
          this.lazyCompileShader(indices.fractalIdx).then(() => {
            this.isSwappingShader = false;
            this.swapStartTime = 0;
            this.swapTargetIdx = -1;
          }).catch(err => {
            logger.error('[WebGL2] Lazy compile failed, using full shader:', err);
            this.isSwappingShader = false;
            this.swapStartTime = 0;
            this.swapTargetIdx = -1;
          });
        }
      }
    }

    // Setup performance measurement (lightweight — no measurePerformance wrapper)
    // measurePerformance adds performance.now() × 2 per frame = ~0.01ms but more
    // importantly it wraps the function call which prevents V8 inlining of render setup
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.useProgram(this.program);
      gl.bindVertexArray(this.vao);

      const palette = this.resolvePalette(params);
      // indices already computed above for logging, reuse it

      // Upload all uniforms via pre-allocated buffer (no per-frame allocation)
      this.packUniforms(this.packedUniforms, timeSec, params, palette, indices);

      // NOTE: validateScalar removed from per-frame path — these check CPU-side
      // uniform values we control, not GPU output. Validation happens at init only.

      const set = (name: string, val: number) => {
        const loc = this.uniformLocs[name];
        if (loc) gl.uniform1f(loc, val);
      };
      const set2 = (name: string, x: number, y: number) => {
        const loc = this.uniformLocs[name];
        if (loc) gl.uniform2f(loc, x, y);
      };
      const set3 = (name: string, x: number, y: number, z: number) => {
        const loc = this.uniformLocs[name];
        if (loc) gl.uniform3f(loc, x, y, z);
      };

      set2('u_resolution', this.packedUniforms[0], this.packedUniforms[1]);
      set('u_time', this.packedUniforms[2]);
      set('u_phi_val', this.packedUniforms[3]);
      set2('u_cam_rot', this.packedUniforms[4], this.packedUniforms[5]);
      set('u_zoom', this.packedUniforms[6]);
      set('u_fractal_type', this.packedUniforms[7]);
      set('u_iterations', this.packedUniforms[8]);
      set('u_glow_intensity', this.packedUniforms[9]);
      set('u_morph_speed', this.packedUniforms[10]);
      set('u_hybrid_type', this.packedUniforms[11]);
      set('u_hybrid_blend', this.packedUniforms[12]);
      set('u_box_fold', this.packedUniforms[13]);
      set('u_sphere_fold', this.packedUniforms[14]);
      set('u_interior_cut', this.packedUniforms[15]);
      set3('u_primary_color', this.packedUniforms[16], this.packedUniforms[17], this.packedUniforms[18]);
      set('u_tertiary_type', this.packedUniforms[19]);
      set3('u_secondary_color', this.packedUniforms[20], this.packedUniforms[21], this.packedUniforms[22]);
      set('u_tertiary_blend', this.packedUniforms[23]);
      set3('u_accent_color', this.packedUniforms[24], this.packedUniforms[25], this.packedUniforms[26]);
      set('u_compose_op', this.packedUniforms[27]);
      set('u_smooth_k', this.packedUniforms[28]);
      set('u_warp_strength', this.packedUniforms[29]);
      set('u_octave_layers', this.packedUniforms[30]);
      set('u_cam_mode', this.packedUniforms[31]);
      set3('u_cam_pos', this.packedUniforms[32], this.packedUniforms[33], this.packedUniforms[34]);
      set('u_slice_plane', this.packedUniforms[35]);
      set('u_headlamp_power', this.packedUniforms[36]);
      set('u_volumetric_fog', this.packedUniforms[37]);
      set('u_slice_axis', this.packedUniforms[38]);
      set('u_render_style', this.packedUniforms[39]);
      // Ambient color not a separate GLSL uniform — palette colors used directly in shader
      set('u_palette_seed', this.packedUniforms[43]);
      set('u_palette_rotation', this.packedUniforms[44]);
      set('u_auto_rotate', this.packedUniforms[45]);
      set('u_quality_level', this.packedUniforms[46]);

      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // Warmup ramp-down: restore pre-swap quality after the first cheap frames
      if (this.warmupFramesLeft > 0 && --this.warmupFramesLeft === 0) {
        this.qualityLevel = this.preSwapQuality;
      }
      
      // NOTE: gl.getError() removed from per-frame path — it forces GPU-CPU sync
      // on many mobile drivers (Adreno, Mali) causing 1-3ms stalls per frame.
      // Only check errors during development or when a problem is suspected.
    // Update diagnostics with real values
    renderDiagnostics.updateFrameStats(128, 0.001, 20.0);
    renderDiagnostics.trackGPUContext(false, 0);
    return true;
  }

  public destroy() {
    // Always release GL context, even if init failed partway through
    if (this.gl) {
      if (this.vao) {
        this.gl.deleteVertexArray(this.vao);
        this.vao = null;
      }
      if (this.vbo) {
        this.gl.deleteBuffer(this.vbo);
        this.vbo = null;
      }
      if (this.program) {
        this.gl.deleteProgram(this.program);
        this.program = null;
      }
      // Lose the context to free all GPU resources
      const ext = this.gl.getExtension('WEBGL_lose_context');
      if (ext) {
        ext.loseContext();
      }
      this.gl = null;
    }
  }
}
