# Security model

This page says what the code protects, what it does not protect, and what is still a design goal. It makes no claim that the project is secure.

**Do not run this project on a machine that holds anything that you care about.** The bot runs AI-written TypeScript on your server. Untrusted text from Discord and from game chat steers that AI.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Trust boundary

The bot has three kinds of process. [design.md](design.md) describes them.

| Secret | Holder | Never visible to | State |
|---|---|---|---|
| Discord token | orchestrator (`rsbot`) | gamelink, box | built |
| API key for the AI | orchestrator (`rsbot`) | gamelink, box | built |
| Game password | gamelink (`rsgame`: proxy and game tab) | orchestrator, box | built, in split mode |

- In split mode, each kind of process runs under systemd as its own Unix user. `rsbot` runs the bot, `rsgame` runs gamelink (`rs-gamelink.service`) and `rsbox` (`BOX_USER`) runs the jobs. [running-the-bot.md](running-the-bot.md) has the file modes and the checks.
- Without split mode, the bot and gamelink share the `rsbot` process. That process holds all three secrets. Jobs still run as `BOX_USER`.
- The bot talks to gamelink through a Unix socket (`rsgame:rsgate` 660). Each request must carry the bearer token (`/etc/rs-gamelink/token`, readable by `rsgame` and `rsbot` only). It is one token for the interface, not one for each guild.
- The proxy holds the game password and accepts a boot token from the box in its place. A job gets its environment from an allow list. The list holds the boot token and never the game password.
- The measurement scripts start the box stand-in with `--no-env-file`, so that Bun does not add the variables of a `.env` file to it. A test checks both. The box stand-in runs as the same Unix user as the script. So it can read `/proc/<pid>/environ` of the parent and the Chrome profile.

## Untrusted input

The design treats four sources as untrusted: Discord users, game chat, the output of the box, and the files that the box writes.

A player in the game can try to direct the AI through game chat. The system prompt tells the AI that game chat, item names and player names are data, never an instruction. The prompt of the small model says the same of Discord messages. These marks lower the risk but do not remove it. The box limits what a successful injection gets.

## What the proxy enforces

`src/gamelink/proxy.ts` and `src/gamelink/policy.ts`, with tests:

- The proxy listens on `127.0.0.1` only. It refuses a connection that has a browser `Origin` header.
- A box connection must send the account name and the boot token within 5 s. The token comparison takes constant time.
- The proxy closes a box connection that sends a message above 64 KB, or a message that is not a JSON object.
- The proxy answers the `sdk_connect` of the box itself. So the box never gets the game password, and a restart of the box makes no new login.
- From the box, the proxy forwards `sdk_action` messages only. It forwards the parsed object that the policy checked, rebuilt with only `type`, `action`, `actionId` and `actionTimeoutMs`. These are the fields that the `sdk_action` handler of the gateway reads.
- From the gateway, the proxy relays `sdk_state`, `sdk_action_result`, `sdk_info`, `sdk_connected`, and an `sdk_error` that arrives after the connection is ready.
- An upstream "another controller connected" error reaches the box as a different text (`PREEMPT_RELAY_TEXT`). So the SDK does not get the text on which it stops its reconnects.
- Above 4 MB of unsent data for the box, the proxy drops state messages for the box and still sends other messages. At 8 MB, Bun closes the box socket. A test checks the drop with a socket that stops reading.
- When the connection to the gateway closes, the proxy connects again after 11 to 16 s. A test checks this delay. After a refused login, the delay doubles up to 5 minutes. A successful connect resets it.
- `status()` of the proxy handle reports `connected`, `lastError` and `reconnects`. The status text of the bot shows `connected` and `lastError`.
- The action policy checks each action:
  - If no job runs, the policy refuses every action. The job flag starts as off.
  - The policy refuses `interactPlayer` and `spellOnPlayer`. In the pinned client, these are the actions for a direct attack on a player and a direct trade with a player.
  - The policy passes only the action types on an allow list. The list holds the types of the pinned rs-sdk client. A test compares the list with the client source.
  - The policy refuses a `say` or `privateMessage` text that starts with `::` after leading spaces, because the client sends such a text as a command.
  - The policy refuses `clickComponent` and `clickComponentWithOption` on component 2458, the logout button (`LOGOUT_COMPONENT` in `src/gamelink/policy.ts`). So a job cannot log the account out.
  - The policy limits `say` and `privateMessage` to 6 messages per minute.

