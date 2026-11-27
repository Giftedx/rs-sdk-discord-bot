# Security model

This page describes what the code does today, what it does not do, and what the design plans. It makes no claim that the project is secure.

**Do not run this project on a machine that holds anything that you care about.** The bot runs AI-written TypeScript on your server. Untrusted text from Discord and from game chat steers that AI.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Trust boundary

The bot has three kinds of process. [design.md](design.md) describes them.

| Secret | Holder | Never visible to | State |
|---|---|---|---|
| Discord token | orchestrator (`rsbot`) | gamelink, box | built |
| API key for the AI | orchestrator (`rsbot`) | gamelink, box | built |
| Game password | gamelink (`rsgame`: proxy and game tab) | orchestrator, box | built, in split mode |

What this means:

- In split mode, each kind of process runs as its own Unix user: `rsbot` for the bot, `rsgame` for gamelink and `rsbox` (`BOX_USER`) for the jobs. [running-the-bot.md](running-the-bot.md) has the file modes and the checks.
- Without split mode, the bot and gamelink share the `rsbot` process, and that process holds all three secrets. Jobs still run as `BOX_USER`.
- The proxy holds the game password and accepts a boot token from the box. A job gets an environment from an allow list. The allow list holds the boot token and never the game password.
- The measurement scripts start the box stand-in with `--no-env-file`, so that Bun does not add the variables of a `.env` file to it. A test checks both. The box stand-in runs as the same Unix user as the script, so it can read `/proc/<pid>/environ` of the parent and the Chrome profile.

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
  - The policy refuses `clickComponent` and `clickComponentWithOption` on component 2458, the logout button (`LOGOUT_COMPONENT` in `src/gamelink/policy.ts`). A job cannot log the account out.
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
- **An escape from the box** through a kernel fault.
- **A ban** of the account or of the server IP after behaviour that the proxy allows.
- **Prompt injection** that wastes API credit up to the spend cap, or that makes the AI write a bad saved script or a bad note.

## Known gaps in the current code

Each item is a plain limit of the code today. Each heading names the milestone of [roadmap.md](roadmap.md) that must close its items.

Proxy (`src/gamelink/proxy.ts`), milestone 2:

- Closed: the proxy closes a gateway socket that sends no `sdk_connected` within 10 s (`upstreamHandshakeTimeoutMs`), or no message for 60 s after the handshake (`staleMs`), and connects again after the normal delay. Tests check both with a fake gateway, not with a live gateway.
- Closed: after a refused login of the proxy, the delay doubles from the normal delay up to 5 minutes, and a successful connect resets it. `status()` of the proxy handle reports `connected`, `lastError` and `reconnects`. The status text of the bot shows `connected` and `lastError`.
- The proxy counts the actions in flight, from the forward of `sdk_action` to the `sdk_action_result` with the same `actionId`. At the end of a job the bot waits up to 30 s for zero. Not checked on a live gateway: that the result carries the same `actionId`.
- The proxy has a `log` option, with one line for each gateway event. The log line holds the error text of the gateway, with the password removed, and never the raw message. Gamelink passes its log to the proxy (`src/gamelink/link.ts`).
- Closed: when more than 4 MB waits to go to the box, the proxy drops state messages for the box, and still sends other messages. At 8 MB, Bun closes the box socket. A test checks the drop with a socket that stops reading.
- Closed: the proxy forwards a rebuilt action message with only `type`, `action`, `actionId` and `actionTimeoutMs`, the fields that the `sdk_action` handler of the gateway reads.
- The proxy does not set the job flag to off when the box socket closes, because the SDK in the box connects again during a job. The job runner of the bot turns the flag on at the start of each job and off at its end. If that last call fails three times, the flag stays on until the next job, and the log shows `job flag not turned off`.
- Closed: an upstream "another controller connected" error reaches the box as a different text (`PREEMPT_RELAY_TEXT`), so the SDK does not get the text on which it stops its reconnects.
- Closed: the default reconnect delay of 11 to 16 s has a test.
- The proxy tries the direct gateway port first (`directGatewayUrl`, a copy of `DIRECT_GATEWAYS` in the SDK) and falls back to the relay URL. Tested only with a local fake gateway: not checked on the demo world that Bun negotiates permessage-deflate on the direct port, or how much bandwidth this saves against the measured 82 kB/s of the relay.

