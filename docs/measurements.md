# Resource measurements: one example run

This is one run with one account on one machine, against a shared game server. It is an example, not a guarantee. You cannot reproduce the numbers to the digit.

## Result

| Measured | Number | Conditions |
|---|---|---|
| RAM of one account | about 1.1 GB (Pss) | 4 vCPU / 8 GB Ubuntu 26.04 virtual server, Chromium sandboxed, scenario `all` |
| CPU of one account | 67% of one core | The same |
| Idle account | stayed logged in for 25 minutes | Demo world. See "Idle test" for why you must not rely on this. |
| Accounts that fit | about 4, by arithmetic | CPU is the limit. Nobody ran more than one account. |

The fit rule of this project uses scenario `all`. An account fits if `MemAvailable` is above 800 MB and the CPU is below 75% of all cores. In this run, `MemAvailable` was 6413 MB and the CPU was 16.68% of all 4 cores. **One account fits on this machine.**

## Test setup

| Item | Value |
|------|-------|
| Machine | One virtual server, 4 vCPU (x86-64), 8 GB RAM |
| OS | Ubuntu 26.04 LTS |
| `kernel.apparmor_restrict_unprivileged_userns` | 1 (not changed) |
| `kernel.unprivileged_userns_clone` | 1 |
| Software | Bun 1.3.14, Chrome for Testing 148.0.7778.97 with its sandbox on, rs-sdk at commit `3506b20` |
| Game server | The rs-sdk demo world (`rs-sdk.maxbittker.com`), one account |

`scripts/server-bootstrap.sh` prepared the machine, as [deploy-server.md](deploy-server.md) describes.

## Method

`bun scripts/measure.ts demo` ran for about 13 minutes. Each scenario had 60 s to settle, then 3 samples of 30 s. The bot page got `fps=15`.

The tool reads `/proc`. Pss is the proportional set size: the RAM of a process, with shared pages divided between the processes that share them.

In every mode and every scenario, the tool calls `keepAlive()` every 60 s. That call resets the idle timer of the client. So scenario `tab` is the game tab with that call, not a tab that nothing touches.

| Scenario | Content |
|---|---|
| `tab` | The game tab. |
| `tab+frames` | The game tab, and one `view` frame every 5 s. |
| `tab+frames+card` | The same, and a second tab that draws a small canvas every 60 s. It stands in for the planned card tab. |
| `box` | The box stand-in: a Bun process that loads the rs-sdk SDK with pathfinding and connects through the proxy. |
| `all` | The proxy host, the browser and the box stand-in together. |

## Results

The raw result files are not published. This block is an abridged copy of the tool output.

```
4 cores on this machine
| Scenario        | Sampled                                                   | Pss MB                 | CPU % of 1 core   | CPU % of all 4 cores | Processes (Pss/CPU) | In game | Game fps |
|-----------------|-----------------------------------------------------------|------------------------|-------------------|----------------------|---------------------|---------|----------|
| tab             | browser tree + companions                                 | 619.6 (614.0-628.6)    | 75.3 (57.0-111.7) | 18.82                | 16/16               | true    | 14       |
| tab+frames      | browser tree + companions                                 | 569.9 (553.8-578.1)    | 56.5 (54.9-57.8)  | 14.12                | 18/18               | true    | 14       |
| tab+frames+card | browser tree + companions                                 | 619.8 (596.4-642.0)    | 51.7 (51.6-51.9)  | 12.94                | 19/19               | true    | 14       |
| box             | box stand-in tree                                         | 354.6 (347.8-361.5)    | 2.4 (2.2-2.5)     | 0.59                 | 1/1                 | true    | 14       |
| all             | this process tree (proxy host, browser, box) + companions | 1090.8 (1071.7-1118.1) | 66.7 (63.7-68.6)  | 16.68                | 21/21               | true    | 14       |
```

Other values of the run:

- `MemAvailable` was 7211 MB at the start and 6413 MB in scenario `all`.
- The Pss of the box stand-in was 365.3 MB right after it reported "ready", before it settled.
- The box stand-in was ready 1970 ms after its process start (SDK import done at 800 ms, pathfinding load 961 ms).
- The state tap received 758 state messages (`sdk_state`) with a mean of 32709 bytes of state JSON, at 2.50 per second.
- The picture loop took 90 frames, and 0 failed.
- The first `tab` sample (111.7%) includes the end of the login. The other two samples are 57.0% and 57.1%.
- The bot page URL asks for `fps=15`, and the page logs `[Bot] Set FPS to 15`. The counter of the client (`gameClient.fps`) read 14 in every sample and 13 once (scenario `all`, sample 1). So the client frame rate was about 14 per second, and not below 10.

## How many accounts fit

This is arithmetic from one account (scenario `all`: 1090.8 MB Pss, 66.7% of one core).

- RAM: in the local run, the start-up peak of the box stand-in was about 491 MB, against about 353 MB steady. Add 138 MB per account for the peak: (7211 MB available at start - 800 MB reserve) / (1090.8 + 138) MB = 5.2. That is 5 accounts by RAM.
- CPU: 75% of 4 cores is 300% of one core. 300 / 66.7 = 4.5. That is 4 accounts by CPU.

On 2 such cores, scenario `all` would be about 33% of all cores by arithmetic. No run measured the CPU load on 2 cores.

## Local comparison

The same tool ran on a desktop PC under WSL2, with the local stack (a game world with no other players).

| Scenario (local) | Pss MB | CPU % of 1 core |
|------------------|--------|-----------------|
| tab | 595.9 | 16.3 |
| tab+frames | 620.1 | 16.7 |
| tab+frames+card | 644.0 | 17.5 |
| box | 353.0 | 5.2 |
| all | 1093.0 | 28.2 |

Local state tap: mean state JSON 25089 bytes, 2.46 state messages per second. Local box stand-in: ready after 1460 ms.

## Caveats

- **The game tab used about 3.5 times more CPU on the server than on the desktop.** The steady value was 57.0% of one core on the server, against 16.3% locally. No test separated the two possible causes. First, Chromium draws the game in software (`--disable-gpu`), and one virtual core of the server is slower than one core of the desktop. Second, the scene on the public server had other players and NPCs, and the local world had none.
- **The start-up peak of the box stand-in on the server can read low.** The tool read 365.3 MB right after "ready". The local run measured a peak of about 491 MB. A memory limit for the box must allow for the peak.
- **A real box can use more CPU than the box stand-in.** The box stand-in connects and waits. It runs no job.

## Idle test

`bun scripts/idle-test.ts demo idle` opened one game tab and sent no action. It read `inGame()` every 30 s.

| Run | Length | keepAlive | Samples | Result |
|-----|--------|-----------|---------|--------|
| 1 | 25 minutes | off | 50, all `inGame` true | stayed in game |
| 2 | 25 minutes | every 4 minutes (7 calls) | 50, all `inGame` true | stayed in game |

There was no login between the runs.

**Do not rely on this result.** By the pinned source, the game server ignores the idle logout request of the client only while its `NODE_DEBUG` setting is on. The demo deployment file turns that setting on. On a server with that setting off, the pinned client logs an idle account out after 10 minutes. Both runs stayed in game, so this test did not show whether `keepAlive()` prevents that logout.

Evidence:

- `IdleTimerHandler.handle` sets `player.requestIdleLogout = true` only if `!Environment.node.debug` (`vendor/rs-sdk/server/engine/src/network/game/client/handler/IdleTimerHandler.ts`, lines 8 to 11). The demo deployment file sets `NODE_DEBUG = "true"` (`vendor/rs-sdk/fly.toml`, line 17).
- The pinned client logs `[LOGOUT DEBUG] AFK timeout triggered (10 min no input)` when `now - this.idleTimer > 600_000`, and then sends the idle packet (`vendor/rs-sdk/server/webclient/src/client/Client.ts`, lines 4898 to 4905). Run 1 had 25 minutes without input, but the captured page console did not have that line. The game tab runs the client that the game host serves, and that client can differ from the pinned source. The test does not show which explanation is true.