Other protections in the current code:

- The game password never goes on a command line. The game tab passes it in the navigation URL only. A test checks the arguments of the browser process.
- The browser environment is an allow list (`BROWSER_ENV_ALLOW` in `src/gamelink/game-tab.ts`) without the four secret names. So the browser process does not get `RS_PASSWORD`.
- Navigation errors do not contain the URL, because the URL holds the password. Configuration errors name the variable only, never a value.
- `RS_GATEWAY_URL` must be `wss://` and `RS_BOT_PAGE_URL` `https://`, with the host of `RS_SERVER_HOST` (`checkGameUrls` in `src/shared/config.ts`). Only when both hosts are `localhost` or `127.0.0.1` are `ws://` and `http://` allowed. A non-empty `RS_PASSWORD` must match `^[A-Za-z0-9]{1,20}$`.
- The scripts pass all output of the box stand-in through a function that replaces the boot token and the password.
- The game tab blocks `POST /api/screenshot`, so the page cannot upload a picture to the public gallery of the game host.
- Chromium runs with its own sandbox. A test checks that the launch arguments hold no flag that disables it.
- On Linux, the bot launches Chromium with DevTools on a pipe, so no debug port exists.
- The bot enforces a monthly spend cap that you set (`AI_MONTHLY_CAP_USD`).
- The scripts refuse mode `demo` unless `RS_ALLOW_DEMO=1` is set.
- `measure.ts`, `idle-test.ts` and `proxy-proof.ts` write a `provenance` field: the git commit read from `.git` without running git, the Chrome path and the Chrome version.

## What the proxy cannot enforce

The action policy checks the action type, the `::` prefix and the chat rate. It does not inspect the other arguments of an action or the content of chat. So the policy cannot stop these:

- A sale of items at a low price on the Grand Exchange, or to a shop.
- A drop of items on the ground.
- A private message to any player, and any chat text, up to 6 messages per minute. There is no content filter.
- A walk into a dangerous area or into an area where players can attack the account.
- A different meaning of an allowed action type. The game tab runs the client that the game host serves. That client can differ from the pinned source that the test compares.

If you share an account with a channel, you accept that its members can make the AI waste the items of the account.

The proxy protects nothing on the local stack. The gateway of the local stack accepts any password, and a process on the same machine can connect to it directly. See "Residual risks".

## Residual risks

- **The local stack is open to the network.** By a reading of the rs-sdk source, the engine of the local stack listens on port 8888 on all interfaces. It serves the game, the bot page and a relay to the gateway, which accepts any password. Use the local stack only on a development machine behind a firewall. [development.md](development.md) has the warning.
- **The AppArmor profile does not confine Chrome.** It is `flags=(unconfined)` with `userns`, and the Chrome copy has mode 755. Every local user on your server can run this Chrome. Untested, but likely: any local user can get user namespaces through it, for example with `LD_PRELOAD`. [deploy-server.md](deploy-server.md) has the detail and the removal commands.
- **The Chrome checksum is trust on first use.** Chrome for Testing publishes no SHA-256. The value in the bootstrap is from one download, whose MD5 matched a header of the storage object. Root downloads and unpacks the archive. The first execution of the binary is the version check, which runs as `rsbot`.
- **The Bun installer is not verified.** The bootstrap (`scripts/server-bootstrap.sh`) downloads it with `curl` and runs it as `rsbot`. The development guide does the same as your own user.
- **The admin user of the deployment guide has `sudo` without a password.** A stolen SSH key for that user gives root.
- **Chromium runs code from the game host.** A fault in Chromium is a risk for the process that holds the game password.
- **The game password is in the tab URL.** `buildBotUrl` puts it in the query of the bot page URL. It reaches the game host in the request line. The page stores it in `localStorage` (`vendor/rs-sdk/server/engine/view/bot.ejs`). The URL is in the history of the Chrome profile.
- **A killed script run can leave the password on disk.** The measurement scripts set no profile directory, so puppeteer makes one in `/tmp`. A normal exit removes it. A killed run can leave `/tmp/puppeteer_dev_chrome_profile-*`. The bot and `scripts/bot-smoke.ts` use the tmpfs profile.
- **An escape from the box** through a kernel fault.
- **A ban** of the account or of the server IP after behaviour that the proxy allows.
- **Prompt injection** that wastes API credit up to the spend cap, or that makes the AI write a bad saved script or a bad note.