Configuration (`src/shared/config.ts`), milestone 2:

- Closed: `RS_GATEWAY_URL` must be `wss://` and `RS_BOT_PAGE_URL` `https://`, with the host of `RS_SERVER_HOST` (`checkGameUrls`). Only when both hosts are `localhost` or `127.0.0.1` are `ws://` and `http://` allowed. A non-empty `RS_PASSWORD` must match `^[A-Za-z0-9]{1,20}$`; the error names only the variable.

Game tab (`src/gamelink/game-tab.ts`), milestone 2:

- Closed in the code: `inGame()` is true only when `gameClient.ingame === true` and `gameClient.sceneState === 2`. The fixture page has the field, but no test on a live page has confirmed that `sceneState` is 2 when the map is ready. See [measurements.md](measurements.md).
- Closed: the browser environment is now an allow list (`BROWSER_ENV_ALLOW` in `src/gamelink/game-tab.ts`), and the four secret names stay out of it.
- `close()` does not log the account out. The bot calls `logout()` before `close()` when it stops.
- The game tab opens with no login; the first login comes 20 to 30 s later, at least 15 s after the login of the tab before. Failed logins back off (the re-login delay times 1, 2, 4, 8, 16 at most). A login message "Invalid username or password" or "account has been disabled" stops all logins of that tab until gamelink restarts (`login_refused`), so a wrong password cannot lock the account by retries. The message comes from `loginMes1`/`loginMes2` of the client; this has not been read on a live page.
- The crash reporter is off (`--disable-crash-reporter`, `--disable-breakpad`). This was checked only by a clean start, not by a search for crash dumps.
- The bot puts the browser profile in a new directory under `/dev/shm` (mode 700) and removes it when the browser closes, so no profile with the password stays on disk. Without `/dev/shm` the profile goes to the temp directory, and the bot logs a warning.
- Closed in the code: the block of `/api/screenshot` is now a CDP block list (`Network.setBlockedURLs`) on the page and on each worker, in place of request interception, so the browser cache stays on. Not run in a real browser yet: that the block list stops the POST, and that the cache works. The block list has no method filter; the engine answers only POST on that path.

Scripts (`scripts/`), milestone 2:

- `makeRedact` does not replace the URL-encoded form of a password, and it does not replace a password below 4 characters. The bootstrap makes passwords from `A-Za-z0-9`, which have no different encoded form.
- The security helpers `boxChildCommand`, `boxChildEnv`, `makeRedact` and `newBootToken` are in `src/shared/script-secrets.ts`, and `scripts/run-helpers.ts` re-exports them.
- Closed in the code: `scripts/proxy-proof.ts` counts `sdk_action_result` messages through a relay in front of the proxy, and exits 1 unless the child exits 0, frames were tapped, and at least one result came from the gateway. Its field `passwordInChildEnv` still reports on the environment that the script built, not on the running child. Not run against a live game yet.
- `scripts/measure.ts` calls `keepAlive()` every 60 s in every mode, mode `demo` included.
- Closed: `measure.ts`, `idle-test.ts` and `proxy-proof.ts` write a `provenance` field (git commit read from `.git` without running git, Chrome path, Chrome version). The measurement scripts still set no profile directory for Chromium. The bot and `scripts/bot-smoke.ts` use the tmpfs profile.

Bot (`src/bot/`, `src/agent/`, `src/box/`):

