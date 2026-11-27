# Third-party notices

This project uses the work of other projects. This file lists each one, where this repository uses it, and its licence.

## rs-sdk

- Source: <https://github.com/MaxBittker/rs-sdk>
- Licence: MIT
- Pinned commit: `3506b20cc767c6284375fb30390cb47b098d2c12`

This repository uses rs-sdk in two places:

- `vendor/rs-sdk` is a git submodule that points at the rs-sdk repository. This repository does not change any file in it. A source archive from GitHub does not contain the submodule.
- `scripts/proof-script.ts` is a copy of the rs-sdk file `bots/_template/script.ts`. The copy has two changes: an attribution header, and the path of the import.

The rs-sdk licence, copied from `vendor/rs-sdk/LICENSE`:

```
MIT License

Copyright (c) 2025 Lost City

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## AppArmor profile form

`deploy/apparmor/rsbot-chrome-for-testing` has the same form as the `chrome` profile that Ubuntu 26.04 installs in `/etc/apparmor.d/chrome`. The two files share a few lines of standard profile syntax. The profile name, the program path and the comments at the top are from this project.

## Run-time dependencies

`package.json` and `bun.lock` list the npm packages that `bun install` downloads. Each package has its own licence in `node_modules/`. This repository does not contain a copy of any of them.

`bun install` (through puppeteer) and phase `chrome` of `scripts/server-bootstrap.sh` download Chrome for Testing from Google. This repository does not contain a copy of it.

## Game content

This repository contains no game art, no sprites, no screenshots, no recordings and no game fonts. See `CONTRIBUTING.md`.