## Known gaps in the current code

Each item is a limit of the code today. Each heading names the milestone of [roadmap.md](roadmap.md) that must close its items.

Proxy (`src/gamelink/proxy.ts`), milestone 2:

- The proxy closes a gateway socket that sends no `sdk_connected` within 10 s (`upstreamHandshakeTimeoutMs`), or no message for 60 s after the handshake (`staleMs`). Then it connects again after the normal delay. Tests check both with a fake gateway only, not with a live gateway.
- The proxy counts the actions in flight, from the forward of `sdk_action` to the `sdk_action_result` with the same `actionId`. At the end of a job, the bot waits up to 30 s for zero. Not checked on a live gateway: that the result carries the same `actionId`.
- The `log` option of the proxy writes one line for each gateway event. The line holds the error text of the gateway with the password removed, never the raw message. Gamelink passes its log to the proxy (`src/gamelink/link.ts`).
- When the box socket closes, the proxy keeps the job flag on, because the SDK in the box connects again during a job. The job runner of the bot sets the flag on at the start of each job and off at its end. If that last call fails three times, the flag stays on until the next job. Then the log shows `job flag not turned off`.
- The proxy tries the direct gateway port first (`directGatewayUrl`, a copy of `DIRECT_GATEWAYS` in the SDK). If that fails, it uses the relay URL. Tested only with a local fake gateway. Not checked on the demo world: that Bun negotiates permessage-deflate on the direct port. Also not checked: how much bandwidth this saves against the measured 82 kB/s of the relay.

Game tab (`src/gamelink/game-tab.ts`), milestone 2:

- `inGame()` is true only when `gameClient.ingame === true` and `gameClient.sceneState === 2`. The fixture page has the field. No test on a live page has confirmed that `sceneState` is 2 when the map is ready. See [measurements.md](measurements.md).
- `close()` does not log the account out. The bot calls `logout()` before `close()` when it stops.
- The game tab opens with no login. The first login comes 20 to 30 s later, and at least 15 s after the login of the tab before. After failed logins, gamelink multiplies the re-login delay by 1, 2, 4, 8, then 16 at most. The login message "Invalid username or password" or "account has been disabled" stops all logins of that tab until gamelink restarts (`login_refused`). So a wrong password cannot lock the account by retries. The message comes from `loginMes1`/`loginMes2` of the client. Nobody has read it on a live page.
- The crash reporter is off (`--disable-crash-reporter`, `--disable-breakpad`). Only a clean start checked this, not a search for crash dumps.
- The bot puts the browser profile in a new directory under `/dev/shm` (mode 700) and removes it when the browser closes. So no profile with the password stays on disk. Without `/dev/shm`, the profile goes to the temp directory, and the bot logs a warning.
- The block of `/api/screenshot` is a CDP block list (`Network.setBlockedURLs`) on the page and on each worker. It replaces request interception, so the browser cache stays on. Not run in a real browser yet: that the block list stops the POST, and that the cache works. The block list has no method filter. The engine answers only POST on that path.

Scripts (`scripts/`), milestone 2:

- `makeRedact` does not replace the URL-encoded form of a password, or a password below 4 characters. The bootstrap makes passwords from `A-Za-z0-9`, which have no different encoded form.
- The security helpers `boxChildCommand`, `boxChildEnv`, `makeRedact` and `newBootToken` are in `src/shared/script-secrets.ts`. `scripts/run-helpers.ts` re-exports them.
- `scripts/proxy-proof.ts` counts `sdk_action_result` messages through a relay in front of the proxy. It exits 1 unless the child exits 0, the relay tapped frames, and at least one result came from the gateway. Its field `passwordInChildEnv` reports on the environment that the script built, not on the running child. Not run against a live game yet.
- `scripts/measure.ts` calls `keepAlive()` every 60 s in every mode, mode `demo` included.

