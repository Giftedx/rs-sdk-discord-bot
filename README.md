# rs-sdk Discord bot

A Discord channel plays one game account together. People ask in plain words. An AI writes the game code, runs it, and reports back.

The game is the RuneScape-style server of [rs-sdk](https://github.com/MaxBittker/rs-sdk), a research kit for game bots. The bot uses Bun, TypeScript and Claude.

This is an independent project. It has no affiliation with rs-sdk, its maintainer, or Jagex Ltd.

## What people see

- **Ask.** "Chop some trees" or "get 40 fishing". The AI writes rs-sdk code, runs it, and tries again when it fails. A thumbs-up on a waiting request moves it up the queue.
- **Question.** "What are you doing?" gets a short answer.
- **Stop.** "Stop that" ends the current request.
- **Status card.** One pinned message: the task, HP, inventory, XP per hour, the queue, the spend, and a picture of the game.
- **Adventure log.** A thread with one line for each level, haul and death.
- **Posts.** A drawn card for each finished request, death and skill milestone, and a daily recap with an XP chart.

A small model reads each message and decides if it is for the bot. Talk between people gets no answer. There are no commands. Nobody can run admin actions from Discord.

## Status

The bot runs 24 hours a day on one small server, on the rs-sdk demo world. All seven milestones in [docs/roadmap.md](docs/roadmap.md) are built.

Spend stays low in three ways:

- The AI wakes only for a request, a finished job, a timer or an alarm such as low HP or a stuck job. A long task runs as a script with no AI in the loop.
- Sonnet does the routine work. Opus takes hard cases. Haiku sorts messages.
- A monthly cap, a daily allowance and an equal share for each Discord server. Above 80% of the cap, only the small model runs.

## How it works

Three processes run as three Unix users. Each holds only its own secrets.

```
  bot (rsbot)                              box (rsbox)
  Discord, AI, queue, database   ---->     one job: AI-written code
  holds: Discord token, API key            holds: a boot token only
       |                                        |
       | Unix socket + token                    | SDK protocol on 127.0.0.1
       v                                        v
  gamelink (rsgame): holds the game password
    game tab   headless Chromium, logged in to the game
    proxy      checks each action, adds the password
       |
       v
  rs-sdk game server
```

The AI's code never sees the game password. It gets a boot token, a random value that the proxy accepts instead. The firewall lets the box reach only the proxy. [docs/design.md](docs/design.md) has the full design and the terms.

## Quick start

You need git and [Bun](https://bun.sh) 1.3.14, the version that CI uses. On Ubuntu, first install the Chrome libraries listed in [docs/development.md](docs/development.md).

```bash
git clone --recurse-submodules https://github.com/Giftedx/rs-sdk-discord-bot.git
cd rs-sdk-discord-bot
bun install
bunx tsc --noEmit
bun test
```

The type check prints nothing. The tests end with `0 fail`. The clone includes the whole rs-sdk game server.

- If `bun test` finds no browser, run `bunx puppeteer browsers install chrome` once.
- If Chromium says `No usable sandbox!`, read "Tests that launch Chromium" in [docs/development.md](docs/development.md). Do not add `--no-sandbox`.

## Next steps

| To do this | Read |
|---|---|
| Run a game server on your own machine | [docs/development.md](docs/development.md) |
| Prepare an Ubuntu server | [docs/deploy-server.md](docs/deploy-server.md) |
| Install and run the bot | [docs/running-the-bot.md](docs/running-the-bot.md) |
| See CPU, RAM and cost numbers | [docs/measurements.md](docs/measurements.md) |
| Know the risks before you deploy | [docs/security.md](docs/security.md) |

## Be a good guest on the demo world

The default settings point at the rs-sdk demo world, `rs-sdk.maxbittker.com`. The rs-sdk maintainer runs it. The local commands in these documents never contact it.

These rules are stricter than the rs-sdk README:

- Ask the rs-sdk maintainer before you log an automated account in. Say that an AI drives it. An account that stays logged in all day is a heavier guest.
- Permission that someone else got does not cover you. Nothing in this repository gives you permission.
- Use one account.
- Do not spam the game chat. The proxy limits chat to 6 messages per minute but does not read the content.
- Do not depend on the demo world. It has no guarantee of uptime or of saved progress.

The scripts refuse the demo world unless `RS_ALLOW_DEMO=1` is set. To use your own game server, set `RS_SERVER_HOST`, `RS_GATEWAY_URL` and `RS_BOT_PAGE_URL`.

## Security

This project does not claim to be secure. Do not run it on a machine that holds anything you care about.

- The game password stays in gamelink. AI-written code gets a boot token.
- The proxy passes only allowed action types. It blocks direct actions on other players, chat commands, and every action while no job runs. It does not check the arguments of an action.
- Chromium always runs with its sandbox on.
- With `BOX_USER` set, jobs run as a separate Unix user and cannot read the bot's secrets. Without it (`BOT_ALLOW_UNSANDBOXED=1`, local development only), they can.

[docs/security.md](docs/security.md) lists the known gaps. [SECURITY.md](SECURITY.md) says how to report a vulnerability.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Run `bunx tsc --noEmit` and `bun test` before a pull request. Never commit a secret, edit `vendor/`, or add game art.

## Licence

MIT. See [LICENSE](LICENSE). rs-sdk (MIT) supplies the game server, the gateway, the browser client and the SDK. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) has the details.
