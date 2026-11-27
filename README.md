# rs-sdk Discord bot

A Discord bot that lets the people in one channel play a shared game account together. They talk to the bot in plain words, and an AI plays the account. The game is the RuneScape-style server emulator of [rs-sdk](https://github.com/MaxBittker/rs-sdk), a research kit for game bots. The code runs on Bun and TypeScript.

This is an independent project. It has no affiliation with rs-sdk, with its maintainer, or with Jagex Ltd, the owner of RuneScape. It uses rs-sdk (MIT licence) as a git submodule pinned at one commit.

## What it does

In its Discord channel, the bot reads every message. A small model decides which messages talk to the bot. Talk between people about the bot gets no answer.

- **Requests:** "chop some trees", "get 40 fishing", "buy an axe and bank the logs". The AI writes rs-sdk code, runs it as a job, reads the result and tries again when something fails. A thumbs-up on a waiting request moves it up the queue.
- **Questions:** "what are you doing?" gets a short answer at once.
- **Stop:** "stop that" ends the current request.
- **Status card:** one pinned message with the current task, HP, inventory, XP per hour, the queue, the monthly spend and a recent frame of the game.
- **Adventure log:** a thread with one first-person line for each level, item haul and death.
- **Posts:** the main channel gets a post with a drawn card for each finished request, a death, and a skill milestone. By default the milestones are levels 10, 25, 50, 75, 90 and 99 (`MILESTONE_LEVELS`). A daily recap has an XP chart, and a gallery thread keeps the pictures.

The AI keeps saved scripts, notes and a diary between restarts. It searches the rs-sdk learnings and the 2585 pages of the rs-sdk wiki. Built-in protections eat food at low HP and leave combat with no food. Triggers wake the AI on low HP, a death, a full inventory or a stuck job.

The bot has no commands, and nobody can run admin actions through Discord. The operator manages it on the server.

## Status

The bot runs 24 hours a day on one small server, in production on the rs-sdk demo world. All seven milestones of [docs/roadmap.md](docs/roadmap.md) are built. [docs/running-the-bot.md](docs/running-the-bot.md) says how to run it, and [docs/security.md](docs/security.md) lists the known gaps.

Cost control:

- Claude Sonnet 5.5 for routine work, Claude Opus 5.5 for escalation, and Claude Haiku 5.5 to sort messages.
- A monthly spend cap, a daily allowance with carry-over, an equal share for each Discord server, and only the small model above 80% of the cap.
- Prompt caching for the 26,000-token system prompt.

## Architecture

The bot runs as three kinds of process. Each runs as its own Unix user under systemd and holds different secrets.

```
  bot (rsbot)                               box (rsbox)
  Discord, AI loop, queue, database  ---->  one job: AI-written rs-sdk code
  holds: Discord token, API key             holds: a boot token, no secret
       |                                        |
       | Unix socket with a token               | SDK protocol on 127.0.0.1
       v                                        v
  gamelink (rsgame): holds the game password and Chromium
    game tab   headless Chromium on the rs-sdk bot page, kept in the game
    proxy      checks each action against the action policy,
               adds the game password, holds the one control connection
       |
       v
  rs-sdk game server and gateway
```

Firewall rules let the box reach only the proxy port, and let gamelink reach only the game host. [Terms](#terms) explains each name. [docs/design.md](docs/design.md) describes the whole design.


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
