# Deploy to your own server

This page prepares an Ubuntu server with `scripts/server-bootstrap.sh`.

**After these steps, no bot runs yet.** [running-the-bot.md](running-the-bot.md) installs it. The server can then run the tests, the proxy proof and the measurement tool as the service user `rsbot`.

Read [security.md](security.md) before you start. It says which machine to use.

## Before you start

You need:

- A server with Ubuntu 26.04 LTS. This is the only tested version. The AppArmor profile uses `abi <abi/5.0>`.
- Enough CPU and RAM. The reference run used 4 vCPU and 8 GB RAM. There, one account used about 1.1 GB and 67% of one core ([measurements.md](measurements.md)). Nobody has tested a smaller server.
- An admin user that you reach with an SSH key and that can run `sudo` without a password prompt. The commands send the script to `sudo` on standard input, so `sudo` has no terminal for a prompt. Thus a stolen SSH key for that user gives root. This page has no tested alternative.
- A clone of this repository on your own machine, with git and an SSH client.
- For the optional first login: a game server that you may use. Read "Be a good guest on the demo world" in the [README](../README.md).

In the commands, replace these placeholders:

- `<user>`: your admin user.
- `<server>`: the address of your server.
- `<branch>`: the branch that you deploy, normally `main`.

## Steps

Run each command on your own machine, in the root of your clone. Root must never run the copy of the script on the server. "How root runs the script" says why.

0. Optional: check the SSH and sudo configuration. Phase `facts` changes nothing.

   ```bash
   ssh <user>@<server> 'sudo bash -c "$(cat)" bootstrap facts' < scripts/server-bootstrap.sh
   ```

1. Prepare your server. The output ends with `prepare done`.

   ```bash
   ssh <user>@<server> 'sudo bash -c "$(cat)" bootstrap prepare' < scripts/server-bootstrap.sh
   ```

2. Push your local branch to the bare repository on your server.

   ```bash
   git push --receive-pack='sudo -u rsbot git-receive-pack' <user>@<server>:/home/rsbot/repo.git <branch>
   ```

   Your server has no GitHub credentials. It installs the commit that you pushed, not a clone from GitHub. `--receive-pack` makes the receiving git run as `rsbot`, which owns the repository. The rs-sdk submodule still comes from GitHub, at the commit that this project pins.

3. Install the code. The output ends with `install done`.

   ```bash
   ssh <user>@<server> 'sudo bash -c "$(cat)" bootstrap install <branch>' < scripts/server-bootstrap.sh
   ```

4. Install Chrome and the AppArmor profile. The output ends with `chrome done`.

   ```bash
   ssh <user>@<server> 'sudo bash -c "$(cat)" bootstrap chrome' < scripts/server-bootstrap.sh
   ```

5. Run the tests on your server. The last lines show `0 fail`. The tests that launch Chromium prove that its sandbox starts.

   ```bash
   ssh <user>@<server> "sudo -u rsbot -H bash -lc 'cd /opt/rs-discord-bot && \$HOME/.bun/bin/bun test'"
   ```

6. Create the account file. Choose an account name that matches `^[a-z0-9]{1,12}$`. The name is public on the game server. Do not put the name of your Discord server in it.

   ```bash
   ssh <user>@<server> 'sudo -u rsbot bash -c "$(cat)" bootstrap create-account-env <account>' < scripts/server-bootstrap.sh
   ```

   The phase writes `RS_ACCOUNT=<account>` and `RS_PASSWORD=<password>` to `/opt/rs-discord-bot/secrets/account.env`.

   - The password has 20 characters from `A-Za-z0-9`, read from `/dev/urandom`. The rs-sdk client and engine refuse a longer password.
   - The phase keeps the password only in pipes, a shell variable and the `printf` builtin. It never appears on a command line or on the screen. The phase prints only the length.
   - If the file exists, the phase refuses to replace it.
   - The file alone does not create the account. On the rs-sdk gateway, the first authenticated login with an unknown name creates that account.

7. Save the account password. Nobody can recover or reset a lost password.

   Run this command on your own machine, outside any git repository and outside any folder that a cloud service synchronizes. It writes the file with mode 600 and does not show the password on the screen.

   ```bash
   ( umask 077; ssh <user>@<server> 'sudo cat /opt/rs-discord-bot/secrets/account.env' > "$HOME/account.env" )
   ```

   Put the content of `$HOME/account.env` into your password manager. Import the file, or open it only inside the password manager. Then delete `$HOME/account.env`.

To deploy a later commit, do steps 2 and 3 again. Restart the bot and gamelink together, so both run the same commit. An older gamelink ignores the game frame that a newer bot sends with the receipt card, and the Done message then has no game view.

## Optional: first login on a game server

This step logs the account in to the game server that the configuration names. The default is the rs-sdk demo world. Do it only if you may use that server. The first login creates the account permanently.

