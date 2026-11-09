import { FractalParams, ColorPalette } from '../types/fractal';
import { COLOR_PALETTES } from '../palettes';
import {
  getFractalIndex,
  getCompositeOpIndex,
  getCameraModeIndex,
  getSliceAxisIndex,
  getRenderStyleIndex,
} from './fractalMappers';

// Pre-built palette lookup map — O(1) instead of Array.find() O(n) per frame
const paletteMap = new Map<string, ColorPalette>();
for (const p of COLOR_PALETTES) {
  paletteMap.set(p.id, p);
}

/**
 * Per-fractal camera adjustments for optimal 3D visualization.
 * zoomScale: multiplier for camera distance (default 1.0)
 * tiltOffset: additional pitch rotation in radians (default 0.0)
 *
 * Fixes:
 * - Black screens: fractals too small/large for default camera distance
 * - Flat objects: camera looking straight at flat surface
 * - Tiny objects: camera too far from small fractals
 */
// Per-fractal camera framing, validated against REAL rendered screenshots
// (tests/results/visual-step). cam_dist = params.zoom(3.2) × zoomScale.
// Rule: camera must show the ENTIRE object — never inside (black/overexposed
// blob), never so far the object is a speck. spiralTunnel intentionally keeps
// the camera inside (it is a tunnel).
const FRACTAL_CAM_ADJUST: { zoomScale: number; tiltOffset: number }[] = [
  /*  0 phyllotaxis       */ { zoomScale: 1.0,  tiltOffset: 0.0  },
  /*  1 mandelbulb        */ { zoomScale: 1.0,  tiltOffset: 0.0  },
  /*  2 quaternionJulia   */ { zoomScale: 1.0,  tiltOffset: 0.0  },
  /*  3 apollonian        */ { zoomScale: 1.0,  tiltOffset: 0.0  },
  /*  4 spiralTunnel      */ { zoomScale: 0.8,  tiltOffset: 0.0  }, // inside-by-design
  /*  5 mandelbox         */ { zoomScale: 1.6,  tiltOffset: 0.0  }, // 1.2 → overexposed surface filled frame
  /*  6 icosahedral       */ { zoomScale: 1.0,  tiltOffset: 0.0  }, // 0.5/0.3 → black (camera inside)
  /*  7 menger            */ { zoomScale: 1.0,  tiltOffset: 0.0  },
  /*  8 gyroid            */ { zoomScale: 1.0,  tiltOffset: 0.0  },
  /*  9 primeSpiral       */ { zoomScale: 1.0,  tiltOffset: 0.0  },
  /* 10 quasicrystal      */ { zoomScale: 1.0,  tiltOffset: 0.0  },
  /* 11 hopfFibration     */ { zoomScale: 1.0,  tiltOffset: 0.0  },
  /* 12 calabiYau         */ { zoomScale: 1.0,  tiltOffset: 0.0  },
  /* 13 riemannZeta       */ { zoomScale: 1.0,  tiltOffset: 0.0  },
  /* 14 sierpinskiOcta    */ { zoomScale: 1.5,  tiltOffset: 0.4  },
  /* 15 cliffordKlein     */ { zoomScale: 1.0,  tiltOffset: 0.0  },
  /* 16 poincareSphere    */ { zoomScale: 1.0,  tiltOffset: 0.0  },
  /* 17 gaussianPrimes    */ { zoomScale: 1.0,  tiltOffset: 0.0  },
  /* 18 neoviusMinimal    */ { zoomScale: 1.0,  tiltOffset: 0.0  },
  /* 19 eulerTotientSpiral*/ { zoomScale: 1.0,  tiltOffset: 0.0  },
  /* 20 cliffordTorus4D   */ { zoomScale: 1.0,  tiltOffset: 0.0  },
  /* 21 kleinianLimit     */ { zoomScale: 2.2,  tiltOffset: 0.0  }, // 1.5 → camera too close, surface filled frame
  /* 22 fibonacciSnowflake*/ { zoomScale: 1.2,  tiltOffset: 0.2  },
  /* 23 quaternionMandelbrot*/ { zoomScale: 1.0, tiltOffset: 0.0 },
  /* 24 hilbertCurve3D    */ { zoomScale: 1.5,  tiltOffset: 0.35 },
  /* 25 dragonCurveIFS    */ { zoomScale: 0.5,  tiltOffset: 0.0  }, // 1.0 → fully black; small IFS needs close camera
  /* 26 pythagorasTree3D  */ { zoomScale: 0.7,  tiltOffset: 0.0  }, // object renders small; closer camera
  /* 27 burningShip3D     */ { zoomScale: 1.0,  tiltOffset: 0.0  }, // 1.5 → object tiny speck
  /* 28 newtonBasins      */ { zoomScale: 1.0,  tiltOffset: 0.0  }, // basin slab now spans ~r2.4 — fits at 3.2
  /* 29 jerusalemCube     */ { zoomScale: 1.0,  tiltOffset: 0.0  },
  /* 30 lorenzAttractor   */ { zoomScale: 1.0,  tiltOffset: 0.0  }, // tube thickened in shader; 2.0 made it vanish
  /* 31 hofstadterButterfly*/ { zoomScale: 1.0, tiltOffset: 0.0  },
  /* 32 antoineNecklace   */ { zoomScale: 1.0,  tiltOffset: 0.0  }, // yaw is a no-op on this ring-symmetric object
  /* 33 dlaCluster        */ { zoomScale: 0.5,  tiltOffset: 0.0  }, // small cluster (r≈0.5) — close camera
  /* 34 rosslerHyperchaos */ { zoomScale: 1.0,  tiltOffset: 0.0  },
  /* 35 cliffordAttractor */ { zoomScale: 0.7,  tiltOffset: 0.0  }, // 1.0 → 3.2% fill borderline
  /* 36 abrikosovLattice  */ { zoomScale: 1.0,  tiltOffset: 0.0  },
  /* 37 beltramiPseudosphere*/ { zoomScale: 1.0, tiltOffset: 0.0 },
  /* 38 spinFoamNetwork   */ { zoomScale: 1.0,  tiltOffset: 0.0  },
  /* 39 ramanujanTau      */ { zoomScale: 1.0,  tiltOffset: 0.0  },
  /* 40 belousovWaves     */ { zoomScale: 1.0,  tiltOffset: 0.0  },
  /* 41 henonAttractor    */ { zoomScale: 0.5,  tiltOffset: 0.0  }, // attractor spans only ~±0.6 — needs close camera
];

