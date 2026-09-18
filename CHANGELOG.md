# Changelog

All notable changes to **Jev Router Playground** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-09-18

### Added
- Initial public release.
- Three-step playground: model pool, task input, decision review.
- Add, paste-list, and browse-the-catalogue workflows for building the candidate pool.
- Editable per-candidate routing descriptions.
- Ask-Jev-to-choose with full probability distribution and confidence level.
- Run every model in parallel with per-model 60s timeout, incremental rendering,
  per-model timing, and approximate cost.
- Plain-language explanation of Jev's pick, generated via the cheapest in-pool
  model on OpenRouter.
- Pick-your-favourite-vs-Jev's-pick match / mismatch verdict.
- Per-run JSON export of task, pool, routing, picks, answers, and timings.
- Bundled CORS proxy (`proxy-worker/`) deployable with one `wrangler` command.
- Settings modal for keys, endpoint overrides, and a connection probe.
- Settings self-heals a saved direct-TypeSafe URL to the proxy on load.

### Security
- Keys live in `sessionStorage` only; non-secret settings in `localStorage`.
- No analytics or third-party scripts.
- OpenRouter calls go directly from the browser; Jev calls use the configured
  CORS proxy, which forwards the authorization header to TypeSafe.

[0.1.0]: https://github.com/hugo-alves/jev-router-playground/releases/tag/v0.1.0
