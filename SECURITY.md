# Security policy

This project runs live but does not claim to be secure. Read [docs/security.md](docs/security.md) before you deploy. It has the security model, the residual risks and the known gaps.

## Report a vulnerability

Report it in private, through GitHub:

1. Open the **Security** tab of <https://github.com/Giftedx/rs-sdk-discord-bot>.
2. Select **Report a vulnerability**.
3. Describe the problem, the affected file, and the steps that show it.

Do not open a public issue for a vulnerability. Do not put a real password, token or server address in a report.

If the **Report a vulnerability** button is missing, open a public issue that says only that you have a security report. Give no details in it.

The maintainer works on this project in spare time. There is no promised response time.

## In scope

- A path that leaks the game password to the box, a log, a command line or an error message.
- An action that passes the proxy against the action policy.
- A step of `scripts/server-bootstrap.sh` in which root reads a program, a policy or a path that the service user can write.
- A flaw in the handling of the Chrome download or the AppArmor profile, beyond the residual risk in `docs/security.md`.

## Out of scope

- The items under "Known gaps in the current code" and "Residual risks" in `docs/security.md`. They are known. A pull request that closes one is welcome.
- A vulnerability in rs-sdk, Chromium, Bun or another dependency. Report it to that project.
- The game server that you connect to.
