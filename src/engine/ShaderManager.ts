/**
 * Shader Manager v3 - True minimal shader compilation
 *
 * Parses the monolithic FRAGMENT_SHADER_SOURCE string and generates
 * a minimal shader per fractal that ONLY includes the needed function.
 *
 * Key: sceneSDF calls the fractal function DIRECTLY (not through evalSingleFractal),
 * so the GLSL linker does not need any other map functions.
 *
 * Shader size per fractal: ~900 lines (vs 4171 monolithic)
 */

import { FRAGMENT_SHADER_SOURCE, GLSL_VERTEX_SHADER } from '../shaders/webglShaders';
import { logger } from '../utils/logger';

// Uniform-only motion used by the generic fragment and the Phyllotaxis vertex path.
// A vertex evaluates this once for the fullscreen triangle; flat varyings carry it unchanged.
const SCENE_MOTION = `
  int iters = int(clamp(u_iterations, 6.0, 64.0));
  float t = u_time * u_morph_speed;
  float morphGate = clamp(u_morph_speed, 0.0, 1.0);
  float phiEvo = (sin(t * 0.5) * 0.05 + sin(t * 0.3 + 1.7) * 0.03) * morphGate;
  float phi = u_phi_val + phiEvo;
  iters = clamp(iters + int(2.0 * sin(t * 0.18 + 0.5)), 6, 64);
  float breathPrimary = sin(u_time * 0.8) * 0.5 + 0.5;
  float breathSecondary = sin(u_time * 0.8 * phi + 1.0) * 0.5 + 0.5;
  float breathTertiary = sin(u_time * 0.8 * phi * phi + 2.0) * 0.5 + 0.5;
  float breathAmount = (breathPrimary * 0.5 + breathSecondary * 0.3 + breathTertiary * 0.2) * 0.11 * morphGate;
`;
const SCENE_PRECESSION = `
  float precessAngle = u_time * 0.06 * morphGate;
  float precessY = u_time * 0.037 * morphGate;
  float cp = cos(precessAngle), sp = sin(precessAngle);
  float cq = cos(precessY), sq = sin(precessY);
`;

const PHYLLOTAXIS_DATA = '#define SWYPE_PHYLLOTAXIS_VERTEX_DATA 1';
const PHYLLOTAXIS_VERTEX_SHADER = GLSL_VERTEX_SHADER.replace('void main() {', `
uniform float u_time;
uniform float u_phi_val;
uniform float u_morph_speed;
uniform float u_iterations;
flat out highp vec4 v_sceneMotion;
flat out highp vec4 v_scenePrecession;
flat out highp vec4 v_phiRotation;
flat out highp vec4 v_phiFold;

void main() {
${SCENE_MOTION}${SCENE_PRECESSION}  v_sceneMotion = vec4(t, phi, breathAmount, float(iters));
  v_scenePrecession = vec4(cp, sp, cq, sq);
  const float goldenAngle = 2.399963229728653;
  float planarAngle = goldenAngle + t * 0.04;
  float crossAngle = goldenAngle * 0.618;
  v_phiRotation = vec4(cos(planarAngle), sin(planarAngle), cos(crossAngle), sin(crossAngle));
  v_phiFold = vec4(0.28 * phi, 0.18 * phi, 0.22, phi * 0.94);
`);

export interface CompilationProgress {
  fractalIndex: number;
  fractalName: string;
  stage: 'parsing' | 'compiling' | 'linking' | 'complete';
  progress: number;
}

export type ProgressCallback = (progress: CompilationProgress) => void;

interface CachedShader {
  program: WebGLProgram;
  lastUsed: number;
}

interface ShaderSections {
  header: string;
  footer: string;
  funcNames: string[];
  cachedLines: string[]; // Cache split lines to avoid re-splitting 4000+ line string
  headerEnd: number; // line index where the first map* function begins (header = [0, headerEnd))
  sceneSDFStart: number; // line index where vec2 sceneSDF( begins (body helpers live in [headerEnd, sceneSDFStart))
}

