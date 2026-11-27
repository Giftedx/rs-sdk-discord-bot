# Security model

This page describes what the code does today, what it does not do, and what the design plans. It makes no claim that the project is secure.

**Do not run this project on a machine that holds anything that you care about.** The finished bot will run AI-written TypeScript on your server. Untrusted text from Discord and from game chat will steer that AI.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Trust boundary

The design has three kinds of process. [design.md](design.md) describes them.

| Secret | Holder | Never visible to | State |
|---|---|---|---|
| Discord token | orchestrator | gamelink, box | planned: the orchestrator does not exist |
| API key for the AI | orchestrator | gamelink, box | planned: the orchestrator does not exist |
| Game password | gamelink (proxy and game tab) | box | partly built, see below |

What "partly built" means:

- Built: the proxy holds the game password and accepts a boot token from the box. The scripts give the box stand-in an environment from an allow list. The allow list holds the boot token and never the game password. The scripts start the box stand-in with `--no-env-file`, so that Bun does not add the variables of a `.env` file to it. A test checks both.
- Not built: separate Unix users. In the current scripts, the box stand-in runs as the same Unix user as the proxy and the browser. It can read `/proc/<pid>/environ` of the parent and the Chrome profile. The separation is a design until the sandbox units exist.

## Untrusted input

The design treats four sources as untrusted: Discord users, game chat, the output of the box, and the files that the box writes.

A player in the game can try to direct the AI through game chat. The planned prompt will mark each untrusted text as data. That mark lowers the risk and does not remove it. The planned protection is the box: a successful injection gets only what the box has.

## What the proxy enforces

`src/gamelink/proxy.ts` and `src/gamelink/policy.ts`, with tests:

- The proxy listens on `127.0.0.1` only.
- The proxy refuses a connection that has a browser `Origin` header.
- A box connection must send the account name and the boot token within 5 s. The comparison of the token takes constant time.
- The proxy closes a box connection that sends a message above 64 KB, or a message that is not a JSON object.
- The proxy answers the `sdk_connect` of the box itself. The box never gets the game password, and a restart of the box makes no new login.
- From the box, the proxy forwards `sdk_action` messages only. From the gateway, it relays `sdk_state`, `sdk_action_result`, `sdk_info`, `sdk_connected`, and an `sdk_error` that arrives after the connection is ready.
- Each action goes through the action policy:
  - If no job runs, the policy refuses every action. The job flag starts as off.
  - The policy refuses `interactPlayer` and `spellOnPlayer`. In the pinned client, these are the actions for a direct attack on a player and a direct trade with a player.
  - The policy passes only the action types on an allow list. The list holds the types of the pinned rs-sdk client. A test compares the list with the client source.
  - The policy refuses a `say` or `privateMessage` text that starts with `::`, because the client sends such a text as a command.
  - The policy limits `say` and `privateMessage` to 6 messages per minute.
- The proxy forwards the same parsed object that the policy checked.
- When the connection to the gateway closes, the proxy connects again after 11 to 16 s.

Other protections in the current code:

- The game password never goes on a command line. The game tab passes it in the navigation URL only. A test checks the arguments of the browser process.
- The browser process does not get `RS_PASSWORD` in its environment.
- Navigation errors do not contain the URL, because the URL holds the password.
- Configuration errors name the variable only, never a value.
- The scripts pass all output of the box stand-in through a function that replaces the boot token and the password.
- The game tab blocks `POST /api/screenshot`, so the page cannot upload a picture to the public gallery of the game host.
- Chromium runs with its own sandbox. A test checks that the launch arguments hold no flag that disables it.
- The scripts refuse mode `demo` unless `RS_ALLOW_DEMO=1` is set.

## What the proxy cannot enforce

The action policy checks the action type, the `::` prefix and the chat rate. It does not inspect the other arguments of an action or the content of chat. So the policy cannot stop these:

- A sale of items at a low price on the Grand Exchange.
- A sale of items to a shop.
- A drop of items on the ground.
- A private message to any player, and any chat text, up to 6 messages per minute. There is no content filter.
- A walk into a dangerous area or into an area where players can attack the account.
- A different meaning of an allowed action type. The game tab runs the client that the game host serves. That client can differ from the pinned source that the test compares.

If you share an account with a channel, you accept that its members can make the AI waste the account's items.

The proxy also protects nothing on the local stack. The gateway of the local stack accepts any password, and a process on the same machine can connect to it directly. See "Residual risks".

## Residual risks

- **The local stack is open to the network.** By a reading of the rs-sdk source, the engine of the local stack listens on port 8888 on all interfaces. It serves the game, the bot page and a relay to the gateway, and the gateway of the local stack accepts any password. Use the local stack only on a development machine behind a firewall. [development.md](development.md) has the warning.
- **The AppArmor profile does not confine Chrome.** It is `flags=(unconfined)` with `userns`, and the Chrome copy has mode 755. Every local user on your server can run this Chrome. Untested, but likely: any local user can get user namespaces through it, for example with `LD_PRELOAD`. [deploy-server.md](deploy-server.md) has the detail and the removal commands.
- **The Chrome checksum is trust on first use.** Chrome for Testing publishes no SHA-256. The value in the bootstrap is from one download, whose MD5 matched a header of the storage object. Root downloads and unpacks the archive. The first execution of the binary is the version check, which runs as `rsbot`.
- **The Bun installer is not verified.** The bootstrap downloads it with `curl` and runs it as `rsbot`. The development guide does the same as your own user.
- **The admin user of the deployment guide has `sudo` without a password.** A stolen SSH key for that user gives root.
- **Chromium runs code from the game host.** A fault in Chromium is a risk for the process that holds the game password.
- **The game password is in the tab URL.** `buildBotUrl` puts it in the query of the bot page URL. It reaches the game host in the request line. The page stores it in `localStorage` (`vendor/rs-sdk/server/engine/view/bot.ejs`), and the URL is in the history of the Chrome profile.
- **A killed run can leave the password on disk.** The scripts set no profile directory, so puppeteer makes one in `/tmp`. A normal exit removes it. A killed run can leave `/tmp/puppeteer_dev_chrome_profile-*`.
- **The debug port of Chromium gives full control.** puppeteer uses a loopback debug port. Any local process that reaches it can read the tab URL with the password and control the tab.
- **An escape from the planned box** through a kernel fault.
- **A ban** of the account or of the server IP after behaviour that the proxy allows.
- **Prompt injection** that wastes API credit up to the spend cap, or that makes the AI write a bad saved script or a bad note. This applies to the planned agent loop.

## Known gaps in the current code

Each item is a plain limit of the code today. Each heading names the milestone of [roadmap.md](roadmap.md) that must close its items.

Proxy (`src/gamelink/proxy.ts`), milestone 2:

- Closed: the proxy closes a gateway socket that sends no `sdk_connected` within 10 s (`upstreamHandshakeTimeoutMs`), or no message for 60 s after the handshake (`staleMs`), and connects again after the normal delay. Tests check both with a fake gateway, not with a live gateway.
- Closed: after a refused login of the proxy, the delay doubles from the normal delay up to 5 minutes, and a successful connect resets it. `status()` of the proxy handle reports `connected`, `lastError` and `reconnects`. The bot does not show `status()` yet.
- The proxy has a `log` option, with one line for each gateway event. The log line holds the error text of the gateway, with the password removed, and never the raw message. The bot (`src/bot/guild.ts`) does not pass the option yet, so no line goes to the log of the bot.
- Closed: when more than 4 MB waits to go to the box, the proxy drops state messages for the box, and still sends other messages. At 8 MB, Bun closes the box socket. A test checks the drop with a socket that stops reading.
- The proxy forwards the whole action message of the box, not only the fields that the gateway reads.
- The proxy itself does not set the job flag to off when the box disconnects. The job runner of the bot (`src/box/job-runner.ts`) sets it to off after each job.
- The proxy relays the gateway text "another controller connected" to the box, and the SDK then stops its reconnects.
- The default reconnect delay of 11 to 16 s has no test.
- The proxy uses the relay URL of the gateway. The SDK prefers a direct gateway port with compression. One account relays about 82 kB/s of state at the measured message size.

