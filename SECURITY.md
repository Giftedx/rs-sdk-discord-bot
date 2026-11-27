# Security policy

This project is work in progress and makes no claim that it is secure. [docs/security.md](docs/security.md) describes the security model, the residual risks and the known gaps. Read it before you deploy.

## Report a vulnerability

Report a vulnerability in private, through GitHub:

1. Open the **Security** tab of the repository <https://github.com/Giftedx/rs-sdk-discord-bot>.
2. Select **Report a vulnerability**.
3. Describe the problem, the affected file, and the steps that show it.

Do not open a public issue for a vulnerability. Do not put a real password, a token or a server address in a report.

If the **Report a vulnerability** button is not there, open a public issue that says only that you have a security report. Give no detail in that issue.

The maintainer works on this project in spare time and promises no response time.

## In scope

- A path that gives the game password to the box stand-in, to a log, to a command line or to an error message.
- An action that passes the proxy against the action policy.
- A step of `scripts/server-bootstrap.sh` in which root reads a program, a policy or a path that the service user can write.
- A flaw in the handling of the Chrome download or of the AppArmor profile that goes beyond the residual risk in `docs/security.md`.

## Not in scope

- The items under "Known gaps in the current code" and "Residual risks" in `docs/security.md`. They are known. A pull request that closes one is welcome.
- A vulnerability in rs-sdk, in Chromium, in Bun or in a different dependency. Report it to that project.
- The game server that you connect to.
