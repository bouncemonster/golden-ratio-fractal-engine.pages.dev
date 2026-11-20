# Search discoverability evidence — 2026-11-20

## Decision and scope

The interactive Pages application and the Moonsugar explainer represent **one product with different public host roles**. The initial HTML of the GPU application is an application shell. A missing heading in that initial response does not by itself demonstrate an indexing failure or justify adding another landing page.

This record preserves the existing publication boundaries and provides a reproducible baseline for the next search investigation. It does not claim Google indexing, AI citations, rendering acceptance, or increased traffic. No application, renderer, Cloudflare setting, or deployment was changed by this audit.

## Source inspected

- Repository: [bouncemonster/golden-ratio-fractal-engine.pages.dev](https://github.com/bouncemonster/golden-ratio-fractal-engine.pages.dev).
- Exact local and remote-main revision: `6619218d070d77e1409b4d2ebc1b63f9c4e032e9`; working tree was clean before the documentation change.
- Earlier source change `a3b9ee04512efe94ce328b48075ceb5963038e83`, dated 2026-11-12, restored Pages robots, sitemap, canonical metadata and previews. This audit did not deploy that change again.
- Inspected: [agent entry](../AGENTS.md), [continuation](../CODEX_CONTINUATION.md), [host ownership](../.github/README.md#hosted-builds), [architecture](../ARCHITECTURE.md), [design](../DESIGN.md), [HTML entry](../index.html), [application component](../src/App.tsx), [robots](../public/robots.txt), [sitemap](../public/sitemap.xml), and [package scripts](../package.json).

The design contract defines a full-screen canvas without document scrolling. The React application includes a screen-reader heading describing the interactive 3D fractal explorer and separate explanatory/manifest overlays. Their presence in source is not proof that Google's renderer executed them successfully. The maintained product documentation identifies WebGL2 as primary and WebGPU as optional with partial type coverage; no full backend parity is asserted here.

## Public HTTPS observations

Observed 2026-11-20 at 08:56:52 UTC through an ordinary HTTP client. No crawler impersonation or security-policy bypass was used.

| Public URL | Observed response | Role and search treatment |
| --- | --- | --- |
| [Pages application](https://golden-ratio-fractal-engine.pages.dev/) | 200 HTML; self-canonical in the initial HTML; title and description present; JavaScript module loads the application. | Interactive application owned by this repository. Raw HTML lacks an H1; source includes a React H1. |
| [Pages robots.txt](https://golden-ratio-fractal-engine.pages.dev/robots.txt) | 200 text; `User-agent: *`, `Allow: /`, and the correct sitemap declaration. | Crawling is permitted by this file. This alone does not establish access through every network path. |
| [Pages sitemap.xml](https://golden-ratio-fractal-engine.pages.dev/sitemap.xml) | 200 XML; one canonical URL, the Pages root. | Existing publication metadata; no speculative catalog URLs were added. |
| [Moonsugar explainer](https://swype-imagine.moonsugar.space/) | 200 HTML; its own canonical; descriptive title and visible project headings; metadata distinguishes WebGL2 from partial WebGPU support. | Explanatory surface owned by the sibling Moonsugar repository. |
| [Moonsugar native copy](https://swype-imagine.moonsugar.space/native.html) | 200 HTML; `noindex,follow`; canonical hint points to the Pages root. | Native application copy excluded from SEO targets. The hint is observed markup, not proof of Google's selected canonical. |

Both native HTML responses referenced `/assets/index-BJeVTBcQ.js`. Matching asset names support the host-role analysis but do not prove identical complete deployments or a Git revision.

SHA-256 of the UTF-8 response text:

| Response | SHA-256 |
| --- | --- |
| Pages root HTML | `A3A2D27F08418CEA27EC22B39422DB5F6733CA1AD9053D8993BB6BE2490212D2` |
| Pages robots.txt | `76AB9B32EA8EFBE3B66245B8407EEDE0E6861A34ED1C7FFEAB3E8E8C0883F1EB` |
| Pages sitemap.xml | `CF0A039DF0B909DAF61A27D8C61781E6BEB6E51E6C0E2C6A018AE9751A43EF94` |
| Moonsugar explainer HTML | `67B54D199270BDEE93D6F2DB1C51DC0C62AD0FC6765E500626E228D24753D0E9` |
| Moonsugar native HTML | `E36DD825411C99258313414ED868FFE3EC165144ABBD437C1597BFEC8C700A41` |

These are point-in-time response identities. They are not uptime, GPU-performance, or deployment-provenance certificates.

## Apply the evidence in SEO tools

Use one logical project entry, **Golden Ratio Fractal Engine**, with `swype-imagine` as an alias. Record the Pages root as the interactive host and the Moonsugar root as the explainer. Keep `native.html` outside indexable target-page lists. Keep the two repositories' release ownership separate.

The OpenSEO inventory write and GSC operations belong to the coordinating account audit. This repository record does not claim that either external operation has completed.

The next useful technical gate is an observed Google rendering/indexing result for the Pages root, assessed alongside the explainer. If rendered HTML contains only a GPU error or omits meaningful project content, investigate that specific failure and add a small, accurate accessible fallback within the existing application. Preserve the viewport and controls. A raw-HTML heading score is insufficient evidence for that change.

## Official guidance and research limits

1. **[Google: JavaScript SEO basics](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics).** Google distinguishes crawling, rendering and indexing and can process application shells. Initial HTML alone therefore cannot establish the final indexed content. Server rendering or prerendering can help users and crawlers, but that general benefit is not a diagnosis of this GPU application's current Google result.
2. **[Google: generative AI optimization guide](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide).** Ordinary search fundamentals, accessible useful content and clear technical structure remain applicable. Google does not use `llms.txt` as a special ranking input and requires no special AI schema or artificial content chunking. No such files or markup were added solely for an AI score.
3. **[GEO: Generative Engine Optimization, KDD 2024](https://arxiv.org/html/2311.09735v3).** The reported visibility gains are experimental answer-visibility measures. The authors explicitly did not evaluate effects on search rankings. This does not establish a traffic increase for this project or justify promising the headline percentage after a content edit.
4. **[What Gets Cited: Competitive GEO in AI Answer Engines, SIGIR 2026](https://arxiv.org/html/2605.25517v1).** This study compares two injected candidate documents, with anonymized brands and controlled order, across six models. It supports testing relevance, completeness and evidence rather than treating formatting as a guarantee. It does not test this site's discovery, Google's production retrieval, or its visitors and conversions.

A useful future content change would explain actual controls, supported rendering paths and a reproducible example with its real device/backend/preset/date. Scientific, numerical and performance claims require their own measured evidence; publishing a paper link or historical test count does not provide it.

## Validation and handoff

- **PASS:** current GitHub/main identity and clean-source readback before this change; the five public HTTP observations above; source/metadata inspection.
- **NOT RUN:** application build, unit/integration/browser/mobile tests, GPU rendering, benchmark, fresh GSC live test and indexing acceptance. This documentation-only change does not alter their inputs or substitute for those checks.
- **NOT PERFORMED:** Cloudflare deployment, Moonsugar source changes, crawler-policy changes, paid SEO queries or harness installation.

The next owner should reuse this baseline, record any later GSC result with its timestamp and actual property/URL, and change the product only for a confirmed user or discovery issue.
