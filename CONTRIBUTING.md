# Contributing

This project runs live but makes no claim that it is secure. [docs/roadmap.md](docs/roadmap.md) lists the milestones, and [docs/security.md](docs/security.md) lists the known gaps. Open an issue before you write a larger change, so that we can agree on the approach first.

## Set up

[docs/development.md](docs/development.md) has the tools, the local stack and the scripts.

## Checks before each commit

Run the type check and the tests before each commit. Both must pass.

```bash
bunx tsc --noEmit
bun test
```

- The CI workflow has two jobs. Job `check` runs the same two commands and skips the tests that launch Chromium. Job `browser-tests` runs all tests with the Chromium sandbox on. If you change `src/gamelink/game-tab.ts`, also run the full `bun test` on your own machine and say so in the pull request.
- A change in behaviour needs a test.
- Use the local stack for development. Do not test against the demo world or a different remote game server that someone else runs.

## Rules

1. **Never print or commit a secret.** This covers a game password, a token, an API key and a private key.
   - An error message names the variable, never its value.
   - A log line never holds a URL with a query, because the URL of the game tab holds the password.
   - A secret never goes on a command line.
   - Example values are `prooflocal` and `x` for the local stack, and `mybot1` or `<account>` in other examples.
2. **Never edit `vendor/`.** `vendor/rs-sdk` is a pinned submodule. To change the pin, make a commit that only moves the submodule, and name the old and the new commit in the message.
3. **Never disable the Chromium sandbox.** No `--no-sandbox` and no `--disable-setuid-sandbox`, in code, in tests or in CI.
4. **Never add game content.** No game art, sprites, screenshots, recordings or game fonts, in the repository or in an issue. A bundled font needs an open licence and its licence file.
5. **Never add a detail of your own deployment.** No server address, no host name, no account name, no path of your machine.
6. **Keep the documents true.** Do not describe a planned part as built. When your change closes a known gap, remove the gap from `docs/security.md`.

## Commit messages

- Write plain technical English in the active voice.
- Start with a verb in the imperative: "Add", "Fix", "Remove".
- Keep the first line below 72 characters.
- Say what changed and why. Use the terms from the terms table in the [README](README.md#terms).

## Licence

Your contribution has the MIT licence of this project. See [LICENSE](LICENSE).