The scripts have two modes:

- Mode `local` always uses `ws://localhost:7780` and `http://localhost:8888/bot` and ignores the URL variables. It is for the local stack on a development machine. Do not start the local stack on your server ([development.md](development.md) says why).
- Mode `demo` uses the configuration as it is. The name `demo` here means "not the local stack".

To use your own remote game server, add `RS_SERVER_HOST`, `RS_GATEWAY_URL` and `RS_BOT_PAGE_URL` to `secrets/account.env`, and use mode `demo`. `RS_GATEWAY_URL` must start with `wss://` and `RS_BOT_PAGE_URL` with `https://`. Both must use the host of `RS_SERVER_HOST`, because both URLs get the game password.

Log in to your server as your admin user, and run:

```bash
sudo -u rsbot -H bash -lc 'cd /opt/rs-discord-bot && set -a && . secrets/account.env && set +a && "$HOME/.bun/bin/bun" scripts/proxy-proof.ts demo'
```

This command stops with a message, because `RS_ALLOW_DEMO` is not set. Put `RS_ALLOW_DEMO=1` before `"$HOME/.bun/bin/bun"` only if the person who runs the game server agreed, or if you run that server.

[development.md](development.md) explains the output. Never type the password on a command line.

## What the bootstrap changes

| Phase | Runs as | Changes |
|---|---|---|
| `facts` | root | Nothing. It prints the CPU count, the memory, the disk, the kernel, the OS and two sysctl values. |
| `prepare` | root | Installs the apt packages `git`, `unzip`, `curl`, `ca-certificates` and the libraries that Chrome needs. apt can upgrade these packages and install their dependencies. Creates the user `rsbot` with no sudo right. Installs Bun 1.3.14 in the home of `rsbot`. Creates the empty bare repository `/home/rsbot/repo.git`. |
| `install <branch>` | root, and `rsbot` for each step in the clone | Creates `/opt/rs-discord-bot` (owner `rsbot`, mode 750) and clones the branch with submodules into it, or updates the clone with `git reset --hard`. Creates `secrets/` (mode 700) and `measurements/raw/`. Runs `bun install --frozen-lockfile` with no browser download. Removes `/home/rsbot/.cache/puppeteer`. |
| `chrome` | root | Downloads Chrome for Testing to `/opt/rs-chrome/<version>/chrome-linux64/`, owned by `root:root`. Installs and loads `/etc/apparmor.d/rsbot-chrome-for-testing`. Sets `/home/rsbot/.cache` to mode 700. Writes `RS_CHROME_PATH` to `/opt/rs-discord-bot/server.env`. Adds one line to `/home/rsbot/.profile` that loads `server.env`. |
| `create-account-env <account>` | `rsbot` | Writes `/opt/rs-discord-bot/secrets/account.env` (mode 600) once. |

The script changes no sysctl value and no AppArmor profile that Ubuntu ships. It installs no firewall.

## How root runs the script

Each root phase runs like this:

```bash
ssh <user>@<server> 'sudo bash -c "$(cat)" bootstrap <phase>' < scripts/server-bootstrap.sh
```

Your machine sends the script text over SSH. The remote shell reads all of the text, then runs it as root.

**Run the phases only from a clone on your own machine, as shown.** Root never runs the copy of the script in `/opt/rs-discord-bot`. `rsbot` can write that directory, so a program that runs as `rsbot` could change that copy and get root at the next run.

Two downloads need your attention:

- **The Bun installer.** Phase `prepare` downloads it from `https://bun.sh/install` and runs it as `rsbot`, not as root. The script does not verify the installer.
- **Chrome.** Phase `chrome` downloads and unpacks the archive as root. It compares the checksum with a value in the script (see "The Chrome download and its checksum"). Root does not execute the downloaded Chrome. The version check of the phase runs as `rsbot`.

## The AppArmor profile

### Why the bootstrap installs it

Ubuntu 26.04 sets `kernel.apparmor_restrict_unprivileged_userns = 1`. With that setting, a program with no AppArmor profile that creates a user namespace moves to the profile `unprivileged_userns`, which denies all capabilities. The Chromium sandbox needs user namespaces. Without a profile, Chromium stops:

```
FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:128] No usable sandbox! If you are running on Ubuntu 23.10+ or another Linux distro that has disabled unprivileged user namespaces with AppArmor, see https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md. [...]
```

Ubuntu's own profiles for Chrome and Chromium cover the system install paths, such as `/opt/google/chrome/chrome`. They do not cover the path of the Chrome for Testing that puppeteer uses. These Ubuntu facts come from one 26.04 system.

This project never uses `--no-sandbox`, and it keeps the sysctl at 1. Phase `chrome` installs one profile for one root-owned copy of Chrome.

### What the profile does