## Re-login test

`bun scripts/idle-test.ts demo relogin` measured the time from a new page load until `inGame()` is true.

- Two cases each reached `inGame()` after about 11 s at the first attempt. Case 1 was a reload of the page. Case 2 was a close of the tab, a 15 s wait and a new tab.
- The only login message was "Connecting to server...". There was no "Your account is already logged in." and no error text.
- The reload ran without the wait of 20 to 30 s (`reloginDelayMs()`) that the script has now. The current form has no measured result.
- These times are the time to `inGame()`, not the time to a loaded map. See "Proxy proof".

The rule of this project: after a session ends, wait more than 10 s, with random jitter, before a new login. [development.md](development.md) lists the waits that the code has.

## Proxy proof

Two runs of `bun scripts/proxy-proof.ts demo` on the reference machine exited with code 0.

- In the first run, the template script received game state, found a tree and sent the chop action.
- In the second run, the map was still loading. The state had no scenery, the script sent no action, and the frame showed the client screen "Loading - please wait."

**Exit code 0 does not prove that an action succeeded.** It means that the child connected and exited with code 0, and that the state tap received state messages.

**In these runs, `inGame()` was not a readiness signal.** It waited only for `gameClient.ingame`. In the pinned rs-sdk client, `Client.ts` line 4331 sets `this.ingame = true` at login, and line 4355 sets `sceneState = 0` in the same block. The map is ready only at `sceneState = 2` (line 7778). On a region change the client sets `sceneState` back to 1 and shows "Loading - please wait." The better signal is `window.gameClient.sceneState === 2`. The current `inGame()` in `src/gamelink/game-tab.ts` also needs that value. This is a reading of the source. No test on a live page has confirmed it. [security.md](security.md) lists this gap.

## Sandbox check

On Ubuntu 26.04 with its defaults, the browser launch failed with `No usable sandbox!`. Phase `chrome` of the bootstrap installed an AppArmor profile. After that, the full test suite passed as the service user, and `chrome://sandbox` showed:

```
Layer 1 Sandbox	Namespace
PID namespaces	Yes
Network namespaces	Yes
Seccomp-BPF sandbox	Yes
Seccomp-BPF sandbox supports TSYNC	Yes
Ptrace Protection with Yama LSM (Broker)	Yes
Ptrace Protection with Yama LSM (Non-broker)	No

You are adequately sandboxed.
```

[deploy-server.md](deploy-server.md) explains the cause and the profile. [security.md](security.md) states the residual risk.

## Measure it yourself

Use the local stack. You do not need the demo world to get useful numbers.

```bash
bash scripts/dev-stack.sh
RS_ACCOUNT=prooflocal RS_PASSWORD=x bun scripts/measure.ts local
bash scripts/dev-stack.sh stop
```

- The tool runs on Linux only, because it reads `/proc`.
- `--quick` makes the run shorter: 10 s to settle and one sample of 10 s per scenario.
- The tool prints the table and writes `measurements/raw/measure-<mode>-<ISO date>.json`.
- A run against a remote game server needs mode `demo` and `RS_ALLOW_DEMO=1`, and holds a session for about 13 minutes. Read "Scripts that contact a remote game server" in [development.md](development.md) first.

A killed run can leave a directory `/tmp/puppeteer_dev_chrome_profile-*` that holds the game password. After a killed run, remove such directories.

## Open measurements

- The real API cost per day. It needs the agent loop.
- The Discord rate limit for an edit that replaces a picture.
- The time from a login to a loaded map (`sceneState === 2`).
- The CPU load on a 2-core server.
- The re-login test in its current form, with the wait before the reload.
