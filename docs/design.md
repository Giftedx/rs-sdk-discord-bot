# Design

> **Design document.** Most parts on this page are built and run live. The parts with the mark **Planned** do not exist yet. The [README](../README.md) has the short status, and [roadmap.md](roadmap.md) has the order of the work.

Each section has a mark:

- **Built**: the code and its tests are in this repository. The text uses the present tense.
- **Partly built**: the section says which part exists.
- **Planned**: nothing of it exists yet. The text uses the future tense. It describes the intent, and it can change.

## 1. Intent

**Built.** People in one Discord channel direct an AI in plain words. The AI plays one shared game account on an rs-sdk game server. Each Discord server gets its own account and its own channel.

The goal is a bot that is fun to watch and that plays well without help. People must see what the AI does. The AI has the abilities that help it stay on task: saved scripts, notes, timers, game knowledge, and recovery from a stuck state.

The operator is the person who runs a deployment. The operator needs the agreement of the person who runs the game server. See "Be a good guest on the demo world" in the [README](../README.md).

## 2. Terms

All documents of this project use these terms with these meanings.

| Term | Meaning |
|---|---|
| the bot | The Discord bot (`src/bot/main.ts`). It runs as the Unix user `rsbot`. |
| account | The one game account that a Discord server shares. |
| bot page | The page `/bot` of an rs-sdk game server. It holds the rs-sdk browser client. |
| game tab | The bot page in headless Chromium. It stays logged in. |
| gateway | The rs-sdk service that connects SDK code to a game tab. |
| control connection | The one connection per account through which the gateway accepts actions. |
| gamelink | The process that holds the game password. It runs the game tab and the proxy. |
| proxy | The part between AI-written code and the gateway. It holds the game password. |
| action policy | The allow list of game actions that the proxy passes. |
| box | Where AI-written code runs: one job at a time, as the Unix user `BOX_USER`, through `sudo`. It holds no secret. |
| box stand-in | `scripts/box-standin.ts`, the child process that the measurement scripts start in place of a job. |
| boot token | A random value that the proxy accepts from the box in place of the game password. It changes at each start. |
| job | One run of AI-written code in the box. |
| orchestrator | The part of the bot that talks to Discord and to the AI API, keeps the queue and starts the jobs. |
| state message | One `sdk_state` message: the game state that the game tab sends through the gateway. |
| state tap | The copy of each state message that the proxy gives to a callback of its host process. The orchestrator reads it. |
| frame | One picture of the game from the game tab. |
| local stack | An rs-sdk game server on your own machine. `scripts/dev-stack.sh` starts and stops it. |
| demo world | The public rs-sdk game server `rs-sdk.maxbittker.com`. |
| remote game server | Any rs-sdk game server that is not the local stack. The demo world is one. |
| proxy proof | The script `scripts/proxy-proof.ts` and its run. |
| template script | `scripts/proof-script.ts`, a copy of the rs-sdk script template. The proxy proof runs it. |
| Chromium, Chrome | Chromium is the browser engine. Chrome for Testing is the build of it that puppeteer downloads. These documents say Chromium for the sandbox and the behaviour, and Chrome for the binary and its path. |
| guild | One Discord server that has the bot. |
| instruction | A request that a Discord user gives to the AI. |
| saved script | A TypeScript file that the AI wrote and kept for reuse. |
| seed script | A saved script that the project supplies at the start. |
| notes | The memory files that the AI reads and edits. |
| knowledge pack | Read-only game reference files that the AI can search. |
| event | One typed record of progress, such as a level-up or a death. |
| picture rig | The code in gamelink that makes frames from the game tab. |
| drawn card | A picture that the card tab draws from data and icons. It is not a frame. |
| card tab | A second Chromium tab that draws each drawn card. |
| status card | One pinned Discord message that shows the current state of the account. |
| adventure log | One Discord thread that gets one line for each event. |
| wake | One turn of the AI: a short loop of API calls and tool results. It ends when the AI starts a job or stops calling tools. |

## 3. Goals, non-goals and anti-goals

**Built.**

Goals:

1. A user talks to the bot in plain words in its channel. There are no commands. The AI acts on a request in the game.
2. The status card shows a frame, the goal, the current step and the HP. The bot edits it on a timer while an instruction runs.
3. The bot records each event in the adventure log. It posts to the main channel only for a rare event.
4. The AI writes free TypeScript against the rs-sdk `bot` and `sdk` objects. That code runs only in the box, as a job.
5. The AI starts with a knowledge pack and seed scripts. It keeps saved scripts and notes between restarts.
6. The bot runs 24 hours a day on one small server.
7. The bot stops its own API spend at a monthly spend cap that you set.
8. Any allowed user can end the current request in plain words, such as "stop that".

Non-goals for version 1:

- A live video stream or video clips.
- A modified copy of the game client.
- Kill events and quest events. The game state has no signal for them.
- Shared scripts between guilds.

Anti-goals. These results are failures, even if the bot works:

- Text from Discord or from game chat becomes code that runs outside the box.
- The Discord token or the API key is readable from the box.
- The bot spends API credit when nobody gave an instruction and no script needs help.
- The bot posts so often that the main channel is unusable.
- The account attacks other players or floods game chat.
- Chromium runs without its own sandbox on a server that also runs AI-written code.

## 4. What the design relies on in rs-sdk

Each fact below comes from the rs-sdk source at commit `3506b20`. Where a file is named, the fact is a reading of that file. No test of this project checks these facts, with one exception: `src/gamelink/policy.test.ts` compares the allow list of action types with the client source.

- The SDK never talks to the game server directly. A game client logs in and registers with the gateway under the account name. The SDK opens a second connection to the gateway with the name and the password.
- One account allows one `control` connection. A new one removes the old one (`server/gateway/gateway.ts`).
- An authenticated call for an unknown account name creates that account.
- The client and the engine refuse a password longer than 20 characters (`server/webclient/src/client/Client.ts`, "Password must be 1-20 characters.").
- The client draws on a 2D canvas with the ID `canvas`, 765 by 503 pixels. The game view is 512 by 334 at (4,4). The game tab checks the ID and the size of the canvas of the page that it loaded (`selfCheck`).
- The bot page stores the password in `localStorage`, and has a function that posts a screenshot to the game host (`server/engine/view/bot.ejs`).
- The client has a 10-minute idle logout. The server ignores it while `NODE_DEBUG` is on (see [measurements.md](measurements.md)).
- `ingame` is true before the map is loaded. The map is ready at `sceneState === 2` (`Client.ts`, lines 4331, 4355 and 7778).
- The rs-sdk README says that the demo world has no guarantee of uptime or of saved progress.

## 5. Architecture

**Built.** One server runs three kinds of process, each as its own Unix user under systemd, in split mode: the orchestrator (`src/bot/main.ts`, user `rsbot`), gamelink (`src/gamelink/main.ts`, user `rsgame`) and the jobs of the box (user `rsbox`). The orchestrator talks to gamelink over a Unix socket with a bearer token (`src/gamelink/service.ts`, `src/gamelink/client.ts`). Without `GAMELINK_SOCKET`, the orchestrator runs the game parts in its own process.

```
Discord  <-->  orchestrator  <-- sudo, stdout -->  box (jobs as BOX_USER)
AI API   <-->       |                              |
                    | token-checked Unix socket    | SDK protocol, one loopback port
                    v                              v
                 gamelink:  picture rig, card tab, proxy
                    |                              |
                    | headless Chromium            | one permanent control connection
                    v                              v
                 rs-sdk game server and gateway
```

Who holds which secret, in split mode:

| Secret | Holder | Never visible to |
|---|---|---|
| Discord token | orchestrator | gamelink, box |
| API key | orchestrator | gamelink, box |
| Game password | gamelink | box |

[security.md](security.md) says how much of this separation exists today.

### 5.1 Orchestrator

**Built** (`src/bot/main.ts`, `src/bot/guild.ts`, `src/orchestrator/`). One process serves all guilds of `GUILDS_FILE`, or one guild from the single-guild settings. It runs under Bun, with discord.js. The database (`src/orchestrator/db.ts`, bun:sqlite, `DATA_DIR/bot.sqlite`, migrations on `PRAGMA user_version`) holds the queue with recovery after a restart, the spend of each model call with its guild and instruction, the events, a state snapshot every 30 s while the account is in the game, and the timers. Events come from a comparison of state snapshots (`src/events/diff.ts`). Guilds that share a box user run one job at a time.