// Per-fractal framing overrides for types at index >= 42 that fall outside the base
// table above and therefore defaulted to zoomScale 1.0 (camera at ~3.2), rendering thin
// attractors/curves and high-power variant shells as sub-1% specks. Values verified via
// tests/visual-snapshot-sweep.ts (canvas non-black fill ratio). Keyed by fractal index.
const FRACTAL_CAM_ADJUST_OVERRIDES: Record<number, { zoomScale: number; tiltOffset: number }> = {
  48:  { zoomScale: 0.4,  tiltOffset: 0.0 }, // gosperCurve — flat curve (0.25+tilt pushed camera inside → retries errored)
  49:  { zoomScale: 0.4,  tiltOffset: 0.0 }, // lSystemPlant — sparse branching
  53:  { zoomScale: 0.4,  tiltOffset: 0.0 }, // barnsleyFern3D — thin fern
  63:  { zoomScale: 0.35, tiltOffset: 0.0 }, // chuaCircuit — thin attractor ribbon
  65:  { zoomScale: 0.35, tiltOffset: 0.0 }, // ikedaMap — thin attractor
  72:  { zoomScale: 0.22, tiltOffset: 0.0 }, // fitzHugh — flat 2D neural attractor; face-on + close
  73:  { zoomScale: 0.3,  tiltOffset: 0.0 }, // rosslerAttractor — small ribbon (verified speck at 1.0)
  79:  { zoomScale: 0.25, tiltOffset: 0.4 }, // vicsekFractal — flat diffusion cluster
  82:  { zoomScale: 0.25, tiltOffset: 0.5 }, // popcornFunction — flat 2D attractor
  83:  { zoomScale: 0.25, tiltOffset: 0.5 }, // bedheadAttractor — flat 2D attractor
  84:  { zoomScale: 0.35, tiltOffset: 0.0 }, // fourSpotAttractor — thin attractor
  102: { zoomScale: 0.5,  tiltOffset: 0.0 }, // mandelbulbMandelboxHybrid — FIXED at source (DE rewrite); 0.5 frames the rebuilt object
  // 112 torusKnot4D: angle-projection DE is degenerate (black) — zoom-out (1.6),
  // tube-thickness and projected->world DE scale-up were all re-probed and stayed
  // 0.0%; needs a proper torus-knot SDF, not framing. See VISUAL_CONTROL_REPORT.
  // 117 flameButterfly: stale 0.5 zoom was tuned for the old (black) formula;
  // now delegates to mapFlameBase op2 like flameVariant3, which frames at 1.0.
  120: { zoomScale: 0.5,  tiltOffset: 0.0 }, // flameHyperbolic
  127: { zoomScale: 0.4,  tiltOffset: 0.0 }, // ifs3DFern — orbit-traced fern (fixed at source); small attractor, frame like barnsleyFern3D(53)
  333: { zoomScale: 0.6,  tiltOffset: 0.0 }, // flameVariant43 — thin flame on mapFlameBase; frame closer than default 1.0
  // Weak flame variants (same mapFlameBase, large param / op=4 discs) render thin at
  // default 1.0 (<1.2%). Framed closer to 0.45 — sweep-verified: 8/9 sparse->rendered
  // (2.7-5.7%), none over-zoomed to inside-black. flameVariant43(333) framed 0.6.
  293: { zoomScale: 0.45, tiltOffset: 0.0 }, // flameVariant3
  295: { zoomScale: 0.45, tiltOffset: 0.0 }, // flameVariant5
  303: { zoomScale: 0.45, tiltOffset: 0.0 }, // flameVariant13
  305: { zoomScale: 0.45, tiltOffset: 0.0 }, // flameVariant15
  313: { zoomScale: 0.45, tiltOffset: 0.0 }, // flameVariant23
  315: { zoomScale: 0.45, tiltOffset: 0.0 }, // flameVariant25
  323: { zoomScale: 0.45, tiltOffset: 0.0 }, // flameVariant33
  325: { zoomScale: 0.45, tiltOffset: 0.0 }, // flameVariant35
  335: { zoomScale: 0.45, tiltOffset: 0.0 }, // flameVariant45
  // Weak L-system variants (mapLSystemVariant, thin branching) framed 1.0->0.6
  // (conservative: structures extend upward from a base, big zoom-in can clip).
  242: { zoomScale: 0.6, tiltOffset: 0.0 }, // lsystemVariant2
  244: { zoomScale: 0.6, tiltOffset: 0.0 }, // lsystemVariant4
  252: { zoomScale: 0.6, tiltOffset: 0.0 }, // lsystemVariant12
  254: { zoomScale: 0.6, tiltOffset: 0.0 }, // lsystemVariant14
  262: { zoomScale: 0.6, tiltOffset: 0.0 }, // lsystemVariant22
  264: { zoomScale: 0.6, tiltOffset: 0.0 }, // lsystemVariant24
  274: { zoomScale: 0.6, tiltOffset: 0.0 }, // lsystemVariant34
  282: { zoomScale: 0.6, tiltOffset: 0.0 }, // lsystemVariant42
  284: { zoomScale: 0.6, tiltOffset: 0.0 }, // lsystemVariant44
  // Thin strange attractors still at the plain 1.0 default (siblings like
  // aizawa/lorenz were framed earlier). 0.45 sweep-verified: 2-3x fill gain,
  // none inside-black (err=0); line orbits stay intrinsically thin.
  43:  { zoomScale: 0.45, tiltOffset: 0.0 }, // thomasAttractor — 0.63% at default
  44:  { zoomScale: 0.45, tiltOffset: 0.0 }, // halvorsenAttractor — 0.52% at default
  78:  { zoomScale: 0.45, tiltOffset: 0.0 }, // pickoverAttractor — 0.91% at default
  85:  { zoomScale: 0.45, tiltOffset: 0.0 }, // svenssonAttractor — 0.55% at default
  // Last un-framed sparse entries, framed at sibling-proven values (sweep-verified):
  111: { zoomScale: 0.7, tiltOffset: 0.0 }, // mobiusStrip3D — thin ribbon surface
  87:  { zoomScale: 0.5, tiltOffset: 0.0 }, // flowerOfLife — flat disc pattern, close in
  235: { zoomScale: 0.5, tiltOffset: 0.0 }, // ifsVariant45 — sibling of framed IFS shells
  272: { zoomScale: 0.6, tiltOffset: 0.0 }, // lsystemVariant32 — same value as L-system batch
  132: { zoomScale: 0.5,  tiltOffset: 0.0 }, // mandelbrotVariant2 (high-power thin shell)
  133: { zoomScale: 0.5,  tiltOffset: 0.0 }, // mandelbrotVariant3
  134: { zoomScale: 0.5,  tiltOffset: 0.0 }, // mandelbrotVariant4
  137: { zoomScale: 0.5,  tiltOffset: 0.0 }, // mandelbrotVariant7
  140: { zoomScale: 0.5,  tiltOffset: 0.0 }, // mandelbrotVariant10
  147: { zoomScale: 0.5,  tiltOffset: 0.0 }, // juliaVariant7
  // NOTE: the ifsVariant (Menger fold==2) and lsystemVariant (Hilbert op==5) families were
  // black due to genuine shader-math bugs, not framing. They are fixed at the source in
  // src/shaders/modules/{ifs,lsystem}Variations.ts and frame correctly at the default
  // zoomScale 1.0 (like their working siblings), so no override is needed here.
};

