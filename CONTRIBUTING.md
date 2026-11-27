# Contributing

Thank you for your help. Before a large change, open an issue so that we can agree on the approach.

[docs/development.md](docs/development.md) has the tools, the local stack and the scripts.

## Checks

Run these before each commit. Both must pass.

```bash
bunx tsc --noEmit
bun test
```

- If you change a shell script, also run `shellcheck scripts/*.sh`.
- A change in behaviour needs a test.
- Test on the local stack. Do not test against the demo world or another game server that someone else runs.
- If you change `src/gamelink/game-tab.ts`, run the full `bun test` on your own machine and say so in the pull request.

CI has two jobs. `check` runs the type check, `shellcheck`, and the tests that do not launch Chromium. `browser-tests` runs all tests with the Chromium sandbox on.

## Rules

1. **Never print or commit a secret.** This means a game password, a token, an API key or a private key.
   - An error message names the variable, never its value.
   - A log line never holds a URL with a query. The game tab's URL holds the password.
   - A secret never goes on a command line.
   - Use the example values `prooflocal` and `x` for the local stack, and `mybot1` or `<account>` elsewhere.
2. **Never edit `vendor/`.** `vendor/rs-sdk` is a pinned submodule. To move the pin, make a commit that only moves the submodule. Name the old and the new commit in the message.
3. **Never disable the Chromium sandbox.** No `--no-sandbox` and no `--disable-setuid-sandbox`, in code, tests or CI.
4. **Never add game content.** No game art, sprites, screenshots, recordings or game fonts, in the repository or in an issue. A bundled font needs an open licence and its licence file.
5. **Never add details of your own deployment.** No server address, host name, account name or local path.
6. **Keep the documents true.** Do not describe a planned part as built. When your change closes a known gap, remove it from `docs/security.md`.

## Commit messages

- Start with an imperative verb: "Add", "Fix", "Remove".
- Keep the first line under 72 characters.
- Say what changed and why.
- Use the terms in [docs/design.md](docs/design.md#2-terms).

## Licence

Your contribution has the MIT licence of this project.