export class ShaderManager {
  private gl: WebGL2RenderingContext;
  private compiledShaders: Map<number, CachedShader> = new Map();
  private maxCacheSize = 8; // Increased from 5 to reduce recompilation during auto-explore
  // In-flight compiles keyed by fractal index: a background prefetch and a user
  // switch to the SAME fractal must share one compile — otherwise both splice the
  // shader and the second cacheShader() overwrite leaks the first WebGLProgram.
  private inFlight: Map<number, Promise<WebGLProgram>> = new Map();
  // Indices whose programs the engine is actively displaying — eviction must never
  // deleteProgram() these (a deleted bound program = GL error / black canvas).
  private protectedIndices: Set<number> = new Set();
  private onProgress?: ProgressCallback;
  private sections: ShaderSections | null = null;
  // name -> full source for every function defined in the body region [headerEnd, sceneSDFStart).
  // Used to pull in helper functions (project4Dto3D, mapJuliaBase, mapIFSBase, mapHybridBase,
  // mapHybridVariant, ...) that a fractal's map function references but which do NOT live in the
  // header. Without this the spliced minimal shader compiles to "no matching overloaded function".
  private funcIndex: Map<string, string> | null = null;
  // catalog ordinal (u_fractal_type) -> concrete map function NAME, parsed from the
  // monolithic evalSingleFractal dispatch table (`if (ftype == N) return vec2(mapName(`).
  // This is the SAME source of truth the full shader uses at runtime, so the minimal-splice
  // path resolves the identical function the monolith would — unlike counting map* defs by
  // source position, which drifts once the ${*VARIATIONS} modules are interpolated before the
  // later base types (catalog >=107), silently splicing the wrong fractal.
  private ordinalNameMap: Map<number, string> | null = null;
  // KHR_parallel_shader_compile lets us POLL compile/link completion instead of
  // blocking the main thread on COMPILE_STATUS. Without it, getShaderParameter()
  // stalls the whole browser (frozen loader animation, dead input) during the
  // ~0.5-2s driver compile of a 900-line raymarching shader.
  private static readonly COMPLETION_STATUS_KHR = 0x91B1;
  private parallelCompile = false;

  constructor(gl: WebGL2RenderingContext, onProgress?: ProgressCallback) {
    this.gl = gl;
    this.onProgress = onProgress;
    this.parallelCompile = !!gl.getExtension('KHR_parallel_shader_compile');
    if (!this.parallelCompile) {
      logger.warn('[ShaderManager] KHR_parallel_shader_compile unavailable — compile checks will block once per shader');
    }
  }

  /**
   * Yield-friendly wait until the GPU driver reports compile/link done.
   * Polls COMPLETION_STATUS_KHR with setTimeout so the main thread keeps running
   * (rAF alive, input processed, loading spinner animating) instead of blocking.
   * A single gl.flush() at each call site kicks driver-side work; we must NOT
   * flush per-spin (flush() is a synchronous GPU-process IPC round-trip).
   *
   * The budget must EXCEED the worst real compile/link time (ANGLE/D3D11 defers
   * the expensive driver compile to LINK time — tens of seconds for the first
   * cold shaders on real hardware, and longer while the pool runs concurrent
   * prefetches). If we gave up early we'd fall through to the synchronous
   * COMPILE_STATUS/LINK_STATUS read, which is exactly what froze the browser —
   * loader-sync-test measured a 3.4s main-thread stall that was this fall-through.
   * 16000 spins ≈ 2.5-5 minutes of yielding polls: a hung compile is surfaced by
   * the engine's 120s swap guard, not by a frozen tab.
   */
  private async waitUntilCompiled(poll: () => boolean, label: string, onTick?: (elapsedMs: number) => void): Promise<void> {
    if (!this.parallelCompile) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      return;
    }
    const budget = 16000; // 'link' and 'frag' alike — both can outlive a small budget
    void label;
    const start = performance.now();
    for (let spins = 0; spins < budget; spins++) {
      if (poll()) return;
      // Fire ~every 100ms so a long driver link can creep the progress bar/chip
      // instead of freezing on the last discrete stage mark (the "stops mid-way" bug).
      if (onTick && spins % 20 === 19) onTick(performance.now() - start);
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
  }