export interface ResolvedIndices {
  fractalIdx: number;
  hybridIdx: number;
  tertiaryIdx: number;
  compositeOpIdx: number;
  cameraModeIdx: number;
  sliceAxisIdx: number;
  renderStyleIdx: number;
}

/**
 * Shared base for WebGL2 and WebGPU fractal engines.
 * Extracts common palette resolution, index computation, and uniform packing.
 */
export abstract class FractalEngineBase<Canvas extends HTMLCanvasElement | OffscreenCanvas = HTMLCanvasElement> {
  protected canvas: Canvas;
  public rendererInfo: string = 'Unknown';
  public qualityLevel: number = 2; // 0=low (mobile), 1=medium (laptop), 2=high (desktop)

  constructor(canvas: Canvas) {
    this.canvas = canvas;
  }

  /** Set quality level based on device capability */
  public setQualityLevel(level: number): void {
    this.qualityLevel = Math.max(0, Math.min(2, level));
  }

  /** Resolve palette from params (supports custom procedural palettes) */
  protected resolvePalette(params: FractalParams): ColorPalette {
    return params.customPalette
      || paletteMap.get(params.paletteId)
      || COLOR_PALETTES[0];
  }

  /** Compute all shader indices from params */
  protected computeIndices(params: FractalParams): ResolvedIndices {
    return {
      fractalIdx: getFractalIndex(params.type),
      hybridIdx: getFractalIndex(params.hybridType || params.type),
      tertiaryIdx: getFractalIndex(params.tertiaryType || 'riemannZeta'),
      compositeOpIdx: getCompositeOpIndex(params.compositeOp),
      cameraModeIdx: getCameraModeIndex(params.cameraMode),
      sliceAxisIdx: getSliceAxisIndex(params.sliceAxis),
      renderStyleIdx: getRenderStyleIndex(params.renderStyle),
    };
  }