The orchestrator:

- Holds the Discord token and the API key.
- Receives each request and puts it in the queue of that guild.
- Runs the agent loop (section 6).
- Owns the notes, the saved scripts and the database.
- Starts each job through the job runner of the guild (`src/box/job-runner.ts`), as `BOX_USER` through `sudo`, and reads the result line. It runs one job at a time per guild.
- To end a job, sends SIGTERM to it. If the job does not end within a short grace time, it sends SIGKILL and kills every process of the box user.
- Turns the job flag of the proxy on at the start of each job and off at its end.
- Reads the state of the game and makes events from it.
- Cleans all text before the text goes to Discord (`src/shared/sanitize.ts`). It caps the length, breaks all mentions, and removes exact matches of its own secrets.
- Treats all text from the box and from the game as untrusted data.

### 5.2 Gamelink

In split mode, one gamelink process (`src/gamelink/main.ts`, user `rsgame`) serves all accounts on the server. Without `GAMELINK_SOCKET`, the same code runs in the bot process.

**Game tab. Built** as a module (`src/gamelink/game-tab.ts`):

- It launches headless Chromium with the Chromium sandbox on. It never uses `--no-sandbox`.
- It opens the bot page with the account name, the password, `fps` and `minimal`. The configuration refuses a client frame rate below 10.
- The password never appears on a command line, and navigation errors do not contain the URL.
- It reads `gameClient.ingame` (`inGame()`), reloads the page (`reload()`), and resets the idle timer of the client (`keepAlive()`).
- It blocks `POST /api/screenshot`.

**Built:** the supervisor (`src/gamelink/supervisor.ts`) reloads a tab that left the game and keeps an idle account logged in. Use this only on a game server that you run, or with the agreement of the person who runs it. Gamelink logs the account out before it closes a tab. In split mode, `rsgame-egress.service` limits the outbound network of `rsgame` to loopback, DNS and the game host. The browser profile is in a new directory on `/dev/shm` that the bot removes at the end (`src/gamelink/browser-profile.ts`). The browser environment is an allow list. One browser holds the game tabs of all guilds.

**Game tab. Planned:** Chromium will run as its own systemd unit, with its profile on a memory file system. Gamelink will attach to it, so a restart of gamelink will not log the account out.

**Picture rig. Partly built.** `frame('view')` returns the game view at 2 times the size with sharp pixels, 1024 by 668. `frame('full')` returns the complete canvas, 765 by 503. The rig copies the canvas to a second canvas and never draws on the game canvas. The frame store (`src/gamelink/frame-store.ts`) is **Built**: while an instruction runs and the tab is in the game, it stores one `view` frame every 5 seconds and keeps the last 12. The `look` tool and the status card use the newest stored frame.

**Card tab. Built** (`src/gamelink/card-tab.ts`, `src/cards/`). A second tab draws each drawn card (level-up, death, instruction receipt, daily recap, status) from a template and data. It writes text with `textContent` only, because item names and player names are untrusted. The card page loads nothing from the network. Item icons come from the sprite route of the game host (`/sprite/item/{id}.png`). The bot fetches them, checks that each one is a PNG of at most 64 KB, keeps them in memory, and gives them to the page as `data:` URLs. The skill icons are the `staticons` sprite sheets of the rs-sdk content (`src/cards/skill-icons.ts`). The card page cuts one icon per skill out of them.

**Proxy. Built** (`src/gamelink/proxy.ts`). Each guild has its own proxy:

- The proxy holds one `control` connection to the gateway and adds the real password there.
- The proxy listens on one loopback port. It accepts a connection from the box with the boot token, and answers the `sdk_connect` of the box itself.
- A restart of the box causes no new login and no new `control` connection.
- The proxy relays state messages to the box and actions to the gateway.
- The proxy checks each action against the action policy (section 7).
- If the job flag is off, the proxy refuses every action from the box. The job runner turns the flag on at the start of each job and off at its end. The proxy does not turn the flag off when the box disconnects: the SDK reconnects during a job.
- The proxy gives each state message to a callback. This copy is the state tap.

**Local interface. Built** (`src/gamelink/service.ts`). In split mode, gamelink serves HTTP and JSON on a Unix socket. Every request must carry the token. The orchestrator uses it to set the job flag, read the state, get frames and cards, and log out. With the flag off between jobs, code that a past job left behind cannot act. [security.md](security.md) lists the known gaps of the proxy.