- **Without `BOX_USER`, a job runs as the same Unix user as the bot.** It can then read the secret files of the bot and `/proc/<pid>/environ` of the bot process, which hold the Discord token, the API key and the game password. So the bot refuses to start without `BOX_USER`, unless `BOT_ALLOW_UNSANDBOXED=1` is set for local development ([running-the-bot.md](running-the-bot.md)).
- With `DISCORD_ALLOW_EVERYONE=1` in place of `DISCORD_ALLOWED_ROLE_ID`, every member of the channel can give an instruction, and so start AI-written code. The bot refuses to start with neither.
- With `BOX_USER`, a job runs as a second Unix user through `sudo`. It can read every file that is readable by all users.
- Job limits: when the bot unit has `Delegate=yes`, the bot moves each job into one cgroup with memory, process and CPU limits for all jobs together (`src/box/cgroup.ts`). Without delegation the bot logs one line and the jobs have no limits. Not yet tested on a real systemd unit: the move of the `sudo` child into the job cgroup. A grandchild can start before the move.
- Network: `scripts/server-firewall.sh` lets each box user in `BOX_USERS` reach only the proxy ports on `127.0.0.1`. A box user that is not in that list has no network limit. A box user can reach the proxy ports of the other guilds too, but it needs their boot token to log in.
- Guilds that share a box user run their jobs one at a time, because the runner kills every process of the box user after a job. The jobs of one guild can see the processes of another guild that has the same box user only between these jobs.
- All text from the AI and the game goes through `sanitizeForDiscord` with no pings before Discord: the status card, the goal, the adventure log, the `post` lines of the AI, the posts and the instruction messages. Drawn cards put untrusted text into their page with `textContent` only, and the card page loads nothing from the network (CSP `default-src 'none'; img-src data:` and request interception).
- The queue, the spend, the events, the snapshots and the timers are in `DATA_DIR/bot.sqlite`, which the box user must not read. Keep `DATA_DIR` at mode 755 with the database at 600, or keep the box user out of `DATA_DIR` except for the job folders.
- A thumbs-up on a waiting request moves it up one place. Only members who pass the role check count, once each per request. The record of who voted is in memory, so after a restart a member can vote again.
- The daily review wake (`NOTES_REVIEW_HOUR_UTC`) runs on the escalation model without `run_code`, `run_script`, `look` and `escalate`; a call to one of them is refused.
- A timer or a trigger starts the AI with no human author. The daily allowance (the cap that is left, divided by the days left in the period) and a limit of 6 wakes per hour and guild bound the spend of these wakes.
- The bot gives the AI the text of a Discord instruction and the output of each job. Game chat is in that output. A hostile instruction or chat text can make the AI act badly inside the action policy, or spend API credit up to the limits.
- The bot reads every message of its channel and sends it, with the 8 messages before it, to the small model (`SMALL_MODEL`) to decide if it is for the bot. A message written to look like it talks to the bot can start a request. The small model has no tools; its answer only picks the kind of message.
- The spend record is an estimate from token counts and the list prices in `src/agent/spend.ts`. Set a spend limit in the Anthropic console too.
- Bun on Windows has no box user. Run the bot on Linux.
- On Windows, Chromium opens DevTools on a loopback port, not on a pipe, because Bun on Windows cannot open the pipe. Any local process can connect to that port. Use Windows for the tests only.

Box, milestone 3:

- The box is the job runner with `BOX_USER`, the job cgroup and the firewall script. It has no separate systemd unit. The box stand-in of the scripts runs as the same Unix user as the proxy, with no sandbox.
- The protections (eat, run away) run inside the job, as code of the box user. A job can turn them off. Their eat and run-away paths have unit tests only.
- If the box stand-in connects before the proxy has its gateway connection, the proxy refuses it, and the SDK does not try again.
- The boot token changes at each start of the proxy. A box must start again to get it.

Bootstrap (`scripts/server-bootstrap.sh`), milestone 7:

- The Bun installer is not verified.
- Phase `install` clones from a bare repository on your server only. It cannot clone from a URL.
- The script has no phase that removes its changes. [deploy-server.md](deploy-server.md) lists the commands. `scripts/server-chrome-prune.sh` removes old Chrome versions; it has run only against stand-ins in tests.
- Bun and the code belong to `rsbot`, so a process of `rsbot` can change the code that runs next.
- The bootstrap installs no firewall. `scripts/server-firewall.sh` and `deploy/systemd/rsbox-egress.service` add the box egress rules. They run live on the server.
- `scripts/server-backup.sh` with its timer backs up the SQLite files. `scripts/server-restore-test.sh` checks a backup in a temporary directory. It has run only in a test on Windows, not as root on the server against a real backup.
- `scripts/server-firewall.sh game-egress` limits `rsgame` to loopback, DNS and the game host on 443 and 7443, with an hourly refresh (`rsgame-egress.timer`). `rsgame-egress.service` and the timer run live on the server. Not checked: whether Chromium needs another host (fonts, a CDN, its own update traffic), and the behaviour when the DNS answer of the game host rotates between refreshes.
- The Chromium sandbox ran from a login shell only, not under a systemd unit with hardening options.
- The split-mode bot unit `rs-discord-bot.service` has `ProtectSystem=strict`, `ProtectProc=invisible`, `ProcSubset=pid`, and `InaccessiblePaths=` for `/opt/rs-chrome` and the account file. It cannot set `RestrictNamespaces=`, `PrivateDevices=`, `LockPersonality=`, `SystemCallFilter=` or `RestrictSUIDSGID=`: for a unit with `User=`, each of them sets `NoNewPrivileges=yes`, and then `sudo` cannot start the jobs as the box user. So the box user can still make user namespaces. One-process mode uses `rs-discord-bot-single.service` with the older limits.
- The revision check (`rs-revision-check.service`) restarts `rs-gamelink` through a root `ExecStartPost=+` when the script wrote `data/revision-restart`. The script itself runs as `rsbot`. Not tested on a host.

Continuous integration:

- Job `check` of the CI workflow skips the tests that launch Chromium. Job `browser-tests` runs them, after it turns off the AppArmor restriction of the runner. So CI tests the game tab under a kernel setting that a server does not have. The tests on your server (step 5 of [deploy-server.md](deploy-server.md)) cover the server setting.
- The workflow pins its two actions by commit SHA, with the tag in a comment. A new release of an action needs a manual update of the SHA.

## Design goals that are not built

- Built, in split mode (docs/running-the-bot.md): three Unix users under systemd. `rsbot` runs the bot, `rsgame` runs gamelink (`rs-gamelink.service`) and `rsbox` runs the jobs. Without split mode, the bot and gamelink share the `rsbot` process.
- systemd hardening for the box: limits for memory, CPU and tasks, a read-only root file system, no view of the processes of other users. The memory limit must allow for the start-up peak (about 491 MB in the local run of the box stand-in).
- No user namespaces for the box (`RestrictNamespaces=yes`) and no access to `/opt/rs-chrome` (`InaccessiblePaths=`), each with a test.
- Built, and live on the server: network limits. The box reaches only the loopback port of the proxy (`rsbox-egress.service`). Gamelink reaches only loopback, DNS and the game host (`rsgame-egress.service`, with the hourly refresh of `rsgame-egress.timer`).
- The Chromium profile on a memory file system that is removed when the browser stops.
- Built: the local interface of gamelink is a Unix socket (`rsgame:rsgate` 660) with one bearer token (`/etc/rs-gamelink/token`, readable by `rsgame` and `rsbot` only). It is one token for the interface, not one for each guild.

Built since milestone 1: the bot launches Chromium with DevTools on a pipe, so no debug port exists, and it enforces a monthly spend cap that you set (`AI_MONTHLY_CAP_USD`).
