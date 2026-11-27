# Design

> **Design document.** Most of this page describes parts that are planned. Only the parts with the mark **Built** exist in this repository. The [README](../README.md) has the short status, and [roadmap.md](roadmap.md) has the order of the work.

Each section has a mark:

- **Built**: the code and its tests are in this repository. The text uses the present tense.
- **Partly built**: the section says which part exists.
- **Planned**: nothing of it exists yet. The text uses the future tense. It describes the intent, and it can change.

## 1. Intent

**Planned.** People in one Discord channel will direct an AI. The AI will play one shared game account on an rs-sdk game server. Each Discord server will get its own account and its own channel.

The goal is a bot that is fun to watch and that plays well without help. People must see what the AI does. The AI will get the abilities that help it stay on task: saved scripts, notes, timers, game knowledge, and recovery from a stuck state.

The operator is the person who runs a deployment. The operator needs the agreement of the person who runs the game server. See "Be a good guest on the demo world" in the [README](../README.md).

## 2. Terms

The [README](../README.md#terms) has the terms of the built parts: account, bot page, game tab, gateway, control connection, gamelink, proxy, action policy, box, box stand-in, boot token, job, orchestrator, state message, state tap and frame. This table adds the terms of the planned parts.

| Term | Meaning |
|---|---|
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

**Planned.**

Goals:

1. A user will give an instruction with an @mention or a slash command. The AI will act on it in the game.
2. The status card will show a frame, the goal, the current step and the HP. The bot will edit it on a timer.
3. The bot will record each event in the adventure log. It will post to the main channel only for a rare event.
4. The AI will write free TypeScript against the rs-sdk `bot` and `sdk` objects. That code will run only in the box.
5. The AI will start with a knowledge pack and seed scripts. It will keep saved scripts and notes between restarts.
6. The bot will run 24 hours a day on one small server.
7. The bot will stop its own API spend at a monthly spend cap that you set.
8. Any allowed user will be able to stop the current instruction with one button.

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

**Partly built.** One server will run three kinds of process. In the design, each kind runs as a different Unix user under systemd. Today only the proxy and the game tab module of gamelink exist, as library code that the scripts in `scripts/` run in one process.

```
Discord  <-->  orchestrator  <-- stdio JSON -->  box (one per account)
AI API   <-->       |                              |
                    | local interface              | SDK protocol, one loopback port
                    v                              v
                 gamelink:  picture rig, card tab, proxy
                    |                              |
                    | headless Chromium            | one permanent control connection
                    v                              v
                 rs-sdk game server and gateway
```

Who will hold which secret:

| Secret | Holder | Never visible to |
|---|---|---|
| Discord token | orchestrator | gamelink, box |
| API key | orchestrator | gamelink, box |
| Game password | gamelink | box |

[security.md](security.md) says how much of this separation exists today.

### 5.1 Orchestrator

**Planned.** One process will serve all guilds.

- It will hold the Discord token and the API key. The design names no AI provider.
- It will receive each instruction and put it in the queue of that guild.
- It will run the agent loop (section 6).
- It will own the notes, the saved scripts and the database. The database will hold the queue, the spend record, the events and the state snapshots.
- It will send each job to the box as one line of JSON, and read the result. It will run one job at a time per box.
- To end a job, it will first ask the box to abort. If the job does not end within a short grace time, it will kill the box, and systemd will start the box again.
- It will tell the proxy when a job starts and when it ends.
- It will read the state tap and make events from it.
- It will clean all text before the text goes to Discord: cap the length, remove mass mentions, and remove exact matches of its own secrets.
- It will treat all text from the box and from the game as untrusted data.

Open question: whether discord.js runs under Bun. If it does not, the orchestrator will run under Node.

### 5.2 Gamelink

In the design, one gamelink process serves all accounts on the server.

**Game tab. Built** as a module (`src/gamelink/game-tab.ts`):

- It launches headless Chromium with the Chromium sandbox on. It never uses `--no-sandbox`.
- It opens the bot page with the account name, the password, `fps` and `minimal`. The configuration refuses a client frame rate below 10.
- The password never appears on a command line, and navigation errors do not contain the URL.
- It reads `gameClient.ingame` (`inGame()`), reloads the page (`reload()`), and resets the idle timer of the client (`keepAlive()`).
- It blocks `POST /api/screenshot`.

**Game tab. Planned:**

- Chromium will run as its own systemd unit, with its profile on a memory file system. Gamelink will attach to it, so a restart of gamelink does not log the account out.
- Gamelink will supervise each game tab. If a tab is not in the game for a set time, gamelink will reload it after more than 10 s with random jitter. This step will make no wake.
- While the account waits, gamelink will keep it logged in. Use this only on a game server that you run, or with the agreement of the person who runs it.
- Gamelink will log the account out before it closes a tab.
- Outbound network access will be limited to the game host.

**Picture rig. Partly built.** `frame('view')` returns the game view at 2 times the size with sharp pixels, 1024 by 668. `frame('full')` returns the complete canvas, 765 by 503. The rig copies the canvas to a second canvas and never draws on the game canvas. Planned: a loop that will store one `view` frame every 5 seconds while an instruction runs, and keep the last 12.

**Card tab. Planned.** A second tab will draw each drawn card from a template and data. It will write text with `textContent` only, because item names and player names are untrusted.

**Proxy. Built** (`src/gamelink/proxy.ts`), for one account in one process:

- The proxy holds one `control` connection to the gateway and adds the real password there.
- The proxy listens on one loopback port. It accepts a connection from the box with the boot token, and answers the `sdk_connect` of the box itself.
- A restart of the box causes no new login and no new `control` connection.
- The proxy relays state messages to the box and actions to the gateway.
- The proxy checks each action against the action policy (section 7).
- If the job flag is off, the proxy refuses every action from the box. The host process sets the flag. No built code sets it to off after a job.
- The proxy gives each state message to a callback. This copy is the state tap.

**Proxy. Planned:** an authenticated local interface for the job flag and the state tap, because the orchestrator will be a different process. With the flag off between jobs, code that a past job left behind will not be able to act. [security.md](security.md) lists the known gaps of the proxy.

### 5.3 Box

**Planned.** One process per account. Today `scripts/box-standin.ts` and the child process of `scripts/proxy-proof.ts` stand in for it. This box stand-in runs as the same Unix user as the proxy, with no sandbox.

- The box will run Bun with the rs-sdk `sdk/` code. Its gateway URL will point at the proxy.
- The box will hold no secret. It will not have the game password.
- The box will have one small writable scratch directory. A restart of the box will empty it.
- The box will have read-only mounts: the saved scripts, the knowledge pack and the seed scripts.
- The box will not see the processes of other users.
- The box will reach only the one loopback port of the proxy. It will not reach the debug port of Chromium.
- systemd will limit its memory, its CPU share and its number of tasks. It will not be able to create user namespaces.

## 6. The agent loop

**Planned.**

The AI will not run all day. The orchestrator will make a wake only for one of these:

- A new instruction arrives and no instruction runs.
- A job ends, with a result or with an error.
- A trigger fires, such as low HP or a death.
- The watchdog fires: no progress measure (XP, position, inventory) changed for a set time while a job runs.
- A timer that the AI set for itself fires.

The orchestrator will read the triggers from the state tap. It will not trust the output of the box for them. If the queue is empty, the account will wait and the bot will spend nothing.

A long task will run as a saved script in a job. The AI will wake only when the job ends or a trigger fires. This is the main control on cost.

Tools that the AI will get:

| Tool | Effect |
|---|---|
| `run_code`, `run_script` | Start a job in the box, from new code or from a saved script. |
| `save_script`, `list_scripts`, `read_script`, `delete_script` | Manage saved scripts. |
| `search_knowledge` | Search the knowledge pack. |
| `notes_read`, `notes_write`, `notes_search` | Read, edit and search the notes. |
| `look` | Get the newest frame as picture input. |
| `post`, `set_goal` | Write to the adventure log, and set the text of the status card. |
| `set_timer`, `queue_done`, `escalate` | Schedule a wake, finish an instruction, and request a stronger model. |

Some protections will run as code in the box and will not wait for the AI: eat food at low HP, and leave combat at lower HP with no food. A job will be able to remove that code. The low-HP trigger in the orchestrator will be independent of the box.

Spend control:

- The orchestrator will record the token use and the cost of each wake.
- You will set a monthly spend cap and the day of the month on which the count starts again.
- Each day will have an allowance. If a day uses all of its allowance, the bot will make no more wakes that day.
- At 100% of the monthly spend cap, the bot will make no wakes. The status card will show the reason.
- Each user will have a rate limit for instructions.

## 7. Action policy

**Built** (`src/gamelink/policy.ts`). The policy is an allow list. It passes only the action types that the pinned client supports. A type that is not on the list does not pass.

The policy refuses:

- `interactPlayer` and `spellOnPlayer`, the actions for a direct attack on a player and a direct trade with a player.
- A `say` or `privateMessage` text that starts with `::`. The client sends such a text as a command.
- Every action while the job flag is off.
- `say` and `privateMessage` above 6 messages per minute.

Stated limits: the policy checks the action type, the `::` prefix and the chat rate. It does not inspect the other arguments of an action or the content of chat. So it cannot refuse a harmful use of an allowed action, such as a sale of items at a low price. [security.md](security.md) lists what the policy cannot refuse, and has the whole security model.

## 8. Discord behaviour

**Planned.** The bot will use three places: the status card, the adventure log, and rare posts in the main channel.

- **Instructions.** A user will write `@bot get 40 woodcutting` or use a slash command. The bot will confirm with a reaction. One instruction will run at a time, and the others will wait in a queue with a size limit. One instruction will have a time limit and a spend limit.
- **Status card.** One pinned message per guild. It will show a frame, the goal, the current step, the HP, the queue and the budget. It will have buttons, and **Stop** will end the current instruction. While an instruction runs, the bot will edit the card on a timer. If the account waits, the bot will not edit it.
- **Adventure log.** One thread. Each event will be one line, made from a template with no wake. The bot will send each line with no ping.
- **Posts in the main channel.** A level milestone, a death, a receipt when an instruction ends, and a daily recap. A hard limit will cap these posts per hour.

Events will come from a comparison of state snapshots in the orchestrator, not from the AI: a level-up, a total level milestone, a death, an item gain, and a finished instruction.

Rule for all pictures: this repository holds no game art. The bot will get icons from the game host at run time, and a bundled font must have an open licence.

## 9. Operations

**Partly built.** `scripts/server-bootstrap.sh` prepares a server ([deploy-server.md](deploy-server.md)). Planned: systemd units for the orchestrator, gamelink, Chromium and one box per account, a firewall, a backup of the passwords, the notes and the database, and a check for a new revision of the game server.

Development uses the local stack ([development.md](development.md)).
