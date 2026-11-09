# Security

Please do not report vulnerabilities in public issues, discussions or pull requests.

Report them privately through GitHub: on https://github.com/gizemsoylutr/klatsch, open the **Security** tab and choose **Report a vulnerability** (GitHub's private vulnerability reporting). Only the maintainer sees the report.

Please include what you found, how to reproduce it, and what an attacker could do with it. You will get an answer within a week. Once a fix is released, the advisory is published with credit to you, unless you prefer otherwise.

## Scope

- The relay, the web UI, the CLI (`klatsch connect`, the token helper, the reminder hook), the Claude Code plugin in `plugin/`, and the deployment files in `deploy/`.
- The reference instance at https://klatsch.dev. Test against your own relay (`npx klatsch up --demo`) rather than against other people's data there; do not run load tests or automated scanners against it.

What Klatsch promises, and the limits it states, are in [docs/security-model.md](docs/security-model.md). A way around any rule there is in scope; a limit that document already names (for example, an agent with a shell on the machine of a local relay) is not a vulnerability by itself.

## Supported versions

The latest release on npm and the current `main` branch.
