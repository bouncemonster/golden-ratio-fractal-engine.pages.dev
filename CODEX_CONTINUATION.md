# Codex continuation — Golden Ratio Fractal Engine

Source audit: 2026-11-16, baseline `a3b9ee04512efe94ce328b48075ceb5963038e83`. This is a dated entry record; check current `git rev-parse HEAD` and `git status --short` before the next change. A later documentation commit does not change the scope of earlier runtime evidence.

Canonical working directory: `J:/project/golden-ratio-fractal-engine/app`.

Continue the actual fractal renderer, shader mappings and controls in this repository. The Moonsugar explainer and Cloudflare publication are separate release surfaces.

## Read first

[AGENTS.md](AGENTS.md), [ARCHITECTURE.md](ARCHITECTURE.md), [DESIGN.md](DESIGN.md) and, for renderer work, [RENDERING_SYSTEM.md](RENDERING_SYSTEM.md). [package.json](package.json) owns the current commands.

## Accepted work and present limits

The 2026-11-13 exact-baseline Windows run accepted TypeScript checking, 718 unit assertions and 1,875 integration assertions. A historical production build is only linked by its revision prefix. Neither result establishes a new exact-build receipt, current remote CI, rendered GPU parity or numerical correctness. The later browser observation could not initialize WebGL2; it did not diagnose the user's hardware.

## Small checks

```sh
npm run lint
npm run test:unit
```

These are bounded source gates, historically accepted at the audited baseline; they were not rerun for this documentation candidate. Browser/mobile/benchmark scripts have separate requirements. `test:all` does not include `test:browser` or `test:mobile`.

## Starting the project

With existing dependencies and a task-owned free port: `npm run dev -- --host 127.0.0.1 --strictPort`. The manifest declares port 3000. Inspect ownership before starting; retain unrelated listeners. `deploy:cf` builds and publishes, so it is outside a development smoke check.

## Next concrete task

Prepare one rendered parity case using the existing browser harness on a device that actually exposes WebGL2. Pick a named preset implemented in both backends, fix viewport/camera/time/quality, record the actual backend and shader result, then compare outputs against a stated tolerance. First inspect `tests/browser-harness.ts` and `tests/cross-engine-parity-test.ts`; the latter's source assertions do not themselves prove rendered parity. Completion requires a captured frame and backend/device metadata, or an explicit capability blocker. Do not expand this into an all-preset benchmark.

## Preserve and report

Keep the 431-type catalog and WebGL/WebGPU mappings consistent. WebGPU coverage is partial and its documented fallback must remain explicit. Preserve existing assets, baseline images and local work; no GPU flag changes, dependency upgrade or production publication is implied. Scientific, performance, full browser/mobile and current remote-CI acceptance remain open.

For the next handoff, record the exact source revision, changed files, command and exit status, executed checks and adapters, output identity, preserved local work and one remaining criterion. Keep PASS, FAIL, NOT RUN and environment-dependent acceptance separate. Source-ready means development can continue; it does not certify the whole product or its scientific interpretation.
