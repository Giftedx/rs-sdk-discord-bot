# Run the Discord bot

The bot is one process: `src/bot/main.ts`. It opens the game tab, keeps the account in the game, starts the proxy, and connects to Discord. People mention the bot with an instruction. The AI then writes and runs rs-sdk code in a child process, and replies in the channel with a summary and a frame of the game.

## What you need

- Linux or WSL2 Ubuntu with Bun. See [development.md](development.md).
- A game server. For a first run, use the local stack. Use the rs-sdk demo world only after you read "Be a good guest on the demo world" in the [README](../README.md).
- A Discord application with a bot user.
- An Anthropic API key, and a monthly spend cap that you choose.

## 1. Make the Discord application

1. Open the Discord developer portal and make a new application.
2. On the **Bot** page, reset the token and copy it. This is `DISCORD_TOKEN`. Keep it secret.
3. The bot needs no privileged intent. Messages that mention the bot include their text without the Message Content intent.
4. On the **OAuth2** page, make an invite URL with the scope `bot` and these permissions: View Channels, Send Messages, Read Message History, Add Reactions, Attach Files.
5. Open the URL and add the bot to your Discord server.
6. In Discord, turn on Developer Mode. Right-click the channel for the bot and copy its ID. This is `DISCORD_CHANNEL_ID`.

## 2. Settings

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `RS_ACCOUNT`, `RS_PASSWORD` | yes | | The game account. See [.env.example](../.env.example). |
| `RS_SERVER_HOST`, `RS_GATEWAY_URL`, `RS_BOT_PAGE_URL` | | demo world | The game server. |
| `RS_ALLOW_DEMO` | for the demo world | | Must be `1` when the game server is the demo world. |
| `DISCORD_TOKEN` | yes | | The bot token. |
| `DISCORD_CHANNEL_ID` | yes | | The one channel where the bot listens and posts. |
| `DISCORD_ALLOWED_ROLE_ID` | yes, or the next row | | Only members with this role can give and stop instructions. |
| `DISCORD_ALLOW_EVERYONE` | | | `1` lets every member of the channel give and stop instructions. |
| `ANTHROPIC_API_KEY` | yes | | The API key. |
| `AI_MODEL` | | `claude-opus-5-5` | The model ID. `claude-sonnet-5-5` costs half as much per token. |
| `AI_EFFORT` | | `medium` | `low`, `medium`, `high`, `xhigh` or `max`. Higher effort costs more. |
| `AI_MAX_TURNS` | | `25` | Model calls per instruction. |
| `AI_MAX_INSTRUCTION_USD` | | `2` | Spend limit per instruction, in USD. |
| `AI_MONTHLY_CAP_USD` | | `30` | At this spend in one calendar month (UTC), the bot takes no new instructions. |
| `DATA_DIR` | | `data` | Saved scripts, notes, the spend record and job files. |
| `GAMELINK_IDLE_GUARD` | | `1` | `0` turns off the reset of the 10-minute idle logout. |
| `QUEUE_MAX` | | `5` | Instructions that can wait. |
| `USER_COOLDOWN_S` | | `30` | Seconds between two instructions of one user. |
| `BOX_USER` | yes, or the next row | | Run each job as this Unix user through `sudo`. See "The box user". The bot refuses to start without it. |
| `BOT_ALLOW_UNSANDBOXED` | | | `1` lets the bot start without `BOX_USER`. Jobs can then read the secrets of the bot. For local development only. |
| `BOX_BUN_PATH` | | `/usr/local/bin/bun` | The Bun binary that the box user runs. |

The spend is an estimate from the token counts and the list prices in `src/agent/spend.ts`. Set a spend limit in the Anthropic console too.

## 3. Run on the local stack

Keep the secrets in a file that git ignores, and load it only for the command:

