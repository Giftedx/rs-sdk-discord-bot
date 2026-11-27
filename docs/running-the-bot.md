# Run the Discord bot

This page tells you how to configure, start and update the bot. The bot is one process, `src/bot/main.ts`. It serves one Discord channel, or one channel per guild from `GUILDS_FILE`. Each guild has its own account, game tab, proxy, job runner, saved scripts and queue. All guilds share one browser, one Anthropic client, one SQLite database (`DATA_DIR/bot.sqlite`), one card tab and one spend cap.

## What you need

- Linux or WSL2 Ubuntu with Bun. See [development.md](development.md).
- A game server. For a first run, use the local stack. Use the demo world only after you read "Be a good guest on the demo world" in the [README](../README.md).
- A Discord application with a bot user.
- An Anthropic API key, and a monthly spend cap that you choose.

## 1. Make the Discord application

1. In the Discord developer portal, make a new application.
2. On the **Bot** page, reset the token and copy it. This is `DISCORD_TOKEN`. Keep it secret.
3. On the same page, enable **Message Content Intent** and save. Without it, the bot answers only messages that mention it, and logs a line at start.
4. On the **OAuth2** page, make an invite URL with the scope `bot` and these permissions: View Channels, Send Messages, Read Message History, Add Reactions, Attach Files, Manage Messages (to pin the status card), Create Public Threads and Send Messages in Threads (for the adventure log and the gallery). The bot also asks for the Guild Message Reactions intent. It needs no portal setting.
5. Open the URL and add the bot to your Discord server.
6. In Discord, enable Developer Mode. Right-click the channel for the bot and copy its ID. This is `DISCORD_CHANNEL_ID`.

