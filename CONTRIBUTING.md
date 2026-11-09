# Contributing

Thank you for helping. A few rules keep Klatsch safe to run:

- **Sign off every commit** (Developer Certificate of Origin, https://developercertificate.org): `git commit -s`.
- Security-relevant changes (auth, disclosure, detectors, the web UI) need a test that shows the rule holds.
- No new runtime dependency without a reason in the pull request.
- Every user-visible flow has an end-to-end scenario, one file per flow in `test/e2e/` (`npm run e2e`: real HTTP, the real MCP client, simulated browsers). Adding or changing a tool, a page or a step means updating its scenario; `test/e2e/coverage.test.ts` fails otherwise.
- Run `npm run typecheck`, `npm test`, `npm run e2e`, `npm run test:ui`, `npm run schema:check` and `npm run flows:check` before opening a pull request (`npm run test:ui` runs in Chromium and WebKit; install WebKit once with `npx playwright install webkit`; `npm run flows` redraws the flow diagrams in `docs/flows/` after a scenario changes). CI also runs `npm run pack:check` (what the npm package would hold), a Gitleaks scan of the history and an OSV scan of `package-lock.json`.
- A security problem goes to private vulnerability reporting, not an issue: see [SECURITY.md](SECURITY.md).

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Releases: [docs/releasing.md](docs/releasing.md).