  private parseSections(): ShaderSections {
    if (this.sections) return this.sections;
    // Split the monolithic shader ONCE and cache the result
    const allLines = FRAGMENT_SHADER_SOURCE.split('\n');
    let headerEnd = -1;
    let sceneSDFStart = -1;
    let sceneSDFEnd = -1;
    const funcNames: string[] = [];
    for (let i = 0; i < allLines.length; i++) {
      const trimmed = allLines[i].trim();
      if (headerEnd === -1 && (trimmed.startsWith('vec2 map') || trimmed.startsWith('float map'))) {
        headerEnd = i;
      }
      const funcMatch = trimmed.match(/^(?:vec2|float)\s+(map\w+)\(/);
      if (funcMatch) funcNames.push(funcMatch[1]);
      if (trimmed.startsWith('vec2 sceneSDF(')) sceneSDFStart = i;
      if (sceneSDFStart >= 0 && sceneSDFEnd === -1 && trimmed === '}') {
        for (let j = i + 1; j < Math.min(i + 5, allLines.length); j++) {
          const next = allLines[j].trim();
          if (next === '') continue;
          if (next.startsWith('vec3 calcNormal') || next.startsWith('void main')) {
            sceneSDFEnd = i;
          }
          break;
        }
      }
    }
    const header = allLines.slice(0, headerEnd).join('\n');
    const footer = allLines.slice(sceneSDFEnd + 1).join('\n');
    this.sections = { header, footer, funcNames, cachedLines: allLines, headerEnd, sceneSDFStart };
    logger.info('[ShaderManager] Parsed:', funcNames.length, 'functions, header=' + headerEnd + ' lines, footer=' + (allLines.length - sceneSDFEnd - 1) + ' lines');
    return this.sections;
  }

  private buildOrdinalNameMap(): Map<number, string> {
    if (this.ordinalNameMap) return this.ordinalNameMap;
    const map = new Map<number, string>();
    const re = /if\s*\(ftype\s*==\s*(\d+)\)\s*return\s+(?:vec2\(\s*)?(map\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(FRAGMENT_SHADER_SOURCE)) !== null) {
      map.set(parseInt(m[1], 10), m[2]);
    }
    this.ordinalNameMap = map;
    logger.info('[ShaderManager] Parsed dispatch table: ' + map.size + ' ordinal->function name(s)');
    return map;
  }

  private extractFractalFunction(fractalIndex: number): { code: string; name: string; returnType: string; takesIters: boolean } {
    // Reuse cached lines from parseSections instead of re-splitting the 4000+ line string
    const sections = this.parseSections();
    const lines = sections.cachedLines;
    // Resolve the catalog ordinal to its concrete function name via the monolith's own
    // dispatch table, then extract THAT function by name. Ordinals the dispatch handles via
    // compressed parameterized ranges (>=141) have no single name -> return empty so the
    // caller falls back to the full monolithic shader (which dispatches them correctly).
    const targetName = this.buildOrdinalNameMap().get(fractalIndex);
    if (!targetName) return { code: '', name: 'mapPhyllotaxis', returnType: 'vec2', takesIters: true };
    const defRe = new RegExp('^(?:vec2|float)\\s+' + targetName + '\\s*\\(');
    let funcStart = -1;
    for (let i = 0; i < lines.length; i++) {
      if (defRe.test(lines[i].trim())) { funcStart = i; break; }
    }
    if (funcStart === -1) return { code: '', name: 'mapPhyllotaxis', returnType: 'vec2', takesIters: true };
    const sigMatch = lines[funcStart].trim().match(/^(vec2|float)\s+(map\w+)\(/);
    const returnType = sigMatch ? sigMatch[1] : 'vec2';
    const funcName = sigMatch ? sigMatch[2] : targetName;
    // Detect if function takes 'iters' parameter (some functions like mapSpiralTunnel, mapGyroid don't)
    const takesIters = /int\s+iters/.test(lines[funcStart]);
    let braceCount = 0;
    let funcEnd = funcStart;
    for (let i = funcStart; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === '{') braceCount++;
        if (ch === '}') braceCount--;
      }
      if (braceCount === 0 && i > funcStart) { funcEnd = i; break; }
    }
    return { code: lines.slice(funcStart, funcEnd + 1).join('\n'), name: funcName, returnType, takesIters };
  }