## 2. Settings

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `RS_ACCOUNT`, `RS_PASSWORD` | yes, without `GUILDS_FILE` | | The account. See [.env.example](../.env.example). |
| `RS_SERVER_HOST`, `RS_GATEWAY_URL`, `RS_BOT_PAGE_URL` | | demo world | The game server. |
| `RS_ALLOW_DEMO` | for the demo world | | Must be `1` when the game server is the demo world. |
| `RS_FPS` | | `15` | Frame rate of the game tab, from 10 to 50. |
| `RS_CHROME_PATH` | | the Chrome of puppeteer | Absolute path to the Chrome binary. On a server, `scripts/server-bootstrap.sh` writes it to `server.env`. |
| `DISCORD_TOKEN` | yes | | The bot token. |
| `DISCORD_CHANNEL_ID` | yes, without `GUILDS_FILE` | | The one channel where the bot listens and posts. |
| `GUILDS_FILE` | | | A JSON file with one entry per guild. With it, the bot ignores `RS_ACCOUNT`, `RS_PASSWORD`, `DISCORD_CHANNEL_ID`, `DISCORD_ALLOWED_ROLE_ID` and `DISCORD_ALLOW_EVERYONE`. See "Several channels". |
| `DISCORD_ALLOWED_ROLE_ID` | yes, or the next row | | Only members with this role can give and stop instructions. |
| `DISCORD_ALLOW_EVERYONE` | | | `1` lets every member of the channel give and stop instructions. |
| `ALERT_CHANNEL_ID` | | unset | A private operator channel. If a unit fails and is still not active 5 minutes later, `rs-alert@.service` posts one warning there, at most once per unit per hour. A unit that systemd restarts in that time gets only a journal line. The script refuses `DISCORD_CHANNEL_ID`. Unset: journal only. |
| `ANTHROPIC_API_KEY` | yes, or the next row | | The API key. |
| `ANTHROPIC_AUTH_TOKEN` | | | A bearer token in place of the API key. `@anthropic-ai/sdk` reads it. The bot removes it from its logs and its Discord text. |
| `AI_MODEL` | | `claude-sonnet-5-5` | The model of the main loop. |
| `AI_EFFORT` | | `medium` | `low`, `medium`, `high`, `xhigh` or `max`. Higher effort costs more. |
| `AI_MAX_TURNS` | | `25` | Model calls per instruction. |
| `AI_MAX_INSTRUCTION_USD` | | `2` | Spend limit per instruction, in USD. |
| `AI_MAX_INSTRUCTION_MIN` | | `120` | Time limit of one instruction, in minutes (1 to 1440). The loop checks it before each turn and stops with "This instruction used its time limit". Job timeouts are cut to the time that is left. |
| `AI_MAX_JOB_MIN` | | `15` | The longest job, in minutes (1 to 60). The `run_code` and `run_script` tools offer timeouts up to this value. The job runner stops a job at it. |
| `NOTES_REVIEW_HOUR_UTC` | | unset | Hour (0 to 23, UTC) of a daily review wake on `ESCALATION_MODEL`, with no game tools. The AI tidies its notes and adds a diary line. It runs only when no job runs and the budget and the hourly wake limit have room. Unset: no review. |
| `AI_MONTHLY_CAP_USD` | | `30` | At this spend in one period (UTC), the bot takes no new instructions. Each guild gets an equal share (cap / guilds). At 80% of the share or of the cap, the main loop runs on `SMALL_MODEL` with no escalation. |
| `SPEND_RESET_DAY` | | `1` | Day of the month (1 to 28) when the spend period starts. The daily allowance for timer and trigger wakes is the cap that is left divided by the days left in the period, today included. Unused spend carries over. |
| `ESCALATION_MODEL` | | `claude-opus-5-5` | With the `escalate` tool, the AI can move the rest of one instruction to this model, once. A trigger wake (low HP, death) starts on this model. `none` disables escalation. |
| `SMALL_MODEL` | | `claude-haiku-5-5` | Decides if a channel message talks to the bot, and answers short questions. |
| `DISCORD_READ_ALL` | | `1` | `0` makes the bot answer only messages that mention it or reply to it. |
| `WATCHDOG_MINUTES` | | `5` | The watchdog stops a job that changes no XP, position or inventory for this time. |
| `DATA_DIR` | | `data` | Holds `bot.sqlite` (queue, spend, events, snapshots, timers) and, per guild, the saved scripts, notes and job files. |
| `GAMELINK_IDLE_GUARD` | | `1` | `0` disables the reset of the 10-minute idle logout. |
| `QUEUE_MAX` | | `5` | Instructions that can wait. |
| `USER_COOLDOWN_S` | | `30` | Seconds between two instructions of one user. |
| `BOX_USER` | yes, or the next row | | Runs each job as this Unix user through `sudo`. See "The box user". |
| `BOT_ALLOW_UNSANDBOXED` | | | `1` lets the bot start without `BOX_USER`. Jobs can then read the secrets of the bot. For local development only. |
| `BOX_BUN_PATH` | | `/usr/local/bin/bun` | The Bun binary that the box user runs. |
| `JOB_MEMORY_MB` | | `1024` | Memory limit of all jobs together, when the job cgroup is available. |
| `JOB_PIDS` | | `256` | Process limit of all jobs together. |
| `JOB_CPU_PERCENT` | | `100` | CPU limit of all jobs together, in percent of one CPU. Needs the `cpu` controller. |
| `DISCORD_POSTS_PER_HOUR` | | `4` | Milestone posts per hour and guild, the recap included. `0` disables them. |
| `MILESTONE_LEVELS` | | `10,25,50,75,90,99` | The skill levels that get a main-channel post. Level-ups within 60 s merge into one post. |
| `DISCORD_RECAP_HOUR_UTC` | | unset | Hour (0 to 23, UTC) of the daily recap post. Unset: no recap. |
| `DISCORD_LOG_THREAD` | | `adventure-log` | Name of the adventure log thread. |
| `DISCORD_GALLERY_THREAD` | | `gallery` | Name of the gallery thread. It must differ from `DISCORD_LOG_THREAD`. |
| `DISCORD_SILENT` | | unset | `1` sends every post with no notification. `0` notifies on every post. Unset: the adventure log and the gallery are silent, and the main posts notify. |
| `DISCORD_CARDS` | | `1` | `0` disables the drawn cards. The daily recap then has no XP chart. |
| `PROXY_PORT` | | `7790` | Loopback port of the proxy. With `GUILDS_FILE`, guild number *n* (from 0) uses `PROXY_PORT` + *n*. |
| `GAMELINK_SOCKET` | | unset | Split mode: the Unix socket of gamelink. With it, the bot opens no browser and does not need `RS_PASSWORD`. See "Split mode". In gamelink, the default is `/run/rs-gamelink/gamelink.sock`. |
| `GAMELINK_TOKEN_FILE` | with `GAMELINK_SOCKET`, and in gamelink | | Absolute path to a file with one token of at least 32 characters. Every request to the socket must carry it. |

