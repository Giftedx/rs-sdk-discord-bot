# Development

This page tells you how to build, test and run this project on your own machine. [design.md](design.md#2-terms) has the terms table.

## Tools

- You need git and Bun 1.4.5. CI uses that version. Other versions are not tested.
- The tests (`bun test`) and the type check (`bunx tsc --noEmit`) run on Windows and on Linux. macOS is not tested.
- The local stack, the proxy proof and the other scripts need Linux. On Windows, use WSL2. We tested this guide with WSL2 Ubuntu 24.04.
- Run the local stack, the browser and the scripts as a non-root user. Chromium does not start as root with its sandbox on. Do not use `--no-sandbox`.

## Prepare Linux or WSL2 Ubuntu

1. Use a non-root user. The default user of a WSL2 distribution is correct. If you have none (for example in a container that starts as root), create one: `useradd -m -s /bin/bash rsdev`.
2. As root or with `sudo`, install git and the system libraries that Chrome needs:

   ```bash
   apt-get update
   apt-get install -y git curl unzip libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libcups2t64 libdrm2 \
     libgbm1 libgtk-3-0t64 libnss3 libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 \
     libxrandr2 libpango-1.0-0 libcairo2 libxshmfence1 fonts-liberation fonts-inter
   ```

   The package names with `t64` exist on Ubuntu 24.04 and later. On an older release, use the same names without `t64`.
3. As your non-root user:

   ```bash
   curl -fsSL https://bun.sh/install -o /tmp/bun-install.sh && bash /tmp/bun-install.sh bun-v1.4.5
   export PATH="$HOME/.bun/bin:$PATH"
   git clone --recurse-submodules https://github.com/Giftedx/rs-sdk-discord-bot.git
   cd rs-sdk-discord-bot
   bun install
   ```

Notes:

- The first command saves the Bun installer to `/tmp/bun-install.sh` before it runs it. You can read the file first. Nothing verifies its content.
- `bun install` normally downloads Chrome for Testing to `~/.cache/puppeteer`. If `bun test` reports that no browser is found, run `bunx puppeteer browsers install chrome` once.
- In WSL2, keep the clone in the Linux file system. `bun install` and the game engine are slow on `/mnt/<drive>`.
- The clone can be in any directory. The scripts find the repository root from their own location.

## Checks before each commit

Run the type check and the tests before each commit. Both must pass.

```bash
bunx tsc --noEmit
bun test
```

`bunx tsc --noEmit` prints nothing. `bun test` ends with `0 fail`. The type check covers `src/` and `scripts/`. `bun test` runs the tests in `src/`.

### Tests that launch Chromium

The tests in `src/gamelink/game-tab.test.ts` and `src/gamelink/card-tab.test.ts` launch Chromium headless with its sandbox on. They load a fixture page from this repository. They contact no game server.

On Ubuntu 23.10 and later, AppArmor restricts unprivileged user namespaces. Then Chromium can stop with `No usable sandbox!`. This depends on the Chrome path and on your system. [deploy-server.md](deploy-server.md) explains the cause. On WSL2 Ubuntu 24.04, Chromium started its sandbox without a change.

If Chromium stops with `No usable sandbox!` on your development machine, do one of these:

1. Skip the tests that launch Chromium with `RS_SKIP_BROWSER_TESTS=1 bun test`. The command prints a line that says so, and the other tests run. Then the proxy proof, the measurement tool and the idle test cannot run on this machine.
2. Give your Chrome an AppArmor profile, as the server bootstrap does. Install a root-owned Chrome copy at a path that matches `/opt/rs-chrome/*/chrome-linux64/chrome`, load the profile in `deploy/apparmor/rsbot-chrome-for-testing`, and set `RS_CHROME_PATH` to that Chrome. This project tested this option only on a server through `scripts/server-bootstrap.sh`, not on a desktop. Read "Residual risk" in [deploy-server.md](deploy-server.md) first.

Never add `--no-sandbox` to make a test pass. A test checks that the launch arguments do not have that flag.

### CI

The CI workflow (`.github/workflows/ci.yml`) has two jobs:

- Job `check` runs the type check, `shellcheck scripts/*.sh` and the tests with `RS_SKIP_BROWSER_TESTS=1`. GitHub's Ubuntu runners restrict user namespaces as Ubuntu 23.10 does, so this job skips the tests that launch Chromium.
- Job `browser-tests` installs Chrome for Testing, sets `kernel.apparmor_restrict_unprivileged_userns` to 0 on the runner, and runs all tests. Chromium keeps its own sandbox. The runner is a temporary machine. Do not change that sysctl on a server.

Before you change `src/gamelink/game-tab.ts`, run the full `bun test` on your own machine.

## Repository layout

| Path | Content |
|---|---|
| `src/bot/` | The Discord bot: start, settings, the guilds, the queue, and the small model that sorts messages. |
| `src/agent/` | The agent loop, the spend record, the knowledge pack, and the store of saved scripts and notes. |
| `src/orchestrator/` | The SQLite database, the wake rules and the budget. |
| `src/box/` | The job runner, the job cgroup, the built-in protections and the seed scripts loader. |
| `src/discord/` | The status card, the adventure log, the gallery, the posts, the queue votes and the discord.js adapters. |
| `src/cards/` | The templates of the drawn cards, the item icons and the XP chart. |
| `src/events/` | The comparison of state snapshots that makes events. |
| `src/shared/` | The configuration loader, the sanitizer of Discord text, and the secret helpers of the scripts. |
| `src/gamelink/` | The action policy, the proxy, the game tab and the re-login delay. |
| `src/measure/` | The `/proc` reader of the measurement tool. |
| `src/deploy/`, `src/scripts/` | Tests of the server scripts and of the script helpers. |
| `src/testing/` | A fake gateway, a fixture page and the test preload. |
| `scripts/` | The local stack, the proxy proof, the idle test, the measurement tool, the server bootstrap and the other server scripts. |
| `seed/` | The seed scripts that each guild gets at the start. |
| `deploy/apparmor/` | The readable copy of the AppArmor profile. |
| `deploy/systemd/` | The systemd units of the bot, gamelink, the firewalls, the backup, the revision check and the alerts. |
| `vendor/rs-sdk/` | The rs-sdk submodule, pinned at commit `3506b20`. This project never edits it. |
| `docs/` | The guides and the design. |

## Configuration

`src/shared/config.ts` reads these variables. [`.env.example`](../.env.example) has the same list with example values. You do not need a `.env` file.

| Variable | Default | Allowed values | Meaning |
|---|---|---|---|
| `RS_ACCOUNT` | none, required | `^[a-z0-9]{1,12}$` | The account name. |
| `RS_PASSWORD` | none, required | 1 to 20 characters | The game password. |
| `RS_SERVER_HOST` | `rs-sdk.maxbittker.com` | a host name | The game server. The default is the demo world. The configuration refuses the host name `rs-sdk-demo.fly.dev`. |
| `RS_GATEWAY_URL` | `wss://<RS_SERVER_HOST>/gateway` | a WebSocket URL | The rs-sdk gateway. The proxy sends the password there. |
| `RS_BOT_PAGE_URL` | `https://<RS_SERVER_HOST>/bot` | a URL | The bot page. The game tab sends the password there. |
| `RS_FPS` | `15` | 10 to 50 | The client frame rate of the game tab. |
| `PROXY_PORT` | `7790` | 1 to 65535 | The loopback port of the proxy. |
| `RS_CHROME_PATH` | the Chrome of puppeteer | an absolute path | The Chrome binary. If the file does not exist, the launch fails. |

The scripts and the tests also read these variables:

| Variable | Meaning |
|---|---|
| `RS_ALLOW_DEMO` | `1` allows mode `demo` of the scripts. |
| `DEV_STACK_TIMEOUT_S` | Seconds that `dev-stack.sh` waits for each part. Default 1800. |
| `RS_SKIP_BROWSER_TESTS` | `1` skips the tests that launch Chromium. |

The scripts have two modes:

- Mode `local` always uses `ws://localhost:7780` and `http://localhost:8888/bot`. It ignores `RS_GATEWAY_URL` and `RS_BOT_PAGE_URL`.
- Mode `demo` uses the configuration without changes. The name `demo` means "not the local stack". For your own remote game server, set `RS_SERVER_HOST`, `RS_GATEWAY_URL` and `RS_BOT_PAGE_URL`, and use mode `demo` with `RS_ALLOW_DEMO=1`.

The scripts give the box stand-in these variables: `BOT_USERNAME`, `PASSWORD`, `GATEWAY_URL`, `SHOW_CHAT`, `AUTO_LAUNCH_BROWSER`, `TELEMETRY`, `PATH` and `HOME`.

- The SDK code in the box stand-in reads `BOT_USERNAME`, `PASSWORD`, `GATEWAY_URL` and `SHOW_CHAT`.
- `AUTO_LAUNCH_BROWSER` and `TELEMETRY` are `false` as a precaution for other rs-sdk code that reads them.
- In the box stand-in, `PASSWORD` holds the boot token of the proxy, not the game password. `GATEWAY_URL` points at the proxy.
- The scripts start the box stand-in with `--no-env-file`. Without that flag, Bun gives a child process the variables of a `.env` file in the working directory. It does this even if the parent passes an explicit environment.

## Local stack

The local stack is an rs-sdk game server on your machine: the engine, the bundler of the web client, and the gateway. Ports 8888 and 7780 must be free. The proxy uses port 7790.

> **Warning.** Use the local stack only on a development machine behind a firewall. It is not a server for a deployment.
>
> - By a reading of the rs-sdk source, the engine listens on port 8888 on all network interfaces. That port serves the game, the bot page and a relay to the gateway (`/gateway`).
> - The local stack has its login server off, so the gateway accepts any password. Anyone who can reach port 8888 can log in as any account and can control a connected game tab.
> - The password separation of the proxy and the action policy do not protect against the gateway of the local stack. A process on the same machine can connect to `ws://localhost:7780` directly, without the proxy.
> - If the machine has no firewall in front of it, block inbound TCP port 8888 before you start. With an active `ufw`: `sudo ufw deny 8888/tcp`.

Run from the repository root, as your non-root user:

```bash
bash scripts/dev-stack.sh          # start; prints "dev stack ready"
bash scripts/dev-stack.sh stop     # stop all parts
```

The script starts the three rs-sdk parts in the background. Each part writes a log in `measurements/raw/`:

| Part | Command | Address |
|------|---------|---------|
| engine | `cd vendor/rs-sdk/server/engine && BUILD_VERIFY=false bun run start` | `http://localhost:8888/bot` |
| webclient bundler | `cd vendor/rs-sdk/server/webclient && bun install && bun run watch` | `server/webclient/out/bot/client.js` |
| gateway | `cd vendor/rs-sdk/server/gateway && GATEWAY_HOSTNAME=127.0.0.1 bun run gateway` | `ws://localhost:7780` |

Differences from the commands in `vendor/rs-sdk/README.md`:

- `BUILD_VERIFY=false`: rs-sdk changes the game content, so the first cache pack fails the upstream checksum check (`.loc checksum mismatch!`). The rs-sdk `server/Dockerfile` and `server/PATCHES.md` set the same value.
- `GATEWAY_HOSTNAME=127.0.0.1`: the gateway port 7780 listens on loopback only. This does not close port 8888, which relays to the gateway.
- The gateway starts after the bot page answers 200 and the bot client bundle exists. The gateway imports engine source files that need the `bun install` of the engine.

The first start packs the game cache. This takes about a minute on a fast desktop, and longer on a small machine. Later starts use the packed cache.

`dev-stack.sh` writes the process group IDs to `measurements/raw/dev-stack.pids`. `stop` sends SIGTERM to each group, waits up to 10 s, then sends SIGKILL. If a start fails, the script stops the parts that it started.

If the start fails:

- Read `measurements/raw/dev-stack-<part>.log` for the part that the error names.
- If the script says "dev stack already started", run `bash scripts/dev-stack.sh stop`.
- If a slow machine needs more than 30 minutes, set `DEV_STACK_TIMEOUT_S`.

## Scripts

Scripts that you run:

| Script | Purpose | Platform | Arguments | Output |
|---|---|---|---|---|
| `scripts/dev-stack.sh` | Starts or stops the local stack. | Linux (WSL2 included) | `start`, `stop` | Logs in `measurements/raw/` |
| `scripts/proxy-proof.ts` | The proxy proof: runs the template script through the proxy and takes one frame. | Linux (WSL2 included) | `local` or `demo` | One JSON line, `proof-<mode>-child.log`, `proof-<mode>.png` |
| `scripts/measure.ts` | Measures RAM and CPU of one account. | Linux (WSL2 included) | `local` or `demo`, `--quick` | A table, `measure-<mode>-<date>.json`, `measure-<mode>-<date>-box.log` |
| `scripts/idle-test.ts` | Tests if an idle account stays logged in, and times a re-login. | Linux (WSL2 included) | `local` or `demo`, `idle` or `relogin`, `--quick` | JSON lines, a console log |
| `scripts/server-bootstrap.sh` | Prepares an Ubuntu server. See [deploy-server.md](deploy-server.md). | Ubuntu 26.04 | a phase | Progress lines |
| `scripts/ai-check.ts` | One real call chain to the Anthropic API through the agent loop, with a fake game. It costs a few cents. `AI_CHECK_FULL=1` sends the real SDK reference and prints the cache tokens (about $0.08). | any | none. Load `secrets/bot.env` in a subshell first. | Lines on stdout |
| `scripts/box-check.ts` | Runs jobs through the real job runner as `BOX_USER`, and checks that a job cannot read the secrets of the bot. | Linux | none. Run as the bot user with `BOX_USER=<user>`. | One JSON line. Exit code 0 when every check passed. |
| `scripts/live-check.ts` | Live check of the served game client and of the gateway, in one session of less than 3 minutes. | Linux | `local` or `demo` | `live-check-<mode>-<date>.json` |
| `scripts/seed-check.ts` | Runs each seed script on the local stack as a job, with a short limit. | Linux (WSL2 included), local stack only | none. Optional: `SEED_CHECK_MS`, `SEED_ONLY`, `SEED_DIR`. | One JSON line per script and a summary line, `seed-check-<name>.txt` |

[running-the-bot.md](running-the-bot.md) describes `scripts/bot-smoke.ts`. [deploy-server.md](deploy-server.md) describes the other `scripts/server-*.sh` scripts.

Support files:

| File | Content |
|---|---|
| `scripts/proof-script.ts` | The template script. A copy of the rs-sdk script template (see `THIRD_PARTY_NOTICES.md`). |
| `scripts/box-standin.ts` | The box stand-in of `measure.ts`: it loads the SDK, connects, and waits. `measure.ts` starts it. |
| `scripts/run-helpers.ts` | Helpers of the scripts: the modes, the boot token, the redaction, and the command and the environment of the box stand-in. |
| `scripts/open-shim.d.ts` | A type declaration for the package `open`, which the SDK imports and this repository does not install. |

All output goes to `measurements/raw/`, which git ignores. The PNG files are pictures of the game. Do not commit or post them, because this repository holds no game content.

## Proxy proof

```bash
bash scripts/dev-stack.sh
RS_ACCOUNT=prooflocal RS_PASSWORD=x bun scripts/proxy-proof.ts local
bash scripts/dev-stack.sh stop
```

`RS_PASSWORD=x` is a dummy for the local stack only.

`scripts/proxy-proof.ts` does these steps:

1. It opens the bot page in headless Chromium and waits until the game tab is in game.
2. It starts the proxy with a random boot token of 32 characters.
3. It runs the template script (`scripts/proof-script.ts`) in a child process, the box stand-in. The environment of the child holds the boot token, not the game password.
4. It writes the child output to `measurements/raw/proof-local-child.log`, and one frame to `measurements/raw/proof-local.png`.
5. It prints one JSON line.

### Expected output

```json
{"mode":"local","childExitCode":0,"childSawState":true,"tapFrames":62,"upstreamConnects":1,"passwordInChildEnv":false,"framePngBytes":231214}
```

| Field | Meaning |
|---|---|
| `childExitCode` | The exit code of the child. 0 is success. |
| `childSawState` | True if the SDK in the child held a game state at the end. |
| `tapFrames` | The count of state messages that the state tap received. It varies. |
| `upstreamConnects` | The count of connections from the proxy to the gateway. 1 is normal. |
| `passwordInChildEnv` | Must be false. The script checks the environment that it built for the child. It does not read the environment of the running child. |
| `framePngBytes` | The size of the frame. It varies. |

The script exits with code 0 only if `childExitCode` is 0 and `tapFrames` is above 0.

On the local stack, the template script finds a tree and chops it. The child log then has the line "You get some logs."

**Exit code 0 does not prove that an action succeeded.** It means that the child connected and that state messages arrived. If the map is still loading, the script finds no tree and sends no action. Read the child log. [security.md](security.md) lists this gap.

## Scripts that contact a remote game server

> **Warning.** Mode `demo` logs an automated account in to a remote game server. With the default configuration, that is the rs-sdk demo world, which someone else runs.

You do not need mode `demo` for development. Use the local stack. [measurements.md](measurements.md) has the results of one run of `measure.ts` and `idle-test.ts` on the demo world. Do not repeat them on the demo world.

Before you use mode `demo` on the demo world, ask the rs-sdk maintainer. See "Be a good guest on the demo world" in the [README](../README.md).

Facts about a remote rs-sdk game server:

- The first login with an unknown name creates that account permanently.
- The account name is public.
- Nobody can recover a lost password.
- One account allows one game client. A second login removes the first.

What the scripts do there:

- `measure.ts demo` holds a session for about 13 minutes. In every mode, it calls `keepAlive()` every 60 s. That call resets the idle timer of the client, so the 10-minute idle logout of the client cannot occur during the run.
- `idle-test.ts demo idle` holds a session for about 50 minutes.
- After a session ends, wait more than 10 s before a new login. `reloginDelayMs()` waits 20 to 30 s. The proxy connects to the gateway again after 11 to 16 s. One step of `idle-test.ts` waits a fixed 15 s.

The scripts refuse mode `demo` in these cases:

- `RS_ALLOW_DEMO` is not `1`.
- The account name is `prooflocal`.
- The password has fewer than 12 characters.

Never type a real password on a command line, because it stays in the shell history. Load it from the account file in a subshell. Then the password does not stay in the environment of your shell session:

```bash
( set -a; . secrets/account.env; set +a; bun scripts/proxy-proof.ts demo )
```

This command stops with a message, because `RS_ALLOW_DEMO` is not set. Put `RS_ALLOW_DEMO=1` before `bun` only if the person who runs the game server agreed, or if you run that server.

[deploy-server.md](deploy-server.md) shows how to create `secrets/account.env` on your server.

After a killed run, remove the directories named `/tmp/puppeteer_dev_chrome_profile-*`. A Chrome profile holds the game password.
