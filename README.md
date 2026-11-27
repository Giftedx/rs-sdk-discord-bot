# rs-sdk Discord bot

**Work in progress. A first version of the Discord bot works. [docs/running-the-bot.md](docs/running-the-bot.md) says how to run it.**

The goal: the people in one Discord channel direct an AI, and the AI plays one shared game account. The game is the RuneScape-style server emulator of [rs-sdk](https://github.com/MaxBittker/rs-sdk), a research kit for game bots. The bot will show in Discord what the AI does. The code runs on Bun and TypeScript.

This is an independent project. It has no affiliation with rs-sdk, with its maintainer, or with Jagex Ltd, the owner of RuneScape. It uses rs-sdk (MIT licence) as a git submodule pinned at one commit.

## Status

What you can do today:

- Run the Discord bot (`bun run bot`, Linux) for one channel, or for several channels with `GUILDS_FILE`. People mention the bot with an instruction. The AI writes and runs rs-sdk code, and the bot replies with a summary, a drawn receipt card and a frame of the game. See [docs/running-the-bot.md](docs/running-the-bot.md).
- Run the tests and the type check (Windows or Linux).
- Start an rs-sdk game server on your own Linux machine and run an unchanged rs-sdk script against it through the proxy, which keeps the game password away from that script.
- Prepare an Ubuntu 26.04 server on which the same checks run with the Chromium sandbox on.

The bot, built and tested:

- The agent loop on the Anthropic API, with tools for jobs, saved scripts, notes, the knowledge pack, the game state and a frame, and with turn and spend limits (`src/agent/`).
- The job runner: AI-written code runs in a child process with only the boot token of the proxy, as a second Unix user, with the built-in protections and, with `Delegate=yes`, cgroup limits (`src/box/`). Seed scripts in `seed/`.
- The supervisor, which keeps the game tab in the game, the frame store, and the browser profile on tmpfs (`src/gamelink/`).
- The orchestrator: a SQLite database for the queue, spend, events, snapshots and timers, wakes on timers, low HP, death and a watchdog, and a daily allowance (`src/orchestrator/`).
- The Discord front end for one or more guilds: plain-language talk (a small model decides which messages are for the bot), a queue, a **Status** button, a pinned status card, an adventure log thread, milestone posts and a daily recap (`src/bot/`, `src/discord/`, `src/events/`).
- Drawn cards from a second browser tab (`src/cards/`, `src/gamelink/card-tab.ts`).
- A smoke test on the local stack (`scripts/bot-smoke.ts`), a check of the seed scripts (`scripts/seed-check.ts`), and systemd units and server scripts for the bot, the box firewall, the backup and the revision check (`deploy/systemd/`, `scripts/server-*.sh`).

Not yet run against a real Discord server: the multi-guild wiring. Built in the latest round and not yet run live: the wiki search, diary and personality of the AI, the time limit per instruction, the budget share per guild with the small-model mode at 80%, the deferred and backed-off game login, the wait for actions in flight after each job, the new status card lines and post cards, and the tighter bot unit. [docs/roadmap.md](docs/roadmap.md) has the details.

The base, built and tested:

- The configuration loader (`src/shared/config.ts`).
- The action policy (`src/gamelink/policy.ts`).
- The proxy, which holds the game password so that AI-written code never gets it (`src/gamelink/proxy.ts`).
- The game tab: headless Chromium on the rs-sdk bot page (`/bot`), with the Chromium sandbox on (`src/gamelink/game-tab.ts`).
- A measurement tool for RAM and CPU (`scripts/measure.ts`, `src/measure/proc.ts`).
- A script that starts the local stack (`scripts/dev-stack.sh`).
- The proxy proof: unchanged rs-sdk code plays through the proxy (`scripts/proxy-proof.ts`).
- An idle test and a re-login test (`scripts/idle-test.ts`).
- A bootstrap script for an Ubuntu server, with an AppArmor profile (`scripts/server-bootstrap.sh`).

Not built yet:

- A full sandbox for AI-written code: systemd limits and network rules.
- The pinned status card, the adventure log and the drawn cards.
- More than one account or guild per process.

[docs/roadmap.md](docs/roadmap.md) lists the milestones and their state.

## Architecture

The design has three kinds of process. Each kind holds different secrets. Today only parts of gamelink exist, and scripts stand in for the rest.

```
  PLANNED                                  PLANNED
  orchestrator  <------ jobs, results ---> box (runs AI-written code)
  holds: Discord token, API key            holds: a boot token, no secret
       |                                        |
       | state tap, pictures                    | SDK protocol on 127.0.0.1
       v                                        v
  gamelink: holds the game password
    game tab  (BUILT)   headless Chromium on the rs-sdk bot page
    proxy     (BUILT)   checks each action against the action policy,
                        adds the game password, holds the one control connection
       |                                        |
       v                                        v
  rs-sdk game server and gateway (the local stack, or a remote game server that you may use)
```

[Terms](#terms) explains each name. [docs/design.md](docs/design.md) describes the whole design and marks each part as built or planned.

## Quick start

You need git and [Bun](https://bun.sh) 1.3.14. That is the version that CI uses. Other versions are untested. On Ubuntu, first install the Chrome system libraries that [docs/development.md](docs/development.md) lists.

```bash
git clone --recurse-submodules https://github.com/Giftedx/rs-sdk-discord-bot.git
cd rs-sdk-discord-bot
bun install
bunx tsc --noEmit
bun test
```

`bunx tsc --noEmit` prints nothing. `bun test` ends with `0 fail`. 13 of the tests launch headless Chromium with its sandbox on.

The clone includes the whole rs-sdk game server, with a 27.5 MB collision file.

If it fails:

- If `bun test` reports that no browser is found, run `bunx puppeteer browsers install chrome` once. `bun install` normally downloads Chrome for Testing through puppeteer.
- If Chromium cannot start its sandbox (`No usable sandbox!`), read "Tests that launch Chromium" in [docs/development.md](docs/development.md). Do not add `--no-sandbox`.

## Run the local stack and the proxy proof

The local stack is an rs-sdk game server on your own machine. The proxy proof is a script that plays through the proxy: it logs a game tab in, starts the proxy, and runs an unchanged rs-sdk script that holds only the boot token.

Before you start, you need:

- Linux or WSL2, and a non-root user. Chromium does not start as root with its sandbox on.
- The system libraries in [docs/development.md](docs/development.md).
- Free ports 8888, 7780 and 7790.
- A development machine behind a firewall. The local stack serves the game on port 8888 on all network interfaces, with no authentication. Do not start it on a server that the internet can reach.

The first start packs the game cache. Wait for the line `dev stack ready`. This takes about a minute on a fast desktop.

```bash
bash scripts/dev-stack.sh
RS_ACCOUNT=prooflocal RS_PASSWORD=x bun scripts/proxy-proof.ts local
bash scripts/dev-stack.sh stop
```

`x` is a dummy password that only the local stack accepts.

Success is one JSON line with `"childExitCode":0` and `"passwordInChildEnv":false`, and the line `You get some logs.` in `measurements/raw/proof-local-child.log`.

[docs/development.md](docs/development.md) explains each step and each script.

## Deploy to your own server

`scripts/server-bootstrap.sh` prepares an Ubuntu 26.04 server: a service user, Bun, the code, a root-owned Chrome and one AppArmor profile. After the bootstrap, your server can run the tests, the proxy proof and the measurement tool. No service runs, because the bot does not exist yet.

[docs/deploy-server.md](docs/deploy-server.md) is the guide. It lists each change that the script makes and how to undo it.

In the reference run, one account used about 1.1 GB of RAM and 67% of one CPU core. [docs/measurements.md](docs/measurements.md) has the numbers.

## Be a good guest on the demo world

The default configuration points at the rs-sdk demo world, `rs-sdk.maxbittker.com`, which the rs-sdk maintainer runs. The documented local commands never contact it: mode `local` of the scripts always uses your own machine.

These are the rules of this project for the demo world. They are stricter than the rs-sdk README.

- rs-sdk invites bots on the demo world, but an account that stays logged in all day is a heavier guest. Ask the rs-sdk maintainer before you log an automated account in there, and say that an AI drives the account.
- A permission that someone else got does not cover you. Nothing in this repository gives you permission.
- Use one account.
- Do not spam the game chat. The action policy limits chat to 6 messages per minute, and it does not check the content.
- Do not depend on the demo world. The rs-sdk README says that it has no guarantee of uptime or of saved progress.

The alternative is your own rs-sdk server on a machine that you control. To use it, set `RS_SERVER_HOST`, `RS_GATEWAY_URL` and `RS_BOT_PAGE_URL`. The local stack of `scripts/dev-stack.sh` is for development on your own machine only. It is not a server for a deployment: it has no login check.

The scripts refuse mode `demo` unless `RS_ALLOW_DEMO=1` is set, the account name is not `prooflocal`, and the password has at least 12 characters.

## Terms

| Term | Meaning |
|---|---|
| the bot | The planned Discord bot. It does not exist yet. |
| account | The one game account that a Discord server shares. |
| bot page | The page `/bot` of an rs-sdk game server. It holds the rs-sdk browser client. |
| game tab | The bot page in headless Chromium. It stays logged in. |
| gateway | The rs-sdk service that connects SDK code to a game tab. |
| control connection | The one connection per account through which the gateway accepts actions. |
| gamelink | The process that holds the game password. It runs the game tab and the proxy. |
| proxy | The part between AI-written code and the gateway. It holds the game password. |
| action policy | The allow list of game actions that the proxy passes. |
| box | The process that runs AI-written code. It holds no secret. It is planned. |
| box stand-in | The child process that the scripts start in place of the box. |
| boot token | A random value that the proxy accepts from the box in place of the game password. It changes at each start. |
| job | One run of AI-written code in the box. |
| orchestrator | Planned. The process that talks to Discord and to the AI API. |
| state message | One `sdk_state` message: the game state that the game tab sends through the gateway. |
| state tap | The copy of each state message that the proxy gives to a callback of its host process. In the design, the orchestrator reads it. |
| frame | One picture of the game from the game tab. |
| local stack | An rs-sdk game server on your own machine. `scripts/dev-stack.sh` starts and stops it. |
| demo world | The public rs-sdk game server `rs-sdk.maxbittker.com`. |
| remote game server | Any rs-sdk game server that is not the local stack. The demo world is one. |
| proxy proof | The script `scripts/proxy-proof.ts` and its run. |
| template script | `scripts/proof-script.ts`, a copy of the rs-sdk script template. The proxy proof runs it. |
| Chromium, Chrome | Chromium is the browser engine. Chrome for Testing is the build of it that puppeteer downloads. These documents say Chromium for the sandbox and the behaviour, and Chrome for the binary and its path. |

## Security model

- The game password stays in the proxy and the game tab. AI-written code gets a boot token.
- The proxy passes only the action types on an allow list. It blocks direct actions on other players, client commands in chat, and every action that arrives while no run of AI-written code is active. It does not inspect the arguments of an action or the content of chat.
- Chromium always runs with its own sandbox. On Ubuntu that needs an AppArmor profile, and this profile does not confine Chrome.
- The box and the proxy are not separated yet: in the current scripts both run as one Unix user, so the box stand-in could read the password from the proxy process.
- This project does not claim to be secure. Do not run it on a machine that holds anything that you care about.

[docs/security.md](docs/security.md) has the trust boundaries, the residual risks and the known gaps. [SECURITY.md](SECURITY.md) tells you how to report a vulnerability.

## Roadmap

[docs/roadmap.md](docs/roadmap.md) has the seven milestones and what each delivers.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). In short:

- Run `bunx tsc --noEmit` and `bun test` before you open a pull request.
- Never print or commit a secret.
- Never edit `vendor/`.
- Never add game art, screenshots or recordings of the game.

## Licence and credits

This project has the MIT licence. See [LICENSE](LICENSE).

[rs-sdk](https://github.com/MaxBittker/rs-sdk) (MIT) supplies the game server, the gateway, the browser client and the SDK. `scripts/proof-script.ts` is a copy of the rs-sdk script template. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) has the details and the rs-sdk licence text.