  private generateMinimalSceneSDF(funcName: string, returnType: string, takesIters: boolean, preparedMotion: boolean): string {
    const callArgs = takesIters
      ? funcName + '(p_eval, t, phi, iters)'
      : funcName + '(p_eval, t, phi)';
    const returnExpr = returnType === 'float'
      ? 'vec2(' + callArgs + ', 0.0)'
      : callArgs;
    const motion = preparedMotion
      ? '  float t = v_sceneMotion.x;\n  float phi = v_sceneMotion.y;\n' +
        '  float breathAmount = v_sceneMotion.z;\n  int iters = int(v_sceneMotion.w);\n'
      : SCENE_MOTION;
    const precession = preparedMotion
      ? '  float cp = v_scenePrecession.x, sp = v_scenePrecession.y;\n' +
        '  float cq = v_scenePrecession.z, sq = v_scenePrecession.w;\n'
      : SCENE_PRECESSION;
    return 'vec2 sceneSDF(vec3 p_world) {\n' +
      '  vec3 p_eval = p_world;\n' +
      '  float inv_scale = 1.0;\n' +
      '  if (u_cam_mode > 2.5 && u_cam_mode < 3.5) {\n' +
      '    float R = u_phi_val;\n' +
      '    float r2 = dot(p_eval, p_eval);\n' +
      '    if (r2 > 0.0001) { inv_scale = (R * R) / r2; p_eval = p_eval * inv_scale; }\n' +
      '  }\n' +
      '  float r_bound = length(p_eval);\n' +
      '  if (r_bound > 5.0) return vec2((r_bound - 2.8) / max(inv_scale, 0.0001), r_bound);\n' +
      motion +
      '  float breathWeight = 1.0 - exp(-r_bound * 0.8);\n' +
      '  p_eval *= 1.0 + breathAmount * breathWeight;\n' +
      precession +
      '  p_eval = vec3(p_eval.x * cp + p_eval.z * sp, p_eval.y * cq - p_eval.x * sq * 0.3, -p_eval.x * sp + p_eval.z * cp);\n' +
      '  vec2 resA = ' + returnExpr + ';\n' +
      '  float current_d = resA.x;\n' +
      '  float current_trap = resA.y;\n' +
      '  if (u_interior_cut > 0.05) {\n' +
      '    float shellThick = 0.015 + u_interior_cut * 0.04;\n' +
      '    float shellD = abs(current_d) - shellThick;\n' +
      '    current_d = mix(current_d, shellD, clamp(u_interior_cut * 1.4, 0.0, 0.9));\n' +
      '  }\n' +
      '  if (u_slice_plane > 0.01) {\n' +
      '    float sliceOffset = (0.5 - u_slice_plane) * 3.5;\n' +
      '    vec3 planeNorm = normalize(vec3(0.0, 0.85065, 0.52573));\n' +
      '    if (u_slice_axis > 0.5 && u_slice_axis < 1.5) planeNorm = vec3(1.0, 0.0, 0.0);\n' +
      '    else if (u_slice_axis > 1.5 && u_slice_axis < 2.5) planeNorm = vec3(0.0, 1.0, 0.0);\n' +
      '    else if (u_slice_axis > 2.5) planeNorm = vec3(0.0, 0.0, 1.0);\n' +
      '    float planeDist = dot(p_eval, planeNorm) - sliceOffset;\n' +
      '    current_d = max(current_d, planeDist);\n' +
      '  }\n' +
      '  if (u_cam_mode > 2.5 && u_cam_mode < 3.5) current_d = current_d / max(inv_scale, 0.0001);\n' +
      '  return vec2(current_d, current_trap);\n' +
      '}';
  }