Configuration (`src/shared/config.ts`), milestone 2:

- `RS_GATEWAY_URL` and `RS_BOT_PAGE_URL` accept any host and any scheme. A wrong value sends the game password to a different host, or over `ws://` or `http://` with no encryption.

Game tab (`src/gamelink/game-tab.ts`), milestone 2:

- Closed in the code: `inGame()` is true only when `gameClient.ingame === true` and `gameClient.sceneState === 2`. The fixture page has the field, but no test on a live page has confirmed that `sceneState` is 2 when the map is ready. See [measurements.md](measurements.md).
- Closed: the browser environment is now an allow list (`BROWSER_ENV_ALLOW` in `src/gamelink/game-tab.ts`), and the four secret names stay out of it.
- `close()` does not log the account out. The bot calls `logout()` before `close()` when it stops.
- The crash reporter is off (`--disable-crash-reporter`, `--disable-breakpad`). This was checked only by a clean start, not by a search for crash dumps.
- The bot puts the browser profile in a new directory under `/dev/shm` (mode 700) and removes it when the browser closes, so no profile with the password stays on disk. Without `/dev/shm` the profile goes to the temp directory, and the bot logs a warning.
- The request interception turns the browser cache off, so each reload downloads the client again.

Scripts (`scripts/`), milestone 2:

- `makeRedact` does not replace the URL-encoded form of a password, and it does not replace a password below 4 characters. The bootstrap makes passwords from `A-Za-z0-9`, which have no different encoded form.
- The security helpers `boxChildCommand`, `boxChildEnv`, `makeRedact` and `newBootToken` are in `scripts/run-helpers.ts`. They have tests and are in the type check, but later code in `src/` cannot import them from there cleanly.
- `scripts/proxy-proof.ts` exits with code 0 when no action was sent. Its field `passwordInChildEnv` reports on the environment that the script built, not on the running child.
- `scripts/measure.ts` calls `keepAlive()` every 60 s in every mode, mode `demo` included.
- The measurement scripts set no profile directory for Chromium, and they do not write the commit and the Chrome path into their result files. The bot and `scripts/bot-smoke.ts` use the tmpfs profile.

Bot (`src/bot/`, `src/agent/`, `src/box/`):

- **Without `BOX_USER`, a job runs as the same Unix user as the bot.** It can then read the secret files of the bot and `/proc/<pid>/environ` of the bot process, which hold the Discord token, the API key and the game password. So the bot refuses to start without `BOX_USER`, unless `BOT_ALLOW_UNSANDBOXED=1` is set for local development ([running-the-bot.md](running-the-bot.md)).
- With `DISCORD_ALLOW_EVERYONE=1` in place of `DISCORD_ALLOWED_ROLE_ID`, every member of the channel can give an instruction, and so start AI-written code. The bot refuses to start with neither.
- With `BOX_USER`, a job runs as a second Unix user through `sudo`. It can read every file that is readable by all users.
- Job limits: when the bot unit has `Delegate=yes`, the bot moves each job into one cgroup with memory, process and CPU limits for all jobs together (`src/box/cgroup.ts`). Without delegation the bot logs one line and the jobs have no limits. Not yet tested on a real systemd unit: the move of the `sudo` child into the job cgroup. A grandchild can start before the move.
- Network: `scripts/server-firewall.sh` lets each box user in `BOX_USERS` reach only the proxy ports on `127.0.0.1`. A box user that is not in that list has no network limit. A box user can reach the proxy ports of the other guilds too, but it needs their boot token to log in.
- Guilds that share a box user run their jobs one at a time, because the runner kills every process of the box user after a job. The jobs of one guild can see the processes of another guild that has the same box user only between these jobs.
- All text from the AI and the game goes through `sanitizeForDiscord` with no pings before Discord: the status card, the goal, the adventure log, the `post` lines of the AI, the posts and the instruction messages. Drawn cards put untrusted text into their page with `textContent` only, and the card page loads nothing from the network (CSP `default-src 'none'; img-src data:` and request interception).
- The queue, the spend, the events, the snapshots and the timers are in `DATA_DIR/bot.sqlite`, which the box user must not read. Keep `DATA_DIR` at mode 755 with the database at 600, or keep the box user out of `DATA_DIR` except for the job folders.
- A timer or a trigger starts the AI with no human author. The daily allowance (the cap divided by the days of the period) and a limit of 6 wakes per hour and guild bound the spend of these wakes.
- The bot gives the AI the text of a Discord instruction and the output of each job. Game chat is in that output. A hostile instruction or chat text can make the AI act badly inside the action policy, or spend API credit up to the limits.
- The bot reads every message of its channel and sends it, with the 8 messages before it, to the small model (`SMALL_MODEL`) to decide if it is for the bot. A message written to look like it talks to the bot can start a request. The small model has no tools; its answer only picks the kind of message.
- The spend record is an estimate from token counts and the list prices in `src/agent/spend.ts`. Set a spend limit in the Anthropic console too.
- Bun on Windows has no box user. Run the bot on Linux.