The spend is an estimate from the token counts and the list prices in `src/agent/spend.ts`. Set a spend limit in the Anthropic console too.

## The box user

Each job runs in a child process. Without a box user, that process runs as the bot user. It can then read the secret files and the environment of the bot: the Discord token, the API key and the game password. Set a box user on every machine that holds real secrets. The bot refuses to start without `BOX_USER`, unless `BOT_ALLOW_UNSANDBOXED=1`.

With `BOX_USER=rsbox`, the job runner starts each job with `sudo -n -u rsbox`. The runner gives the boot token in the environment, not on the command line. After each job, the runner kills every process of `rsbox`.

As root, replace `rsbot` with the user that runs the bot, and run:

```bash
useradd -m -s /usr/sbin/nologin rsbox
install -m 755 /home/rsbot/.bun/bin/bun /usr/local/bin/bun
echo 'rsbot ALL=(rsbox) NOPASSWD:SETENV: /usr/local/bin/bun, /usr/bin/pkill' > /etc/sudoers.d/rsbox-jobs
chmod 440 /etc/sudoers.d/rsbox-jobs
visudo -cf /etc/sudoers.d/rsbox-jobs
```

`rsbox` must be able to read the repository and the job directory `data/jobs`. It must not be able to read `secrets/`. Keep that directory at mode 700. Add `BOX_USER=rsbox` to `secrets/bot.env`.

To check the box user, run the smoke test (section 4) with `BOX_USER=rsbox`. The checks `boxCannotReadBotFile` and `boxCannotReadParentEnv` must be `true`.

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

`x` is a dummy password. The local stack accepts any password. Make the box user first (see "The box user").

In the channel, write `hi rs-bot, what can you do?`.

## 4. Smoke test without Discord

`scripts/bot-smoke.ts` runs the agent loop with a scripted model on the local stack. It needs no Discord token and no API key, and it costs nothing. It runs real rs-sdk code through the proxy, takes a frame from the frame store, saves and runs a script, and logs out. It also checks the browser profile on tmpfs, the seed scripts, the spend rows, a snapshot in SQLite and a drawn receipt card.

```bash
bash scripts/dev-stack.sh start
RS_ACCOUNT=smokelocal RS_PASSWORD=x bun scripts/bot-smoke.ts
bash scripts/dev-stack.sh stop
```

The last line of stdout is JSON. Each value under `checks` must be `true`.

## 5. Use it in Discord

People talk to the bot in plain words, with or without an @mention. There are no commands.

- A small model reads each message and decides if it talks to the bot. Talk between people about the bot gets no answer.
- A request to do something in the game goes to the queue. The bot adds a check mark if nothing runs, or an hourglass if the request waits.
- A thumbs-up on a waiting request moves it up one place. Each member counts once per request. Only members who may give instructions count. The votes are in memory. The new order is in the database.
- A question, such as "what are you doing?", gets a short answer at once.
- "Stop that" ends the current request and kills its job.
- The **Status** button of the status card shows what runs, the goal, the queue, the timers, the spend and the game state.

For each instruction, the bot posts one message and edits it with progress. At the end, the message has the summary, the cost, a drawn receipt card and a frame.

Other output in the channel:

- **Status card**: one pinned message. While an instruction runs, the bot edits it every 15 s. It shows the goal, the current step, the HP, the queue length, the spend and a recent frame.
- **Adventure log**: a thread (`DISCORD_LOG_THREAD`) in the first person ("I reached Attack 20.", "I finished a request for Sam ..."). It has level-ups, item gains, deaths, receipts, wakes and the `post` lines of the AI. Item gains within 60 s become one line ("I got 14 x Logs."). If the last message of the thread is less than 2 minutes old, the bot adds the next batch to it.
- **Gallery**: a thread (`DISCORD_GALLERY_THREAD`) with a frame or a close portrait of the character for each death and each skill milestone (`MILESTONE_LEVELS`). At most 6 an hour.
- **Posts**: a message with a drawn card when a skill passes a level of `MILESTONE_LEVELS`, for a death and for the daily recap. A death post also has the portrait. The recap has an XP chart of the last 24 hours. At most `DISCORD_POSTS_PER_HOUR` per hour.

The bot also wakes the AI with no human request. A wake comes on a timer that the AI set (1 to 1440 minutes, with a note), at HP below 30%, after a death, for a stuck job and for the daily review (`NOTES_REVIEW_HOUR_UTC`). A full inventory (28 of 28) wakes the AI at most once in 30 minutes, and only when nothing else runs or waits. Each wake is an instruction in the queue. Each guild gets at most 6 timer and trigger wakes per hour, and only while the daily allowance has room.

The queue is in the database. A restart stops the current job. After the restart, its instruction starts again from the queue. An instruction that was running at 3 restarts does not start again: the bot marks it stopped, so a request that crashes the bot cannot run without end.

Every job has built-in protections. At HP 40% or less, the job eats the food that heals most. At 25% or less with no food, it runs away. The AI can disable them in a job with `protections.off()`. At start, the bot copies the seed scripts from `seed/` to the saved scripts of each guild. It does not overwrite a script with the same name.

## 6. Run on your server

First prepare the server with [deploy-server.md](deploy-server.md), and make the box user. Then, as rsbot in `/opt/rs-discord-bot`:

1. Write `secrets/bot.env` with `DISCORD_TOKEN`, `DISCORD_CHANNEL_ID`, `ANTHROPIC_API_KEY`, `BOX_USER=rsbox`, and `RS_ALLOW_DEMO=1` if the game server is the demo world. Set its mode to 600.
2. Make the data directory: `mkdir -p data && chmod 755 data`.

Then, as the admin user, install one of the two bot units:

| Unit | Mode | Limits |
|---|---|---|
| `rs-discord-bot.service` | Split mode. `Wants=rs-gamelink.service`, so the bot keeps running while gamelink restarts. | `ProtectSystem=strict`, `ProtectProc=invisible`, `ProcSubset=pid`. No access to `/opt/rs-chrome` or to the account file. It cannot open a browser. |
| `rs-discord-bot-single.service` | One process, with the browser in the bot. `Conflicts=rs-discord-bot.service rs-gamelink.service`. | Looser. Use its own name in the commands below. |

After a change to a unit file, copy it again and run `sudo systemctl daemon-reload`. Run `sudo systemd-analyze verify /etc/systemd/system/rs-discord-bot*.service` once. `ProtectProc` and `ProcSubset` need systemd 247 or later.

One-process mode:

```bash
sudo cp /opt/rs-discord-bot/deploy/systemd/rs-discord-bot-single.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rs-discord-bot-single
journalctl -u rs-discord-bot-single -f
```

Split mode (first do the steps in "Split mode"):

```bash
sudo cp /opt/rs-discord-bot/deploy/systemd/rs-discord-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rs-discord-bot
journalctl -u rs-discord-bot -f
```

To stop the bot, run `sudo systemctl stop rs-discord-bot`. The bot logs the account out of the game before it exits.

### Update a running server

Do these steps on your own machine, in a clone of this repository, with the new commit on `main`.

