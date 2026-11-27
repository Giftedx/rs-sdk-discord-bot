# Roadmap

The work has seven milestones. Each one builds on the one before. All seven are built. [design.md](design.md) describes the parts.

"Live" means the part ran on the real server or in a real Discord server. "Not yet live" means the code and its tests are in this repository, but the part has not run on the server yet.

| Milestone | Delivers | Live | Not yet live |
|---|---|---|---|
| 1. Base | Configuration, action policy, proxy, game tab, local stack, proxy proof, measurement tool, server bootstrap. | All of it. | Nothing. |
| 2. Gamelink | A service that keeps the game tab logged in, stores a frame every 5 s, and serves a token-checked Unix socket. | Supervisor, logout, frame store, split mode as user `rsgame`. | Login back-off and `login_refused`, the direct gateway port, a lock file against a second gamelink, re-login on SIGHUP, the 256x256 portrait. |
| 3. Box | The job runner, the built-in protections (eat at low HP, leave combat), the knowledge pack and 7 seed scripts. | Jobs ran as the box user, with no access to secrets or the network. | The eat and run-away protections have unit tests only. |
| 4. Orchestrator | Plain-language intake, the queue, the agent loop, the tools, the notes and the spend control. | A question got an answer. A task ran 4 turns for $0.20 with the prompt cache in use. | Wiki search, the diary, per-guild spend shares, job time limits, the full-inventory wake, the daily notes review, queue votes. |
| 5. Discord output | Events, the status card, the adventure log, posts and the daily recap. | The status card, the adventure log and milestone posts. | The daily recap, the XP chart, the gallery thread, silent posts. |
| 6. Drawn cards | A card tab that draws five card kinds with item icons. | Receipt and milestone cards. | The level bar, the receipt tables, the killer line, the `xp_chart` card. |
| 7. Deployment | systemd units, firewall, daily backup, revision check, Discord alerts. | All of these run on the server, with the `rsgame` egress rules and the restore test. | The single-process unit and the Chrome prune script. |

No milestone has a date.

## Known gaps

[security.md](security.md) lists the limits that remain, under "Known gaps in the current code".
