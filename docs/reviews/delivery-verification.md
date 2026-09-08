# Local Delivery Verification

Date: 2026-09-08  
Scope: `docs/design/0004-local-delivery.md` delivery artifacts only. This is not a full product acceptance result.

## Result

PASS for the focused local-delivery behavior exercised here. The implementation files were not changed. Supplemental public-process tests were added in `tests/delivery-verification.test.ts`.

## Automated Evidence

Command:

```powershell
npm test -- --run tests/delivery.test.ts tests/delivery-verification.test.ts
```

Result: PASS, 2 files and 9 tests. Coverage includes invalid mode/host/port rejection, occupied-port failure without terminating the listener, project paths containing spaces, caller-working-directory independence, child-command exit propagation, verification fail-fast behavior, missing-dependency `npm ci`, production build-before-start ordering, explicit `-InstallBrowser`, successful full verification order, and `start.cmd` argument/exit forwarding.

Command:

```powershell
npm run typecheck
npx eslint tests/delivery.test.ts tests/delivery-verification.test.ts
```

Result: PASS for both commands. Vitest emitted an existing warning that `vitest.config.ts` uses ESM syntax while loaded as CommonJS under Vite's future native config loader; it did not fail this verification.

## Real Launcher Smoke

A free loopback port was allocated, then the real foreground launcher was run:

```powershell
.\scripts\start.ps1 -Mode dev -Host 127.0.0.1 -Port 10327
```

Observed: the script printed `http://127.0.0.1:10327`; Next.js 16.3.4 reached Ready in 570 ms.

From a second process:

```powershell
$response = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:10327/'
"STATUS=$($response.StatusCode) BYTES=$($response.RawContentLength)"
```

Observed: `STATUS=200 BYTES=15466`; the launcher logged `GET / 200`. Ctrl+C was sent only to the owned foreground session, followed by `Y` at Windows' `Terminate batch job (Y/N)?` prompt. The interrupted npm chain exited 1 as expected. A subsequent exclusive bind to port 10327 succeeded, confirming cleanup.

## Artifact Review

`README.md`, `requirements.md`, `.env.example`, `scripts/start.ps1`, `scripts/verify.ps1`, `start.cmd`, and `tests/delivery.test.ts` match the local-delivery scope reviewed. Documentation distinguishes fixture behavior from pending SQLite and live-provider capabilities. `.env.example` contains names and empty values, separates AMap browser and Web Service capabilities, and uses `DATABASE_PATH`.

Credential-pattern scan:

```powershell
rg -n --hidden -i "(api[_-]?key|secret|token|password|amap[_-]?.*key|llm_api_key)\s*[:=]\s*[^\s#]+" README.md requirements.md .env.example scripts/start.ps1 scripts/verify.ps1 start.cmd tests/delivery.test.ts tests/delivery-verification.test.ts
```

Result: no matches (ripgrep exit 1 means no matching credential-like assigned values). No environment values were printed by tests or smoke commands.

## Limitations And Risks

- Per assignment, no concurrent global production build, complete `verify.ps1`, or Playwright suite was run. The required order and success/failure behavior were exercised with temporary public-process command shims.
- `-InstallBrowser` was verified as an explicit ordered process invocation; Chromium was not installed or reinstalled during this run.
- Production mode was behaviorally verified to run build before start, but only development mode received a real HTTP smoke check.
- SQLite startup schema initialization remains pending and is described as pending by the delivery documentation, so no persistence delivery gate is claimed.
- Live AMap, model, and web-research adapters were not started; no provider acceptance gate is claimed.
- The repository root resolves to `C:/Users/19276`, above this project. This verification did not initialize, reconfigure, publish, or clean that repository.