### 5.3 Box

**Partly built.** The job runner (`src/box/job-runner.ts`) runs each job as `BOX_USER` through `sudo`, with the built-in protections (`src/box/protections.ts`) at the top of each job: at HP 40% or less the job eats the food that heals most; at 25% or less with no food it runs 10 tiles away from the attacker, at most once every 4 s. `protections.off()` turns them off. With `Delegate=yes`, all jobs share one cgroup with memory, process and CPU limits (`src/box/cgroup.ts`). `scripts/server-firewall.sh` limits the network of the box user to the proxy port. The 7 seed scripts in `seed/` (skip-tutorial, walk-to, bank-deposit-all, chop-and-bank, fish-and-cook, mine-and-bank, kill-chickens) go into the saved scripts of each guild at the start. Known SDK issue on the local stack: `bot.mineRock` can return "rejected" while the mining goes on; `mine-and-bank` waits for the ore.

Each job runs Bun with the rs-sdk `sdk/` code, and its gateway URL points at the proxy. A job holds no secret and does not have the game password. `scripts/box-standin.ts` stands in for a job in the measurement scripts.

Planned:

- One small writable scratch directory per box, which a restart empties.
- Read-only mounts: the saved scripts, the knowledge pack and the seed scripts.
- No view of the processes of other users.
- No way to create user namespaces.

## 6. The agent loop

**Built** (`src/agent/loop.ts`, `src/orchestrator/wakes.ts`, `src/orchestrator/budget.ts`): the wake rules below (an instruction, a timer, low HP below 30% with a re-arm at 40%, a death, and the watchdog that stops a job with no progress for `WATCHDOG_MINUTES`), at most 6 timer and trigger wakes per hour and guild, the daily allowance (the cap divided by the days of the period from `SPEND_RESET_DAY`), and the tools `set_timer`, `post`, `set_goal`, `escalate`, `notes_search` and `diary_append`. Before each wake the AI gets a short context block: the personality, the last diary lines, the goal, the queue, the tab status, HP, position and inventory. One instruction stops at `AI_MAX_INSTRUCTION_MIN` (`time_cap`). A trigger wake starts on `ESCALATION_MODEL`. Each guild has an equal share of the cap. The daily allowance is the cap that is left divided by the days left. At 80% of the share or the cap, the main loop runs on `SMALL_MODEL` with no escalation. The trigger state and the wake counts are in memory.

The AI does not run all day. The orchestrator makes a wake only for one of these:

- A new instruction arrives and no instruction runs.
- A job ends, with a result or with an error.
- A trigger fires, such as low HP or a death.
- The watchdog fires: no progress measure (XP, position, inventory) changed for a set time while a job runs.
- A timer that the AI set for itself fires.

The orchestrator reads the triggers from the game state. It does not trust the output of the box for them. If the queue is empty, the account waits and the bot spends nothing.

A long task runs as a saved script in a job. The AI wakes only when the job ends or a trigger fires. This is the main control on cost.

Tools of the AI:

| Tool | Effect |
|---|---|
| `run_code`, `run_script` | Start a job in the box, from new code or from a saved script. |
| `save_script`, `list_scripts`, `read_script`, `delete_script` | Manage saved scripts. |
| `search_knowledge` | Search the knowledge pack: the learnings and the titles of the vendored wiki pages (`vendor/rs-sdk/wiki`). |
| `notes_read`, `notes_write`, `notes_search` | Read, edit and search the notes. `notes_search` also searches `diary.md`. |
| `diary_append` | Add one dated line to `diary.md` (the last 200 lines are kept). The last 10 lines and the fixed `personality.md` go before each wake. |
| `look` | Get the newest frame as picture input. |
| `game_state` | Read the current game state. |
| `post`, `set_goal` | Write to the adventure log, and set the text of the status card. |
| `set_timer`, `finish`, `escalate` | Schedule a wake, finish an instruction, and request a stronger model. |

Some protections run as code in the box and do not wait for the AI: eat food at low HP, and leave combat at lower HP with no food. A job can turn that code off. The low-HP trigger in the orchestrator is independent of the box.

Spend control:

- The orchestrator records the token use and the cost of each model call.
- You set a monthly spend cap and the day of the month on which the count starts again.
- Each day has an allowance for timer and trigger wakes. If a day uses all of its allowance, the bot makes no more of these wakes that day.
- At 100% of the monthly spend cap, the bot takes no new requests and says so.
- Each user has a rate limit for requests (`USER_COOLDOWN_S`).

## 7. Action policy

**Built** (`src/gamelink/policy.ts`). The policy is an allow list. It passes only the action types that the pinned client supports. A type that is not on the list does not pass.

The policy refuses:

- `interactPlayer` and `spellOnPlayer`, the actions for a direct attack on a player and a direct trade with a player.
- A `say` or `privateMessage` text that starts with `::`. The client sends such a text as a command.
- Every action while the job flag is off.
- `say` and `privateMessage` above 6 messages per minute.

Stated limits: the policy checks the action type, the `::` prefix and the chat rate. It does not inspect the other arguments of an action or the content of chat. So it cannot refuse a harmful use of an allowed action, such as a sale of items at a low price. [security.md](security.md) lists what the policy cannot refuse, and has the whole security model.

## 8. Discord behaviour

**Built** (`src/discord/`, wired in `src/bot/guild.ts`): the status card with a **Status** button, the adventure log thread, the gallery thread, the posts in the main channel with drawn cards, the daily recap, the queue votes, and the receipt card on the message of each instruction. All text goes through `sanitizeForDiscord` with no pings. The pinned card, the posts with cards, the adventure log, questions and tasks ran live on a real Discord server. The daily recap, the gallery and the queue votes have unit tests only.

The bot has no commands and no admin through Discord. It uses three places: the status card, the adventure log, and rare posts in the main channel.

- **Requests.** People talk to the bot in plain words, with or without an @mention. A small model decides if a message talks to the bot, and if it is a request, a question or "stop". The bot confirms a request with a reaction. One request runs at a time, and the others wait in a queue with a size limit. A request has a time limit and a spend limit. "Stop that" in plain words ends the current request and kills its job.
- **Status card.** One pinned message per guild. It shows a frame, the goal, the current step, the HP, the queue and the budget. The **Status** button shows more detail. While an instruction runs, the bot edits the card on a timer.
- **Adventure log.** One thread. Each event is one line, made from a template with no wake. The bot sends each line with no ping.
- **Posts in the main channel.** A level milestone, a death, a receipt when an instruction ends, and a daily recap. A hard limit caps these posts per hour.
- **Alerts.** Warnings for the operator go only to the private channel `ALERT_CHANNEL_ID`, never to the player channel.

Events come from a comparison of state snapshots in the orchestrator, not from the AI: a level-up, a death, an item gain, and a finished instruction.

Rule for all pictures: this repository holds no game art. The bot gets item icons from the game host at run time. The skill icons are the client sprite sheets `staticons` and `staticons2` of the rs-sdk submodule, read from `vendor/` at run time. A font must have an open licence. The card page uses the system font Inter (package `fonts-inter`) and loads no font file.

## 9. Operations

**Built.** `scripts/server-bootstrap.sh` prepares a server ([deploy-server.md](deploy-server.md)). [running-the-bot.md](running-the-bot.md) has the install steps. These units are in `deploy/systemd/` and run live on the server:

- `rs-discord-bot.service` (split mode, with `Delegate=yes` for the job cgroup), or `rs-discord-bot-single.service` (one process).
- `rs-gamelink.service`: gamelink, as `rsgame`.
- `rsbox-egress.service`: the egress firewall of the box user (`scripts/server-firewall.sh`).
- `rsgame-egress.service` and `rsgame-egress.timer`: the egress firewall of gamelink, with an hourly refresh.
- `rs-backup.service` and `rs-backup.timer`: a daily backup of `secrets/`, `data/` and `/etc/rs-gamelink` (`scripts/server-backup.sh`).
- `rs-revision-check.service` and `rs-revision-check.timer`: a check for a new revision of the game server (`scripts/server-revision-check.sh`).
- `rs-alert@.service`: one warning to `ALERT_CHANNEL_ID` when a unit fails and is still down 5 minutes later (`scripts/server-alert.sh`).

Planned: a separate systemd unit for Chromium, and one box process per account.

Development uses the local stack ([development.md](development.md)).