```bash
mkdir -p secrets && chmod 700 secrets
cat > secrets/bot.env <<'EOF'
DISCORD_TOKEN=paste-the-token
DISCORD_CHANNEL_ID=123456789012345678
ANTHROPIC_API_KEY=paste-the-key
RS_ACCOUNT=localbot
RS_PASSWORD=x
RS_GATEWAY_URL=ws://localhost:7780
RS_BOT_PAGE_URL=http://localhost:8888/bot
RS_SERVER_HOST=localhost
BOX_USER=rsbox
DISCORD_ALLOWED_ROLE_ID=123456789012345678
EOF
chmod 600 secrets/bot.env
bash scripts/dev-stack.sh start
( set -a; . secrets/bot.env; set +a; bun run bot )
```

`x` is a dummy password. The local stack accepts any password.

In the channel, write `@bot help`.

## 4. Use it in Discord

- `@bot <instruction>`: for example `@bot chop trees until 10 woodcutting`. The bot adds a reaction: a check mark when it starts at once, an hourglass when the instruction waits.
- `@bot status`: what runs, the queue, the spend this month, and the game state.
- `@bot stop` or the **Stop** button: ends the current instruction and kills its job.

The bot posts one message for each instruction. It edits that message with progress, then puts the summary, the cost and a frame of the game in it.

## The box user

AI-written code runs as a job in a child process. Without a box user, that child runs as the bot user. Then it can read the secret files and the process environment of the bot: the Discord token, the API key and the game password. Set a box user on every machine that holds real secrets.

With `BOX_USER=rsbox`, the job runner starts each job with `sudo -n -u rsbox`. The boot token goes through the environment, not the command line. After each job, the runner kills every process of `rsbox`, so no code of a job stays behind.

Setup, as root (replace `rsbot` with the user that runs the bot):

```bash
useradd -m -s /usr/sbin/nologin rsbox
install -m 755 /home/rsbot/.bun/bin/bun /usr/local/bin/bun
echo 'rsbot ALL=(rsbox) NOPASSWD:SETENV: /usr/local/bin/bun, /usr/bin/pkill' > /etc/sudoers.d/rsbox-jobs
chmod 440 /etc/sudoers.d/rsbox-jobs
visudo -cf /etc/sudoers.d/rsbox-jobs
```

`rsbox` must be able to read the repository and the job directory `data/jobs`. It must not be able to read `secrets/`: keep that directory at mode 700. Add `BOX_USER=rsbox` to `secrets/bot.env`.

To check it, run the smoke test with `BOX_USER=rsbox` (section 6). The checks `boxCannotReadBotFile` and `boxCannotReadParentEnv` must be `true`.

## 5. Run on your server

Prepare the server with [deploy-server.md](deploy-server.md) first, and make the box user. Then, as rsbot in `/opt/rs-discord-bot`:

1. Write `secrets/bot.env` with `DISCORD_TOKEN`, `DISCORD_CHANNEL_ID`, `ANTHROPIC_API_KEY`, `BOX_USER=rsbox`, and `RS_ALLOW_DEMO=1` if the game server is the demo world. Set its mode to 600.
2. Make the data directory: `mkdir -p data && chmod 755 data`.

As the admin user:

```bash
sudo cp /opt/rs-discord-bot/deploy/systemd/rs-discord-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rs-discord-bot
journalctl -u rs-discord-bot -f
```

To stop the bot, run `sudo systemctl stop rs-discord-bot`. The bot logs the account out of the game before it exits.

## 6. Smoke test without Discord

`scripts/bot-smoke.ts` runs the agent loop with a scripted model on the local stack. It runs real rs-sdk code through the proxy, takes a frame, saves and runs a script, and logs out. It needs no Discord token and no API key, and it costs nothing.

```bash
bash scripts/dev-stack.sh start
RS_ACCOUNT=smokelocal RS_PASSWORD=x bun scripts/bot-smoke.ts
bash scripts/dev-stack.sh stop
```

The last line of stdout is JSON. Each value under `checks` must be `true`.

## Limits of this version

- Without `BOX_USER`, AI-written code can read the secrets of the bot. With `BOX_USER`, a job has no memory, CPU or network limits. [security.md](security.md) lists these gaps.
- One account and one channel per process.
- No pinned status card, adventure log or drawn cards yet.