1. Run `bunx tsc --noEmit` and `bun test`. Do not deploy a commit that fails.
2. Push the commit to the bare repository on the server:

   ```bash
   git push --receive-pack='sudo -u rsbot git-receive-pack' <user>@<server>:/home/rsbot/repo.git main
   ```

3. Update the clone. Phase `install` runs `git reset --hard origin/main` and `bun install --frozen-lockfile`. The reset deletes local changes to tracked files. It keeps `secrets/` and `data/`, because they are not in git.

   ```bash
   ssh <user>@<server> 'sudo bash -c "$(cat)" bootstrap install main' < scripts/server-bootstrap.sh
   ```

4. If the commit changed a file in `deploy/systemd/`, copy that file to `/etc/systemd/system/` again and run `sudo systemctl daemon-reload`.
5. Restart the services. Stop the bot first, so that it stops its parts while gamelink still answers. The bot then waits up to 2 minutes for the new gamelink socket.

   ```bash
   ssh <user>@<server> 'sudo systemctl stop rs-discord-bot && sudo systemctl restart rs-gamelink && sudo systemctl start rs-discord-bot'
   ```

6. Check the log. The bot is ready when it logs `Discord ready as`.

   ```bash
   ssh <user>@<server> 'journalctl -u rs-discord-bot -u rs-gamelink --since -5min --no-pager'
   ```

## Several channels

Put one entry per guild in a JSON file, and set `GUILDS_FILE` to its path. The file holds no password. `passwordEnv` names the environment variable that holds the password.

```json
[
  { "name": "alpha", "channelId": "123456789012345678", "allowedRoleId": "223456789012345678",
    "account": "alphabot", "passwordEnv": "RS_PASSWORD_ALPHA" },
  { "name": "beta", "channelId": "323456789012345678", "allowEveryone": true,
    "account": "betabot", "passwordEnv": "RS_PASSWORD_BETA", "dataSubdir": "beta", "boxUser": "rsbox2" }
]
```

| Key | Required | Meaning |
|---|---|---|
| `name` | yes | Key of the guild in the database and the log. `^[a-z0-9_-]{1,32}$`. |
| `channelId` | yes | The channel of this guild. |
| `allowedRoleId` or `allowEveryone: true` | yes | Who can give and stop instructions. |
| `account` | yes | The account of this guild. Each guild needs its own account. |
| `passwordEnv` | yes | The name of the environment variable with the password. Put the variable in `secrets/bot.env`. |
| `dataSubdir` | | Folder under `DATA_DIR` for the scripts, notes and jobs. Default: `name`. |
| `boxUser` | | The box user of this guild. Default: `BOX_USER`. |

All guilds use the same game server settings (`RS_SERVER_HOST` and the URLs). Each guild gets its own proxy port, `PROXY_PORT` + its index.

After a job, the job runner kills every process of the box user. So guilds that share a box user run their jobs one at a time. To run jobs of several guilds at the same time, give each guild its own box user and its own sudoers line.

## Split mode

In split mode, the game parts run in a second process, gamelink (`src/gamelink/main.ts`), as the Unix user `rsgame`. Gamelink holds the game passwords and Chromium. The bot (`rsbot`) holds the Discord token and the API key, and opens no browser.

The bot talks to gamelink with HTTP and JSON through the Unix socket `/run/rs-gamelink/gamelink.sock`. Every request must carry `authorization: Bearer <token>`. The token is in `/etc/rs-gamelink/token`. The proxy ports stay on `127.0.0.1`, so the box user reaches the proxy as before.

Without `GAMELINK_SOCKET`, the bot runs the game parts in its own process.

Who can read what:

| File or socket | Owner and mode | rsgame | rsbot | rsbox |
|---|---|---|---|---|
| `/etc/rs-gamelink/` | `root:rsgate` 750 | enter | enter | no |
| `/etc/rs-gamelink/account.env` (game passwords) | `rsgame:rsgame` 600 | read | no | no |
| `/etc/rs-gamelink/gamelink.env` (optional, no secret) | `root:rsgame` 640 | read | no | no |
| `/etc/rs-gamelink/token` | `root:rsgate` 640 | read | read | no |
| `/run/rs-gamelink/` (made by systemd) | `rsgame:rsgate` 750 | write | enter | no |
| `/run/rs-gamelink/gamelink.sock` | `rsgame:rsgate` 660 | listen | connect | no |
| `/opt/rs-discord-bot/secrets/` (Discord token, API key) | `rsbot` 700 | no | read | no |
| `/opt/rs-discord-bot/server.env` (`RS_CHROME_PATH`) | `rsbot` 640 | no (gets `RS_CHROME_PATH` from `gamelink.env`) | read | no |

`rs-gamelink.service` runs with `Group=rsgate`, so the run directory and the socket get the group `rsgate`. `UMask=0007` gives other users no access to the files that gamelink makes.

Do these steps as root on the server. Do "The box user" first, because it installs `/usr/local/bin/bun`, which `rsgame` runs.

1. Make the user and the shared group:

   ```bash
   groupadd --system rsgate
   useradd -m -s /usr/sbin/nologin rsgame
   usermod -aG rsgate rsgame
   usermod -aG rsgate rsbot
   install -d -m 700 -o rsgame -g rsgame /home/rsgame/.cache
   ```

2. Set `/opt/rs-discord-bot` to mode 755. With mode 751, Bun (1.3.14) crashes with a segmentation fault while it loads `puppeteer`. `secrets/` stays 700 and `server.env` stays 640. Check that `rsgame` can read the repository but not `secrets/`:

   ```bash
   chmod 755 /opt/rs-discord-bot
   sudo -u rsgame test -r /opt/rs-discord-bot/src/gamelink/main.ts && echo repo-ok
   sudo -u rsgame test -r /opt/rs-discord-bot/secrets/bot.env || echo secrets-closed
   ```

   The output must be `repo-ok` and `secrets-closed`.

3. Move the game passwords to gamelink and make the token:

   ```bash
   systemctl stop rs-discord-bot
   install -d -m 750 -o root -g rsgate /etc/rs-gamelink
   mv /opt/rs-discord-bot/secrets/account.env /etc/rs-gamelink/account.env
   chown rsgame:rsgame /etc/rs-gamelink/account.env
   chmod 600 /etc/rs-gamelink/account.env
   ( umask 027; openssl rand -hex 32 > /etc/rs-gamelink/token )
   chown root:rsgate /etc/rs-gamelink/token
   chmod 640 /etc/rs-gamelink/token
   ```

   With `GUILDS_FILE`, put each `passwordEnv` variable in `/etc/rs-gamelink/account.env`. Remove `RS_PASSWORD` and the `passwordEnv` variables from `secrets/bot.env`.

4. Write the settings that both processes need. Gamelink reads `/etc/rs-gamelink/gamelink.env` (`root:rsgame`, mode 640). The bot reads `secrets/bot.env`. Use the same values in the two files.

   | Variable | Gamelink | Bot |
   |---|---|---|
   | `RS_ACCOUNT` | in `account.env` | yes, without `GUILDS_FILE` (not a secret) |
   | `RS_SERVER_HOST`, `RS_GATEWAY_URL`, `RS_BOT_PAGE_URL`, `RS_ALLOW_DEMO` | yes | yes |
   | `GUILDS_FILE`, `PROXY_PORT` | yes, and `rsgame` must be able to read the file | yes |
   | `RS_CHROME_PATH` (copy it from `server.env`), `RS_FPS`, `GAMELINK_IDLE_GUARD` | yes | no |
   | `DISCORD_CARDS` | yes (opens the card tab) | yes (asks for cards) |

   Add these lines to `secrets/bot.env`. The gamelink unit sets the same two variables itself.

   ```bash
   GAMELINK_SOCKET=/run/rs-gamelink/gamelink.sock
   GAMELINK_TOKEN_FILE=/etc/rs-gamelink/token
   ```