  /**
   * Pack all rendering parameters into a 48-float uniform buffer.
   * Layout matches both GLSL uniforms and WGSL Uniforms struct.
   * Returns the populated Float32Array (caller provides or reuses buffer).
   */
  protected packUniforms(
    out: Float32Array,
    timeSec: number,
    params: FractalParams,
    palette: ColorPalette,
    indices: ResolvedIndices,
  ): Float32Array {
    const w = this.canvas.width;
    const h = this.canvas.height;

    // [0-3] resolution, time, phi
    out[0] = w;
    out[1] = h;
    out[2] = timeSec;
    out[3] = params.phiMultiplier;

    // [4-7] camera rotation, zoom, fractal type
    // Apply per-fractal camera adjustments for optimal 3D visualization
    const camAdjust = FRACTAL_CAM_ADJUST_OVERRIDES[indices.fractalIdx]
      || FRACTAL_CAM_ADJUST[indices.fractalIdx]
      || { zoomScale: 1.0, tiltOffset: 0.0 };
    out[4] = params.rotX;
    out[5] = params.rotY + camAdjust.tiltOffset; // Add per-fractal tilt offset
    out[6] = params.zoom * camAdjust.zoomScale;  // Scale camera distance per fractal
    out[7] = indices.fractalIdx;

    // [8-11] iterations, glow, morph speed, hybrid type
    out[8] = params.iterations;
    out[9] = params.glowIntensity;
    out[10] = params.morphSpeed;
    out[11] = indices.hybridIdx;

    // [12-15] hybrid blend, box fold, sphere fold, interior cut
    out[12] = params.hybridBlend ?? 0.0;
    out[13] = params.boxFold ?? 1.2;
    out[14] = params.sphereFold ?? 0.65;
    out[15] = params.interiorCut ?? 0.35;

    // [16-19] primary color RGB + tertiary index
    out[16] = palette.primary[0];
    out[17] = palette.primary[1];
    out[18] = palette.primary[2];
    out[19] = indices.tertiaryIdx;

    // [20-23] secondary color RGB + tertiary blend
    out[20] = palette.secondary[0];
    out[21] = palette.secondary[1];
    out[22] = palette.secondary[2];
    out[23] = params.tertiaryBlend ?? 0.0;

    // [24-27] accent color RGB + composite op
    out[24] = palette.accent[0];
    out[25] = palette.accent[1];
    out[26] = palette.accent[2];
    out[27] = indices.compositeOpIdx;

    // [28-31] smooth_k, warp, octaves, camera mode
    out[28] = params.smoothK ?? 0.35;
    out[29] = params.warpStrength ?? 0.3;
    out[30] = params.octaveLayers ?? 2;
    out[31] = indices.cameraModeIdx;

    // [32-35] camera position + slice plane
    out[32] = params.camPosX ?? 0.0;
    out[33] = params.camPosY ?? 0.0;
    out[34] = params.camPosZ ?? 0.0;
    out[35] = params.slicePlane ?? 0.0;

    // [36-39] headlamp, fog, slice axis, render style
    out[36] = params.headlampPower ?? 0.3;
    out[37] = params.volumetricFog ?? 0.15;
    out[38] = indices.sliceAxisIdx;
    out[39] = indices.renderStyleIdx;

    // [40-43] ambient color + palette seed
    out[40] = palette.ambient ? palette.ambient[0] : 0.02;
    out[41] = palette.ambient ? palette.ambient[1] : 0.02;
    out[42] = palette.ambient ? palette.ambient[2] : 0.02;
    out[43] = params.paletteSeed ?? 0.0;

    // [44-47] palette rotation + auto_rotate + quality level
    out[44] = params.paletteRotation ? 1.0 : 0.0;
    out[45] = params.autoRotate ? 1.0 : 0.0; // Auto-rotation flag (camera path handles rotation; shader keeps the slot)
    out[46] = this.qualityLevel; // 0=low (mobile), 1=medium (laptop), 2=high (desktop)
    out[47] = 0.0;

    return out;
  }

  /** Whether the engine is mid-shader-swap. Only WebGL2 overrides; WebGPU
   *  compiles pipelines without a per-frame swap guard. */
  public isShaderSwapping(): boolean {
    return false;
  }

  /** Live shader-compile progress 0..100 for the compiling overlay. */
  public getSwapProgress(): number {
    return 0;
  }

  abstract init(): Promise<boolean> | boolean;
  abstract render(timeSec: number, params: FractalParams): void;
  abstract destroy(): void;
}
