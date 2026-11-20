# Project Documentation Index

## Core Files

| File | Lines | Size | Purpose |
|------|-------|------|---------|
| [FractalEngineBase.ts](../src/engine/FractalEngineBase.ts) | 221 | 9.7KB | Base class, uniform packing (48 floats) |
| [fractalMappers.ts](../src/engine/fractalMappers.ts) | 577 | 22KB | String→index mappings (451 names → 431 indices) |
| [types/fractal.ts](../src/types/fractal.ts) | 576 | 32KB | TypeScript interfaces |
| [WebGLEngine.ts](../src/engine/WebGLEngine.ts) | 523 | 23KB | WebGL2 renderer |
| [WebGPUEngine.ts](../src/engine/WebGPUEngine.ts) | 239 | 8.7KB | WebGPU renderer |
| [useRenderEngine.ts](../src/hooks/useRenderEngine.ts) | 782 | 34KB | React hook, lifecycle, render loop |
| [webglShaders.ts](../src/shaders/webglShaders.ts) | 4195 | 161KB | GLSL shaders, 431 SDFs, 10 modes |
| [webgpuShaders.ts](../src/shaders/webgpuShaders.ts) | 4070 | 159KB | WGSL shaders |

## Detailed Analysis

- [App.md](App.md) - Main component, auto-explore, neuro-feed
- [main-tsx.md](main-tsx.md) - Entry point (no StrictMode for WebGPU)
- [index-css.md](index-css.md) - Global styles (full-screen dark canvas)
- [FractalCanvas.md](FractalCanvas.md) - Canvas controls and interaction
- [ControlsPanel.md](ControlsPanel.md) - Main control panel with 8 tabs
- [FractalScrollFeed.md](FractalScrollFeed.md) - Neuro-feed ribbon for specimens
- [FractalInfoHUD.md](FractalInfoHUD.md) - HUD overlay with specimen info
- [FractalProbeHUD.md](FractalProbeHUD.md) - Topological probe telemetry
- [TelemetryHUD.md](TelemetryHUD.md) - FPS and performance telemetry
- [DebugOverlay.md](DebugOverlay.md) - Render diagnostics and debugging
- [ExplanationModal.md](ExplanationModal.md) - Scientific explanation modal
- [UserProfileModal.md](UserProfileModal.md) - User taste profile and settings
- [ProjectManifestModal.md](ProjectManifestModal.md) - Welcome modal and project intro
- [CosmicLoader.md](CosmicLoader.md) - Loading screen driven by real GPU load progress
- [FractalAtlasModal.md](FractalAtlasModal.md) - Scientific atlas with 145 fractals
- [NeuroAestheticsEngine.md](NeuroAestheticsEngine.md) - Taste profile, breeding, archetypes
- [types-fractal.md](types-fractal.md) - Core TypeScript interfaces
- [palettes.md](palettes.md) - 26 hand-crafted + 640 procedural = 666 palettes
- [fractal-catalog.md](fractal-catalog.md) - 145 entries, 10 category keys / 11 files
- [goldenAudio.md](goldenAudio.md) - 432 Hz sacred geometry audio engine
- [FractalEngineBase.md](FractalEngineBase.md) - Base class, 48-float uniform layout
- [WebGPUEngine.md](WebGPUEngine.md) - WebGPU renderer details
- [RenderDiagnostics.md](RenderDiagnostics.md) - Performance and math validation
- [MathValidation.md](MathValidation.md) - Scalar, vec3, matrix validation
- [UserProblemLogger.md](UserProblemLogger.md) - IndexedDB error tracking
- [fractalMappers-analysis.md](fractalMappers-analysis.md) - Complete type mappings
- [juliaVariations.md](juliaVariations.md) - 50 Mandelbulb/Julia GLSL variations
- [shader-modules.md](shader-modules.md) - All shader modules overview (38KB, 649 lines, kkrieger-compressed)
- [webgpuShaders.md](webgpuShaders.md) - WGSL shaders for WebGPU (4069 lines)
- [WebGLEngine.md](WebGLEngine.md) - WebGL2 renderer details
- [useRenderEngine.md](useRenderEngine.md) - Hook lifecycle and shortcuts
- [webglShaders.md](webglShaders.md) - Shader structure and uniforms

## Architecture

- [ARCHITECTURE.md](../ARCHITECTURE.md) - Project structure, dependencies
- [RENDERING_SYSTEM.md](../RENDERING_SYSTEM.md) - Render modes, lighting, post-processing
- [WHITEPAPER.md](../WHITEPAPER.md) - Project overview, competitor analysis
- [ARCHITECTURE_DIAGRAMS.md](ARCHITECTURE_DIAGRAMS.md) - Visual diagrams (Mermaid)

## Search discoverability

- [2026-11-20 evidence](seo-evidence-2026-11-20.md) - Public host roles, current source and HTTP baseline, official guidance, research limits and the next rendering check.

## Guides & Tutorials

- [TUTORIALS.md](TUTORIALS.md) - Step-by-step guides (add fractals, render modes, deploy)
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) - Common problems and solutions
- [DEPLOYMENT.md](DEPLOYMENT.md) - Complete deployment guide (Cloudflare, Vercel, Docker)
- [FAQ.md](FAQ.md) - Frequently asked questions
- [CONTRIBUTING.md](CONTRIBUTING.md) - How to contribute
- [CHANGELOG.md](CHANGELOG.md) - Version history

## Configuration

- [vite-config.md](vite-config.md) - Vite build configuration (React + Tailwind v4)
- [wrangler-toml.md](wrangler-toml.md) - Cloudflare Pages deployment
- [index-html.md](index-html.md) - HTML entry point with meta tags

## Key Numbers

- **431** catalog type ids → **~146** distinct distance estimators; the live UI renders **113** (idx 0–130), curated to **61** in the auto-showcase (see [fractal-math-to-render.md](fractal-math-to-render.md))
- **146** catalog entries (57 unique engine types across 10 category keys)
- **7** render modes
- **8** composite operations
- **4** camera modes
- **48** uniform buffer floats (192 bytes)
- **54** TypeScript source files
- **44** documentation files
- **~847KB** source code
- **~200KB** documentation
- **300KB** shader code (GLSL + WGSL)
