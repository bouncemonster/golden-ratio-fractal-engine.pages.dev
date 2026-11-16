# Agent entry — Golden Ratio Fractal Engine

## Correct source and reading order

Resume with [CODEX_CONTINUATION.md](CODEX_CONTINUATION.md) for the dated accepted scope and next bounded renderer criterion.

This is `bouncemonster/golden-ratio-fractal-engine.pages.dev`, the Golden Ratio Fractal Engine. Its current GitHub `main` is authoritative. The recorded local checkout `J:\project\golden-ratio-fractal-engine\app` is a location hint, not evidence that its contents are current. Do not create a second engine beside it or substitute another simulation project.

Read [.github/README.md](.github/README.md) for the product, [ARCHITECTURE.md](ARCHITECTURE.md) for the implementation map, and [DESIGN.md](DESIGN.md) for the design contract. The old instruction pointing to `AGENT.md` was incorrect: that file was absent at the 2026-10-05 inspection. Do not recreate a competing architecture document to satisfy the obsolete pointer.

Use [RENDERING_SYSTEM.md](RENDERING_SYSTEM.md) for renderer details and [package.json](package.json) for current scripts/dependencies. Version labels, assertion totals, bundle sizes and timing claims in historical prose are not fresh measurements.

## Resume before changing

Inspect branch, current GitHub revision, recent commits, existing issue/handoff, staged and unstaged changes. Preserve other IDEs' work and identify active workers before claiming files. A running local IDE does not supersede GitHub source. Do not reset, clean, stash or force-push to reconcile divergence.

Use `main` as the established publication branch. Keep one bounded outcome and disjoint worker scopes; serialize shared instructions, package/lock files and generated assets. No automatic worktrees, parallel copies or new deployment route.

## Rendering boundaries

WebGL2 is primary. The maintained renderer contract describes 431 types in WebGL2 and partial WebGPU coverage with the documented fallback. Both are fragment-shader ray-marching pipelines, not compute-shader implementations. Do not advertise full backend parity from the existence of a WebGPU path.

Shaders live under `src/shaders/`; engine behavior and type mappings live under `src/engine/`. Confirm paths in the current tree before editing. Keep catalog changes, mappings, shader math and renderer expectations consistent.

`src/index.css` contains the Tailwind theme and brand aliases. Respect the design contract, reduced motion, touch targets and lazy-loading boundaries. Do not replace actual renderer evidence with generated artwork or inflate performance claims.

## Build and checks

From the repository root, with dependencies prepared:

```sh
npm run lint
npm run build
npm run test:unit
npm run test
```

`lint` is TypeScript checking. The following declared lanes need their corresponding browser/runtime environment:

```sh
npm run test:browser
npm run test:mobile
npm run test:headless
npm run test:benchmark
```

`npm run test:all` includes unit, integration, headless, benchmark and quality scripts, but **does not include `test:browser` or `test:mobile`** in the inspected manifest. Run relevant missing lanes separately. Do not report a script as passed merely because it exists.

For a local interactive inspection:

```sh
npm run dev -- --host 127.0.0.1
```

The declared port is 3000. Check it first and stop only the task-owned server. Local GPU support, browser flags and rendering resolution affect results; record them when comparing output or performance.

## Demonstrations and assets

The README gallery uses existing repository images. Those images are illustrative project assets, not newly captured proof of current UI behavior. A new demonstration must record source revision, actual renderer, fractal/preset, browser/device, viewport and whether the scene is animated or paused.

Preserve existing assets and license notices. Avoid adding giant binaries or archived source bundles. Community guidance stays in `.github/ISSUE_TEMPLATE/`, `.github/pull_request_template.md`, `.github/SECURITY.md` and `.github/CODE_OF_CONDUCT.md`.

## Publication and handoff

Documentation work does not authorize Cloudflare publication. `deploy:cf` builds and deploys; it is not a test command. No `.env`, tokens, private data, generated deployment credentials or `_archive` ZIPs belong in commits.

A second repository, `moonsugar.space`, publishes a pinned explainer build at `swype-imagine.moonsugar.space`. Its host, DNS, ingress and release lane live there (`apps.lock.json` names the revision); a commit or push in this tree does not move it and authorizes no write there. Verify a published URL before repeating it as live: on 2026-10-12 `swype-imagine.moonsugar.space` and the Pages deployment answered 200, while `fractal.simundis.com` answered HTTP 530 (Cloudflare error 1033). Ownership detail lives in `.github/README.md` → "Hosted builds"; do not duplicate it here.

After a scoped change, record files, source revision, exact checks and outcomes, publication commit/readback and remaining work in the current task record. Preserve active/unknown worker ownership and one next action before switching IDEs or compressing context. Keep PASS, FAIL, NOT RUN and BLOCKED distinct. A documentation commit is not a deployed application revision.