Bot (`src/bot/`, `src/agent/`, `src/box/`):

- **Without `BOX_USER`, a job runs as the same Unix user as the bot.** Then it can read the secret files of the bot and `/proc/<pid>/environ` of the bot process. These hold the Discord token, the API key and the game password. So the bot refuses to start without `BOX_USER`, unless `BOT_ALLOW_UNSANDBOXED=1` is set for local development ([running-the-bot.md](running-the-bot.md)).
- With `DISCORD_ALLOW_EVERYONE=1` in place of `DISCORD_ALLOWED_ROLE_ID`, every member of the channel can give an instruction and so start AI-written code. The bot refuses to start with neither.
- With `BOX_USER`, a job runs as a second Unix user through `sudo`. It can read every file that is readable by all users.
- Job limits: when the bot unit has `Delegate=yes`, the bot moves each job into one cgroup (`src/box/cgroup.ts`). The cgroup has memory, process and CPU limits for all jobs together. Without delegation, the bot logs one line and the jobs have no limits. Not yet tested on a real systemd unit: the move of the `sudo` child into the job cgroup. A grandchild can start before the move.
- Network: `scripts/server-firewall.sh` lets each box user in `BOX_USERS` reach only the proxy ports on `127.0.0.1`. A box user that is not in that list has no network limit. A box user can reach the proxy ports of the other guilds too, but it needs their boot token to log in.
- Guilds that share a box user run their jobs one at a time. The runner kills every process of the box user after a job. Only between these jobs can the jobs of one guild see the processes of another guild with the same box user.
- All text from the AI and the game passes through `sanitizeForDiscord`, with no pings, before it goes to Discord. This covers the status card, the goal, the adventure log, the `post` lines of the AI, the posts and the instruction messages. Drawn cards put untrusted text into their page with `textContent` only. The card page loads nothing from the network (CSP `default-src 'none'; img-src data:` and request interception).
- The queue, the spend, the events, the snapshots and the timers are in `DATA_DIR/bot.sqlite`, which the box user must not read. Keep `DATA_DIR` at mode 755 with the database at 600. Or keep the box user out of `DATA_DIR` except for the job folders.
- A thumbs-up on a waiting request moves it up one place. Only members who pass the role check count, once each per request. The record of who voted is in memory. So after a restart, a member can vote again.
- The daily review wake (`NOTES_REVIEW_HOUR_UTC`) runs on the escalation model without `run_code`, `run_script`, `look` and `escalate`. The bot refuses a call to one of them.
- A timer or a trigger starts the AI with no human author. Two limits bound the spend of these wakes. One is the daily allowance: the cap that is left, divided by the days left in the period. The other is 6 wakes per hour and guild.
- The bot gives the AI the text of a Discord instruction and the output of each job, which holds game chat. A hostile instruction or chat text can make the AI act badly inside the action policy, or spend API credit up to the limits.
- The bot sends every message of its channel, with the 8 messages before it, to the small model (`SMALL_MODEL`). The small model decides if the message is for the bot. A message written to look like it talks to the bot can start a request. The small model has no tools. Its answer only picks the kind of message.
- The spend record is an estimate from token counts and the list prices in `src/agent/spend.ts`. Set a spend limit in the Anthropic console too.
- Bun on Windows has no box user. Run the bot on Linux.
- On Windows, Chromium opens DevTools on a loopback port, because Bun on Windows cannot open the pipe. Any local process that reaches that port can read the tab URL with the password and control the tab. Use Windows for the tests only.

Box, milestone 3:

- The box is the job runner with `BOX_USER`, the job cgroup and the firewall script. It has no separate systemd unit. The box stand-in of the scripts runs as the same Unix user as the proxy, with no sandbox.
- The protections (eat, run away) run inside the job, as code of the box user. A job can stop them. Their eat and run-away paths have unit tests only.
- If the box stand-in connects before the proxy has its gateway connection, the proxy refuses it, and the SDK does not try again.
- The boot token changes at each start of the proxy. A box must start again to get it.

Bootstrap (`scripts/server-bootstrap.sh`), milestone 7:

- The Bun installer is not verified. See "Residual risks".
- Phase `install` clones only from a bare repository on your server. It cannot clone from a URL.
- The script has no phase that removes its changes. [deploy-server.md](deploy-server.md) lists the commands. `scripts/server-chrome-prune.sh` removes old Chrome versions. It has run only against stand-ins in tests.
- Bun and the code belong to `rsbot`. So a process of `rsbot` can change the code that runs next.
- The bootstrap installs no firewall. `scripts/server-firewall.sh` and `deploy/systemd/rsbox-egress.service` add the box egress rules. They run live on the server.
- `scripts/server-backup.sh` with its timer backs up the SQLite files. `scripts/server-restore-test.sh` checks a backup in a temporary directory. It ran as root on the server against a real backup on 2026-11-27 and passed. A full restore over the live files has not run.
- `scripts/server-firewall.sh game-egress` limits `rsgame` to loopback, DNS and the game host on 443 and 7443, with an hourly refresh (`rsgame-egress.timer`). `rsgame-egress.service` and the timer run live on the server. Not checked: whether Chromium needs another host (fonts, a CDN, its own update traffic). Also not checked: the behaviour when the DNS answer of the game host rotates between refreshes.
- The Chromium sandbox runs under `rs-gamelink.service` on the server. The renderers have their own user and pid namespaces and a seccomp filter. The unit has `NoNewPrivileges=yes`, an empty capability bounding set, `ProtectSystem=strict`, `PrivateDevices=yes`, `ProtectProc=invisible` and the kernel, clock and hostname protections. `systemd-analyze security` rates it 3.7.
- `rs-gamelink.service` cannot set `RestrictNamespaces=` or `SystemCallFilter=`, because the Chromium sandbox needs namespaces and its own seccomp filter. It cannot set `MemoryDenyWriteExecute=`, because the JIT compilers of Bun and V8 need memory that is both writable and executable.
- The split-mode bot unit `rs-discord-bot.service` has `ProtectSystem=strict`, `ProtectProc=invisible`, `ProcSubset=pid`, and `InaccessiblePaths=` for `/opt/rs-chrome` and the account file.
- `rs-discord-bot.service` cannot set `RestrictNamespaces=`, `PrivateDevices=`, `LockPersonality=`, `SystemCallFilter=` or `RestrictSUIDSGID=`. For a unit with `User=`, each of them sets `NoNewPrivileges=yes`, and then `sudo` cannot start the jobs as the box user. So the box user can still make user namespaces. One-process mode uses `rs-discord-bot-single.service` with the older limits.
- The revision check (`rs-revision-check.service`) restarts `rs-gamelink` through a root `ExecStartPost=+` when the script wrote `data/revision-restart`. The script itself runs as `rsbot`. Not tested on a host.

Continuous integration:

- Job `check` of the CI workflow skips the tests that launch Chromium. Job `browser-tests` runs them, after it disables the AppArmor restriction of the runner. So CI tests the game tab under a kernel setting that a server does not have. The tests on your server (step 5 of [deploy-server.md](deploy-server.md)) cover the server setting.
- The workflow pins its two actions by commit SHA, with the tag in a comment. A new release of an action needs a manual update of the SHA.

## Design goals that are not built

- systemd hardening for the box: a read-only root file system and no view of the processes of other users. The job cgroup already sets memory, process and CPU limits. The memory limit must allow for the start-up peak (about 491 MB in the local run of the box stand-in).
- No user namespaces for the box (`RestrictNamespaces=yes`) and no access to `/opt/rs-chrome` (`InaccessiblePaths=`), each with a test.
- A Chromium profile on a memory file system for the measurement scripts. The bot and `scripts/bot-smoke.ts` already have one.