  private buildMinimalFragmentShader(fractalIndex: number, preparedMotion = false): string {
    const sections = this.parseSections();
    const fractal = this.extractFractalFunction(fractalIndex);
    if (!fractal.code) {
      logger.warn('[ShaderManager] Could not extract fractal ' + fractalIndex + ', using full shader');
      return FRAGMENT_SHADER_SOURCE;
    }
    // The engine feeds the catalog ordinal (0-430) in as the Nth-map-function index, but the
    // monolithic shader only has ~151 map* functions plus shared *Base/*Variant dispatch helpers
    // interleaved. When the ordinal resolves to one of those helpers (rather than a self-contained
    // per-type function), the minimal splice cannot represent it (call signatures don't match).
    // Return the full monolithic shader directly — it selects the correct fractal at runtime via
    // evalSingleFractal(u_fractal_type), so the fractal renders right without a doomed compile.
    // Deliberate deferral of full ordinal alignment: a catalog->(fn,args) map would let these
    // ~11 variant families use the fast minimal splice, but it adds a second source of truth that
    // must track fractalMappers.ts / evalSingleFractal (drift reintroduces compile errors, and
    // guarding needs full 431 sweeps). The payoff is a one-time lazy-compile saving already
    // covered by the LRU cache (8) + KHR_parallel non-blocking poll + post-swap warmup, so it is
    // not user-perceptible. Revisit only if minimal-shader compile time becomes a measured issue.
    if (/(?:Base|Variant)$/.test(fractal.name)) {
      return FRAGMENT_SHADER_SOURCE;
    }
    // Pull in any body-region helper functions the fractal's map function transitively calls
    // (e.g. project4Dto3D for 4D polytopes, mapJuliaBase/mapIFSBase/mapHybridBase for variants).
    // These are not part of the header, so without this the spliced shader fails to compile.
    const helpers = this.resolveHelperSources(fractal.name, fractal.code);
    const helperBlock = helpers.length ? helpers.join('\n') + '\n' : '';
    const minimalSceneSDF = this.generateMinimalSceneSDF(fractal.name, fractal.returnType, fractal.takesIters, preparedMotion);
    const header = preparedMotion
      ? sections.header.replace('#version 300 es', '#version 300 es\n' + PHYLLOTAXIS_DATA)
      : sections.header;
    const assembled = header + '\n' + helperBlock + fractal.code + '\n\n' + minimalSceneSDF + '\n' + sections.footer;
    if (helpers.length) {
      logger.info('[ShaderManager] Fractal ' + fractalIndex + ' (' + fractal.name + '): included ' + helpers.length + ' helper function(s)');
    }
    logger.info('[ShaderManager] Built minimal shader for fractal ' + fractalIndex + ' (' + fractal.name + '): ' + assembled.split('\n').length + ' lines (vs ' + sections.cachedLines.length + ' full)');
    return assembled;
  }

  /**
   * Index every function defined in the body region [headerEnd, sceneSDFStart) by name.
   * This includes the map* entry points and the shared helper/base functions they call.
   * GLSL builtins (sin, mix, length, ...) are NOT included, so they are never pulled in.
   */
  private buildFuncIndex(): Map<string, string> {
    if (this.funcIndex) return this.funcIndex;
    const sections = this.parseSections();
    const lines = sections.cachedLines;
    const index = new Map<string, string>();
    const defRe = /^\s*(?:vec2|vec3|vec4|ivec2|ivec3|mat2|mat3|mat4|float|int|bool|void)\s+(\w+)\s*\(/;
    for (let i = sections.headerEnd; i < sections.sceneSDFStart; i++) {
      const m = lines[i].match(defRe);
      if (!m) continue;
      const name = m[1];
      if (index.has(name)) continue; // keep first definition (no true overloads in this shader)
      // Brace-match the full function body, same strategy as extractFractalFunction.
      let braceCount = 0;
      let started = false;
      let end = i;
      for (let j = i; j < sections.sceneSDFStart; j++) {
        for (const ch of lines[j]) {
          if (ch === '{') { braceCount++; started = true; }
          if (ch === '}') braceCount--;
        }
        if (started && braceCount === 0) { end = j; break; }
      }
      index.set(name, lines.slice(i, end + 1).join('\n'));
    }
    this.funcIndex = index;
    return index;
  }

  /** Identifier names that appear call-like (`foo(`) in a GLSL source fragment. */
  private calledNames(src: string): Set<string> {
    const out = new Set<string>();
    const re = /\b([A-Za-z_]\w*)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) out.add(m[1]);
    return out;
  }

  /**
   * Transitive closure of helper functions referenced by `entryCode`, ordered so that
   * callees appear before callers (post-order DFS). `entryName` itself is excluded because
   * its source is appended separately by buildMinimalFragmentShader.
   */
  private resolveHelperSources(entryName: string, entryCode: string): string[] {
    const index = this.buildFuncIndex();
    const ordered: string[] = [];
    const visited = new Set<string>([entryName]);
    const visit = (name: string) => {
      if (visited.has(name)) return;
      const code = index.get(name);
      if (!code) return;
      visited.add(name);
      for (const dep of this.calledNames(code)) visit(dep);
      ordered.push(code);
    };
    for (const dep of this.calledNames(entryCode)) visit(dep);
    return ordered;
  }


