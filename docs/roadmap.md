# Roadmap

The work has seven milestones. Each milestone builds on the milestone before it. [design.md](design.md) describes the parts.

| Milestone | Delivers | State |
|---|---|---|
| 1. Base and measurements | The configuration loader, the action policy, the proxy, the game tab module, the local stack script, the proxy proof, the measurement tool, the idle test, and the server bootstrap with its AppArmor profile. | Done |
| 2. Gamelink service | Gamelink as a long-running service: it restarts a game tab that left the game, keeps an idle account logged in, stores a frame every 5 s, and has authenticated local interfaces. | Partly built, in one process with the bot: the supervisor, logout, the frame store, the browser profile on tmpfs and the allow-list browser environment. No separate service and no local interfaces. |
| 3. Box | The runner for AI-written code under systemd sandboxing, the built-in protections (eat at low HP, leave combat), the knowledge pack and the seed scripts. | Mostly built: the job runner with a box user, the job cgroup limits (need `Delegate=yes`; not tested on a real unit), the protections (eat and run-away paths have unit tests only), the knowledge pack and 7 seed scripts (run on the local stack). No separate box process per account. |
| 4. Orchestrator | The Discord intake, the queue, the agent loop, the tools, the notes, and the spend control. | Built: several guilds in one process, the SQLite database (queue with recovery, spend per call, events, snapshots, timers), wakes on timers, low HP, death and the watchdog, the daily allowance, and the tools `set_timer`, `post`, `set_goal` and `escalate`. Checked with unit tests and the local smoke test; not yet run with a real model and Discord after these changes. |
| 5. Discord output | The events, the status card, the adventure log and the posts in the main channel. | Built and wired, unit tests only: the events, the status card, the adventure log, the posts and the daily recap. Not run against a real Discord server yet. |
| 6. Drawn cards | The card tab and the drawn cards. | Built: five card kinds, drawn in a real browser in the browser tests and the smoke test. Attached to posts and receipts; not yet seen in Discord. |
| 7. Deployment | The systemd units, the firewall, the backup, and the check on a live server. | Partly built: the bot unit with `Delegate=yes`, the firewall script, the backup and the revision check with their units. None of them has run on a live server yet. |

No milestone has a date.

## Known gaps

The code of milestone 1 has known limits. [security.md](security.md) lists each one under "Known gaps in the current code", with the milestone that must close it. The largest:

- `inGame()` reads `sceneState === 2`, but no test on a live page has confirmed that signal.
- The security helpers are in `scripts/`, not in `src/`.