- The profile is `/etc/apparmor.d/rsbot-chrome-for-testing`. The script holds the text. `deploy/apparmor/rsbot-chrome-for-testing` is the readable copy, and a test checks that the two are identical.
- The profile attaches to the program at `/opt/rs-chrome/*/chrome-linux64/chrome`.
- The profile allows everything (`flags=(unconfined)`) and allows user namespaces (`userns,`). The `chrome` profile on the observed Ubuntu system has the same form.
- The owner of the Chrome copy is `root:root`. Before the phase continues, it checks that `rsbot` cannot write the binary or any directory on the path to it.
- `rsbot` has no other Chrome. `bun install` runs with `PUPPETEER_SKIP_DOWNLOAD=1`, and the phase removes the puppeteer cache.
- If the file at `RS_CHROME_PATH` does not exist, the code stops with an error. It does not use a different Chrome.

### Residual risk

The profile does not confine Chrome. It only lets this one binary create user namespaces.

- The root-owned copy stops `rsbot` from replacing the Chrome program. The profile does not limit which code runs under its label.
- The directories and the binary have mode 755. Every local user on your server can run this Chrome, not only `rsbot`.
- Untested, but likely: any local user can get user namespaces through this Chrome by loading code into it, for example with `LD_PRELOAD`. The profile labels the binary, not the code inside it. Ubuntu's own `chrome` profile has the same property for `/opt/google/chrome/chrome`.
- User namespaces do not give root. They increase the part of the kernel that an unprivileged program can reach.
- An old version directory under `/opt/rs-chrome` keeps this permission until you remove it.

If you gave nobody else a login, four local users matter: your admin user, `rsbot` (the bot), `rsgame` (gamelink) and `rsbox` (the jobs). [running-the-bot.md](running-the-bot.md) makes `rsgame` and `rsbox`. The box user must not be able to create user namespaces or to see `/opt/rs-chrome`. That limit is not built yet.

A confined profile (with `userns` and a clean environment) is a possible later hardening.

## The Chrome download and its checksum

Phase `chrome` downloads `https://storage.googleapis.com/chrome-for-testing-public/<version>/linux64/chrome-linux64.zip` as root. Puppeteer uses the same source. The phase then does these checks:

1. It compares the SHA-256 of the archive with `CHROME_ZIP_SHA256` in the script.
2. It refuses an archive that holds a symbolic link, or anything other than `chrome-linux64/`.
3. It checks the owner and the modes under `/opt/rs-chrome`.

**The checksum is trust on first use.** Chrome for Testing publishes no SHA-256 for its archives. The value in the script is the SHA-256 of one download, whose MD5 matched the `x-goog-hash` header of the storage object. Verify the value yourself before you rely on it. The commands download a large archive, so run them in a temporary directory, not in your clone:

```bash
cd "$(mktemp -d)"
url=https://storage.googleapis.com/chrome-for-testing-public/148.0.7778.97/linux64/chrome-linux64.zip
curl -fsSL -o chrome-linux64.zip "$url"
openssl dgst -md5 -binary chrome-linux64.zip | base64
curl -sI "$url" | grep -i x-goog-hash
sha256sum chrome-linux64.zip
```

The first value must be equal to the `md5=` value of the header. The last value must be equal to `CHROME_ZIP_SHA256`.

If a puppeteer update brings a new Chrome version:

1. Set `CHROME_VERSION` in `scripts/server-bootstrap.sh`. `bun test` fails until it matches the Chrome of the pinned puppeteer.
2. Do the procedure above for the new version, and set `CHROME_ZIP_SHA256`.
3. Run phase `chrome` again. It writes the new `RS_CHROME_PATH`.
4. When nothing uses the old version, remove its directory under `/opt/rs-chrome`.

## Undo every change

If you want to keep the account, first save `secrets/account.env`.

```bash
# The AppArmor profile and the Chrome copy
sudo apparmor_parser -R /etc/apparmor.d/rsbot-chrome-for-testing
sudo rm /etc/apparmor.d/rsbot-chrome-for-testing
sudo rm -r /opt/rs-chrome

# The code, the account file and the results
sudo rm -r /opt/rs-discord-bot

# The user rsbot with its home: Bun, the bare repository, the .profile line and the caches
sudo userdel -r rsbot
```

The apt packages stay. If you do not need them, remove them with `apt`. The account on the game server also stays.

After you remove the profile, Chromium from `/opt/rs-chrome` cannot start with its sandbox.

## Hardening advice

This is general advice for a server on the internet. The bootstrap does none of it.

- Allow SSH login with keys only. Disable password login.
- Do not allow SSH login as root.
- Enable a firewall that allows inbound SSH only. The proxy listens on loopback only.
- Protect the SSH key of your admin user. That user has `sudo` without a password, so the key gives root.
- Install security updates.
- Do not give other people a login on your server. See "Residual risk".
- After a killed run, remove directories named `/tmp/puppeteer_dev_chrome_profile-*`. A Chrome profile holds the game password.
