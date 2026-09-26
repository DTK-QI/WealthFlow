# Verification record

Date: 2026-09-26 (Asia/Taipei)

## Official source audit

Read directly from `wealthfolio/wealthfolio` tag `v3.8.0`, commit `8f6f9898d30e84d7215e01d3d06cd65e02c9ab1b`:

- SDK context, HostAPI, ActivityCreate, manifest, permissions and network contract.
- Frontend add-on loader, lazy activation coordinator and iframe manager.
- Web/server add-on install/runtime-package/storage endpoints.
- Rust network broker validation, including HTTPS-only and private-address blocking.

Conclusion: add-on JavaScript runs in a browser-created sandbox iframe and cannot survive browser close or listen for HTTP. The server stores/serves add-on packages and host data; it does not run add-on JavaScript as a background worker. Full evidence links are in `docs/WEALTHFOLIO_COMPATIBILITY.md`.

## Automated coverage

- Calendar: timezone anchors, every-N periods, month-end clamp, short-month skip, leap year, inclusive end date.
- Execution ledger: competing workers, BACKFILL cap, SKIP advancement, snapshot isolation, duplicate prevention, lease, timeout and UNKNOWN.
- HTTP API: schedule validation, account currency checks, preview, pause/resume, immediate execution and filters.
- Native add-on path: bearer rejection, account sync, auto-post rejection, Node materialize-only behavior, add-on claim lease, UNKNOWN and stable-ID resolution.
- Add-on pure core: HTTPS URL validation, stable activity ID mapping, lookup and explicit HTTP errors.
- Legacy bridge adapter: mocked fetch contract without opening a local test socket.

## Commands and results

- `npm test`: passed — 5 test files, 23 tests.
- `npm run build`: passed — Node TypeScript, main React/Vite bundle, add-on TypeScript and add-on Vite bundle.
- Add-on output: `bridge-addon/dist/addon.js` (15.24 kB) and `bridge-addon/dist/wealthflow.css` (5.91 kB).
- `npm run package:addon -- --origin https://wealthflow.invalid`: packaging mechanics passed; `unzip -t` verified `manifest.json`, `dist/addon.js`, `dist/wealthflow.css`, and `README.md` with no archive errors.
- The placeholder-host verification ZIP was removed after inspection so it cannot be mistaken for a usable deployment artifact. A real package requires the operator's actual public HTTPS origin.

## Deliberately not verified or claimed

- No `.env` or `data/` user file was read, printed, or changed.
- No real Wealthfolio account or activity was written.
- The add-on was not installed into the user's Docker instance; therefore this repository does not claim deployed integration.
- No real public HTTPS WealthFlow origin was provided. Wealthfolio v3.8.0 rejects localhost/private-address broker targets, so an installable production ZIP cannot be correctly host-bound until that origin is known.
- `TRANSFER` remains disabled because the pinned v3.8.0 `ActivitiesAPI` has no atomic transfer-pair operation.
