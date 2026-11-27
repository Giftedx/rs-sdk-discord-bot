# Roadmap

The work has seven milestones. Each milestone builds on the milestone before it. [design.md](design.md) describes the parts.

| Milestone | Delivers | State |
|---|---|---|
| 1. Base and measurements | The configuration loader, the action policy, the proxy, the game tab module, the local stack script, the proxy proof, the measurement tool, the idle test, and the server bootstrap with its AppArmor profile. | Done |
| 2. Gamelink service | Gamelink as a long-running service: it restarts a game tab that left the game, keeps an idle account logged in, stores a frame every 5 s, and has authenticated local interfaces. | Not started |
| 3. Box | The runner for AI-written code under systemd sandboxing, the built-in protections (eat at low HP, leave combat), the knowledge pack and the seed scripts. | Not started |
| 4. Orchestrator | The Discord intake, the queue, the agent loop, the tools, the notes, and the spend control. | Not started |
| 5. Discord output | The events, the status card, the adventure log and the posts in the main channel. | Not started |
| 6. Drawn cards | The card tab and the drawn cards. | Not started |
| 7. Deployment | The systemd units, the firewall, the backup, and the check on a live server. | Not started |

No milestone has a date.

## Known gaps

The code of milestone 1 has known limits. [security.md](security.md) lists each one under "Known gaps in the current code", with the milestone that must close it. The largest:

- The proxy has no handshake timeout and no health check for its gateway connection.
- The proxy retries a refused gateway login with no limit, no report and no log line.
- `inGame()` is true while the map still loads. The map is ready at `sceneState === 2`.
- The security helpers are in `scripts/`, not in `src/`.
- The box listener of the proxy has no backpressure limit.
- AI-written code would run as the same Unix user as the proxy. The box with its own user is not built.