  async getShaderForFractal(fractalIndex: number, vertexShaderSource: string): Promise<WebGLProgram> {
    const cached = this.compiledShaders.get(fractalIndex);
    if (cached) { cached.lastUsed = Date.now(); return cached.program; }

    // Dedupe: reuse an identical compile already in progress for this index
    const pending = this.inFlight.get(fractalIndex);
    if (pending) return pending;

    const work = this.compileForFractal(fractalIndex, vertexShaderSource)
      .finally(() => this.inFlight.delete(fractalIndex));
    this.inFlight.set(fractalIndex, work);
    return work;
  }

  private shaderSources(fractalIndex: number, vertex: string) {
    const preparedMotion = fractalIndex === 0 && vertex === GLSL_VERTEX_SHADER;
    const fragment = this.buildMinimalFragmentShader(fractalIndex, preparedMotion);
    return { vertex: fragment.includes(PHYLLOTAXIS_DATA) ? PHYLLOTAXIS_VERTEX_SHADER : vertex, fragment };
  }

  private async compileForFractal(fractalIndex: number, vertexShaderSource: string): Promise<WebGLProgram> {
    // Yield to browser BEFORE heavy parsing — prevents main thread freeze on launch
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    // Guard: GL context may have been lost during the yield
    if (!this.gl) {
      throw new Error('GL context lost during async yield');
    }

    this.reportProgress(fractalIndex, 'parsing', 10);
    const { vertex, fragment } = this.shaderSources(fractalIndex, vertexShaderSource);

    // Yield to browser BETWEEN parsing and compilation — lets UI events through
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    // Guard: GL context may have been lost during the yield (engine destroyed, context reset)
    if (!this.gl) {
      throw new Error('GL context lost during async yield');
    }

    this.reportProgress(fractalIndex, 'compiling', 40);
    let program: WebGLProgram;
    try {
      program = await this.compileShaderProgram(vertex, fragment, fractalIndex);
    } catch (error) {
      if (vertex === vertexShaderSource || this.gl.isContextLost()) throw error;
      logger.warn('[ShaderManager] Prepared vertex data unavailable; retrying the generic Phyllotaxis shader', error);
      program = await this.compileShaderProgram(vertexShaderSource, this.buildMinimalFragmentShader(fractalIndex), fractalIndex);
    }
    this.reportProgress(fractalIndex, 'linking', 96); // ≥ the link-creep ceiling (94) so the swap chip stays monotonic
    this.cacheShader(fractalIndex, program);
    this.reportProgress(fractalIndex, 'complete', 100);
    return program;
  }