Box, milestone 3:

- The box is the job runner with `BOX_USER`, the job cgroup and the firewall script. It has no separate systemd unit. The box stand-in of the scripts runs as the same Unix user as the proxy, with no sandbox.
- The protections (eat, run away) run inside the job, as code of the box user. A job can turn them off. Their eat and run-away paths have unit tests only.
- If the box stand-in connects before the proxy has its gateway connection, the proxy refuses it, and the SDK does not try again.
- The boot token changes at each start of the proxy. A box must start again to get it.

Bootstrap (`scripts/server-bootstrap.sh`), milestone 7:

- The Bun installer is not verified.
- Phase `install` clones from a bare repository on your server only. It cannot clone from a URL.
- The script has no phase that removes its changes, and none that removes an old Chrome version. [deploy-server.md](deploy-server.md) lists the commands.
- Bun and the code belong to `rsbot`, so a process of `rsbot` can change the code that runs next.
- The bootstrap installs no firewall. `scripts/server-firewall.sh` and `deploy/systemd/rsbox-egress.service` add the box egress rules, but they have not run on a server yet.
- `scripts/server-backup.sh` with its timer backs up the SQLite files. The restore has not been tested.
- The Chromium sandbox ran from a login shell only, not under a systemd unit with hardening options.

Continuous integration:

- Job `check` of the CI workflow skips the 13 tests that launch Chromium. Job `browser-tests` runs them, after it turns off the AppArmor restriction of the runner. So CI tests the game tab under a kernel setting that a server does not have. The tests on your server (step 5 of [deploy-server.md](deploy-server.md)) cover the server setting.
- The workflow names its two actions by tag, not by commit.

## Design goals that are not built

- Built, in split mode (docs/running-the-bot.md): three Unix users under systemd. `rsbot` runs the bot, `rsgame` runs gamelink (`rs-gamelink.service`) and `rsbox` runs the jobs. Without split mode, the bot and gamelink share the `rsbot` process.
- systemd hardening for the box: limits for memory, CPU and tasks, a read-only root file system, no view of the processes of other users. The memory limit must allow for the start-up peak (about 491 MB in the local run of the box stand-in).
- No user namespaces for the box (`RestrictNamespaces=yes`) and no access to `/opt/rs-chrome` (`InaccessiblePaths=`), each with a test.
- Network limits: the box reaches only the loopback port of the proxy, and gamelink reaches only the game host.
- The Chromium profile on a memory file system that is removed when the browser stops.
- Built: the local interface of gamelink is a Unix socket (`rsgame:rsgate` 660) with one bearer token (`/etc/rs-gamelink/token`, readable by `rsgame` and `rsbot` only). It is one token for the interface, not one for each guild.

Built since milestone 1: the bot launches Chromium with DevTools on a pipe, so no debug port exists, and it enforces a monthly spend cap that you set (`AI_MONTHLY_CAP_USD`).
