# Roadmap

The work has seven milestones. Each milestone builds on the milestone before it. [design.md](design.md) describes the parts.

| Milestone | Delivers | State |
|---|---|---|
| 1. Base and measurements | The configuration loader, the action policy, the proxy, the game tab module, the local stack script, the proxy proof, the measurement tool, the idle test, and the server bootstrap with its AppArmor profile. | Done |
| 2. Gamelink service | Gamelink as a long-running service: it restarts a game tab that left the game, keeps an idle account logged in, stores a frame every 5 s, and has authenticated local interfaces. | Built: the supervisor, logout, the frame store, the browser profile on tmpfs, the allow-list browser environment, and in split mode a separate `rs-gamelink` service as its own Unix user with a token-checked Unix socket. Without split mode, the game parts run in the bot process. |
| 3. Box | The runner for AI-written code under systemd sandboxing, the built-in protections (eat at low HP, leave combat), the knowledge pack and the seed scripts. | Mostly built: the job runner with a box user, the job cgroup limits (on in the live service), the protections (eat and run-away paths have unit tests only), the knowledge pack and 7 seed scripts. One box user per server or per guild, not a separate box process per account. Live: the box user cannot read the secrets or reach the network, and a live task ran jobs through it. |
| 4. Orchestrator | The Discord intake, the queue, the agent loop, the tools, the notes, and the spend control. | Built: plain-language talk (a small model decides which messages are for the bot), several guilds in one process, the SQLite database (queue with recovery, spend per call, events, snapshots, timers), wakes on timers, low HP, death and the watchdog, the daily allowance, and the tools `set_timer`, `post`, `set_goal` and `escalate`. Live on the demo world: a question got an answer, and a task ran 4 turns for $0.20 with the prompt cache in use. |
| 5. Discord output | The events, the status card, the adventure log and the posts in the main channel. | Built: the events, the status card, the adventure log, the posts and the daily recap. Live: the status card was pinned, the adventure log thread got made, and milestone posts went out with cards. The daily recap has not run yet. |
| 6. Drawn cards | The card tab and the drawn cards. | Built: five card kinds with item icons from the game server. Live: receipt and milestone cards were posted in Discord. |
| 7. Deployment | The systemd units, the firewall, the backup, and the check on a live server. | Built: the bot unit with `Delegate=yes`, the firewall with egress rules for the box users, the daily backup with a copy script for a PC (`scripts/backup-pull.ps1`), the revision check, and a Discord warning when a unit fails. Live: all of them run on the server. |

No milestone has a date.

## Known gaps

The items of milestone 1 that this list named are closed: `inGame()` waits for `sceneState === 2`, which a live page on the demo world confirmed, and the security helpers are in `src/shared/script-secrets.ts`. [security.md](security.md) lists the limits that remain, under "Known gaps in the current code".