  private async compileShaderProgram(vertexSource: string, fragmentSource: string, fractalIndex: number): Promise<WebGLProgram> {
    const vertexShader = await this.compileShaderStage(this.gl.VERTEX_SHADER, vertexSource);
    this.reportProgress(fractalIndex, 'compiling', 50); // vertex done, fragment (the heavy one) next
    let fragmentShader: WebGLShader;
    try {
      fragmentShader = await this.compileShaderStage(this.gl.FRAGMENT_SHADER, fragmentSource);
    } catch (e) {
      // Clean up vertex shader if fragment compilation fails — prevents GPU resource leak
      this.gl.deleteShader(vertexShader);
      throw e;
    }
    this.reportProgress(fractalIndex, 'linking', 65); // ANGLE/D3D11 defers the real driver
    // compile to link time — this is the longest wait, so surface a distinct mark for it
    // instead of a flat plateau between 40% and 80%.
    const program = this.gl.createProgram()!;
    this.gl.attachShader(program, vertexShader);
    this.gl.attachShader(program, fragmentShader);
    this.gl.linkProgram(program);
    this.gl.flush(); // same kickoff rationale as compileShader above
    // Non-blocking wait for link completion (same rationale as compile polling).
    // The link is the dominant cost of a cold start, so creep the reported progress from
    // 66 toward 94 on an asymptote over the wait instead of freezing at 65 until it snaps
    // to 80 — that freeze was the visible "progress bar stops in the middle" symptom. The
    // value is time-based (link duration is unknown), but it always advances and nears the
    // finish, which is honest for an indeterminate driver-side compile. useRenderEngine
    // clamps with Math.max, so this can never rewind the bar.
    let lastLinkPct = 65;
    await this.waitUntilCompiled(
      () => !!this.gl.getProgramParameter(program, ShaderManager.COMPLETION_STATUS_KHR),
      'link',
      (elapsedMs) => {
        const p = Math.min(94, Math.round(66 + 28 * (1 - Math.exp(-elapsedMs / 7000))));
        if (p !== lastLinkPct) { lastLinkPct = p; this.reportProgress(fractalIndex, 'linking', p); }
      });
    // Always delete shader objects after linking (they're attached to the program now)
    this.gl.deleteShader(vertexShader);
    this.gl.deleteShader(fragmentShader);
    if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
      const error = this.gl.getProgramInfoLog(program);
      this.gl.deleteProgram(program);
      throw new Error('Shader link error: ' + error);
    }
    return program;
  }

  private async compileShaderStage(type: number, source: string): Promise<WebGLShader> {
    const shader = this.gl.createShader(type)!;
    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);
    // Kick the compile command to the GPU process immediately so parallel
    // compilation starts while the main thread is still free.
    this.gl.flush();
    // Poll completion status BEFORE reading COMPILE_STATUS — reading COMPILE_STATUS
    // first would block the main thread until the driver finishes compiling.
    await this.waitUntilCompiled(() =>
      !!this.gl.getShaderParameter(shader, ShaderManager.COMPLETION_STATUS_KHR), this.gl.VERTEX_SHADER === type ? 'vert' : 'frag');
    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      const error = this.gl.getShaderInfoLog(shader);
      this.gl.deleteShader(shader);
      throw new Error('Shader compile error: ' + error);
    }
    return shader;
  }

  /** True when a compiled program for this fractal is already in the LRU cache. */
  isCached(fractalIndex: number): boolean {
    return this.compiledShaders.has(fractalIndex);
  }

  /** Synchronous cache hit for the fast program-swap path (null when absent). */
  getCachedProgram(fractalIndex: number): WebGLProgram | null {
    const cached = this.compiledShaders.get(fractalIndex);
    if (cached) { cached.lastUsed = Date.now(); return cached.program; }
    return null;
  }

  /** Programs the engine is displaying right now — LRU eviction must skip these. */
  setProtectedIndices(indices: number[]): void {
    this.protectedIndices = new Set(indices);
  }

  private cacheShader(fractalIndex: number, program: WebGLProgram): void {
    if (this.compiledShaders.size >= this.maxCacheSize) {
      let oldestKey = -1;
      let oldestTime = Infinity;
      for (const [key, cached] of this.compiledShaders) {
        if (this.protectedIndices.has(key)) continue; // never delete an in-use program
        if (cached.lastUsed < oldestTime) { oldestTime = cached.lastUsed; oldestKey = key; }
      }
      if (oldestKey >= 0) {
        this.gl.deleteProgram(this.compiledShaders.get(oldestKey)!.program);
        this.compiledShaders.delete(oldestKey);
      }
      // All entries protected: allow a temporary overflow rather than killing a live program.
    }
    this.compiledShaders.set(fractalIndex, { program, lastUsed: Date.now() });
  }

  private reportProgress(fractalIndex: number, stage: CompilationProgress['stage'], progress: number): void {
    if (this.onProgress) {
      this.onProgress({ fractalIndex, fractalName: 'Fractal ' + fractalIndex, stage, progress });
    }
  }

  clearCache(exceptFractalIndex?: number): void {
    for (const [key, cached] of this.compiledShaders) {
      if (key !== exceptFractalIndex) {
        this.gl.deleteProgram(cached.program);
        this.compiledShaders.delete(key);
      }
    }
  }

  getCacheStats(): { size: number; maxSize: number; indices: number[] } {
    return { size: this.compiledShaders.size, maxSize: this.maxCacheSize, indices: Array.from(this.compiledShaders.keys()) };
  }
}