5. Install and start the units:

   ```bash
   cp /opt/rs-discord-bot/deploy/systemd/rs-gamelink.service /opt/rs-discord-bot/deploy/systemd/rs-discord-bot.service /opt/rs-discord-bot/deploy/systemd/rs-alert@.service /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now rs-gamelink
   journalctl -u rs-gamelink -n 20 --no-pager
   systemctl start rs-discord-bot
   journalctl -u rs-discord-bot -n 20 --no-pager
   ```

   The gamelink log must show `listening on /run/rs-gamelink/gamelink.sock`. The bot log must show `game parts in the gamelink process at /run/rs-gamelink/gamelink.sock`.

6. Check the separation:

   ```bash
   ls -ld /run/rs-gamelink /run/rs-gamelink/gamelink.sock
   sudo -u rsbot test -r /etc/rs-gamelink/account.env || echo bot-cannot-read-password
   sudo -u rsbox test -r /etc/rs-gamelink/token || echo box-cannot-read-token
   sudo -u rsbot curl -s -o /dev/null -w '%{http_code}\n' --unix-socket /run/rs-gamelink/gamelink.sock http://gamelink/guilds/main/status
   tr '\0' '\n' < /proc/$(pgrep -u rsbot -f src/bot/main.ts | head -n 1)/environ | grep -c '^RS_PASSWORD='
   ```

   Expected: `drwxr-x--- rsgame rsgate` and `srw-rw---- rsgame rsgate`, then `bot-cannot-read-password`, `box-cannot-read-token`, `401` (no token), and `0`.

How the two units behave:

- If gamelink stops, the bot keeps running and reconnects when gamelink is back. On SIGTERM, gamelink logs every account out of the game.
- A restart of the bot does not log the account out. Gamelink keeps the game session.
- At the start and end of each job, the job runner sets and clears the job flag of the proxy through the socket. It tries three times. If all three fail, the log shows `job flag not turned off`. The proxy does not clear the flag when the box socket closes, because the SDK in the box connects again during a job.
- At the end of each job, the bot waits up to 30 s until the gateway has answered every action of the job (`POST /guilds/:name/idle`). If actions are still in flight, the log shows `job ended with N actions in flight`.
- At start, gamelink takes a lock file (`gamelink.lock`, next to the socket). If another gamelink runs, it logs `start refused: ...` and exits with code 2. It takes over a lock with a dead pid.
- `systemctl kill -s HUP rs-gamelink` logs every tab out and logs in again after the normal delay. This also clears `login_refused` after you fix the account.
- `systemctl kill -s USR1 rs-gamelink` drops the gateway connection of each proxy and connects again at once.
- The proxy first tries the direct gateway port (7443 on the demo world). If the direct socket does not connect, it uses the relay URL. The status text shows the route: `Gateway connection: up (direct)` or `up (relay)`.
- `GET /guilds/:name/portrait` returns a 256x256 PNG of the centre of the view, or 204 when the tab is out of the game.
- Gamelink opens each game tab with no login. The first login comes 20 to 30 s later, at least 15 s after the login of the tab before. After a failed login, the delay is the re-login delay times 1, 2, 4, 8, then 16 at most.
- "Invalid username or password" or "account has been disabled" sets the tab to `login_refused`. Gamelink then stops all logins until it restarts, and the bot logs one `ALERT game login refused` line. The status card and the status text show the login message of the server.
- To go back to one process, stop both units. Move `account.env` back to `secrets/` (owner `rsbot`, mode 600). Remove the `GAMELINK_*` lines from `secrets/bot.env`. Disable `rs-discord-bot` and `rs-gamelink`. Install and start `rs-discord-bot-single.service`.

## Deploy scripts

These files are in `scripts/` and `deploy/systemd/`. They run as root on the server. Set the exec bit in git once: `git update-index --chmod=+x scripts/server-firewall.sh scripts/server-backup.sh scripts/server-revision-check.sh scripts/server-alert.sh scripts/server-chrome-prune.sh scripts/server-restore-test.sh`.

| What | Install | Notes |
|---|---|---|
| Game egress firewall | Install `rsgame-egress.service` and `rsgame-egress.timer`, then `systemctl enable --now rsgame-egress.service rsgame-egress.timer` | `scripts/server-firewall.sh game-egress` lets `rsgame` reach only loopback, DNS, and the game host on TCP 443 and 7443 (`GAME_PORTS`). The host is `RS_SERVER_HOST`, from the environment or `/etc/rs-gamelink/gamelink.env`. Open connections stay open. Every hour, the timer runs `game-egress-refresh`. If the host does not resolve, it keeps the old rules. With no rules and no resolved host, `rsgame` gets loopback and DNS only. After you enable it, look in the journal of `rs-gamelink` for refused connections to other hosts. |
| Box egress firewall | `sudo BOX_USERS=rsbox scripts/server-firewall.sh apply 7790`, then install and enable `rsbox-egress.service` | Each box user can reach only `127.0.0.1` on the proxy ports. IPv6 is closed for them. Modes: `apply [PORTS]`, `egress [PORTS]`, `game-egress`, `game-egress-refresh`, `status`, `undo [box|game] [--ufw]` (no word removes both). PORTS is one port, a range or a list (`7790`, `7790-7795`, `7790,7792`). With `GUILDS_FILE`, list every box user in `BOX_USERS` and give the range `PROXY_PORT` to `PROXY_PORT` + guilds - 1. Make `BOX_USERS` and `PROXY_PORTS` in `rsbox-egress.service` match. |
| Backup | Install `rs-backup.service` and `rs-backup.timer`, then `systemctl enable --now rs-backup.timer` | Backs up the SQLite files under `data/` with `sqlite3 .backup` (install `sqlite3`). Env: `APP_DIR`, `BACKUP_DIR` (default `/var/backups/rs-discord-bot`), `KEEP` (default 14). The script header has the restore steps. |
| Revision check | Install `rs-revision-check.service` and `.timer`, and enable the timer | If the bot page of the game server changes, it logs `REVISION CHANGED` (`journalctl -u rs-revision-check`), writes `data/revision-changed` and restarts `rs-gamelink` (split mode only, through `try-restart`). It posts nothing to Discord. The bot reads `data/revision-changed`, logs `game revision changed` once, deletes the file and draws the status cards again. |
| Old Chrome versions | `sudo scripts/server-chrome-prune.sh`, then again with `--apply` | Removes the versions under `/opt/rs-chrome` (`CHROME_ROOT`) other than the one in `RS_CHROME_PATH` (from the environment or `server.env`). It keeps a version that a running process uses, and skips symbolic links. With no flag, it only prints. |
| Restore test | `sudo scripts/server-restore-test.sh [ARCHIVE]` | Extracts the newest backup (or ARCHIVE) to a temporary directory. It checks `secrets/` and `data/bot.sqlite` with `PRAGMA integrity_check` and a table count, prints the sizes, and removes the directory. It writes nothing over live files. Exit 1 when a part is missing. |
| Job limits | `rs-discord-bot.service` has `Delegate=yes` | The bot makes one cgroup for all jobs and sets `JOB_MEMORY_MB`, `JOB_PIDS` and `JOB_CPU_PERCENT`. Without delegation, it logs one line and runs jobs with no limits. |

## Limits of this version

- Without `BOX_USER`, AI-written code can read the secrets of the bot. With `BOX_USER`, the job limits need `Delegate=yes`, and the network limit needs the firewall script. [security.md](security.md) lists the gaps.
- These parts ran live on a real Discord server: the status card, the posts with cards, the adventure log, questions and tasks. The daily recap, the gallery, the queue votes, and the paths for a refused login and a game update have unit tests only.
- The wake rate limit, the trigger state, the queue votes and the hourly post and gallery counts are in memory. A restart resets them. The daily recap reads the events table, so it survives a restart.
- All guilds use one game server.
