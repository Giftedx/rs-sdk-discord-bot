# Copies the newest backup of the bot from the server to this PC, so that a copy exists
# outside the server. Run it on Windows (PowerShell 7). The backups hold secrets: keep
# -Destination outside any git repository and on a disk that only you can read.
#   pwsh scripts/backup-pull.ps1 -Server admin@203.0.113.10 -KeyPath ~/.ssh/id_ed25519 -Destination D:\rs-bot-backups
# It keeps the newest -Keep files in -Destination. The server makes one backup a day
# (deploy/systemd/rs-backup.timer). To run it each day, add it to Task Scheduler.
param(
  [Parameter(Mandatory)] [string] $Server,
  [Parameter(Mandatory)] [string] $KeyPath,
  [Parameter(Mandatory)] [string] $Destination,
  [int] $Keep = 30
)
$ErrorActionPreference = 'Stop'
$ssh = @('-i', $KeyPath, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', $Server)
$name = (& ssh @ssh 'sudo ls -1t /var/backups/rs-discord-bot/ | head -n 1').Trim()
if ($name -notmatch '^rs-discord-bot-[0-9TZ]+\.tar\.gz$') { throw "No backup found on the server (got '$name')." }
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$target = Join-Path $Destination $name
if (Test-Path $target) { Write-Output "Already here: $target"; exit 0 }
$tmp = "$target.part"
# Binary-safe copy: cmd's > keeps the bytes as they are.
cmd /c "ssh -i `"$KeyPath`" -o BatchMode=yes -o IdentitiesOnly=yes $Server `"sudo cat /var/backups/rs-discord-bot/$name`" > `"$tmp`""
if ($LASTEXITCODE -ne 0) { Remove-Item -Force $tmp -ErrorAction SilentlyContinue; throw "Copy failed." }
$remoteSize = [int64](& ssh @ssh "sudo stat -c %s /var/backups/rs-discord-bot/$name").Trim()
if ((Get-Item $tmp).Length -ne $remoteSize) { Remove-Item -Force $tmp; throw "Size differs from the server copy." }
Move-Item -Force $tmp $target
Get-ChildItem $Destination -Filter 'rs-discord-bot-*.tar.gz' | Sort-Object Name -Descending | Select-Object -Skip $Keep | Remove-Item -Force
Write-Output "Copied $name ($remoteSize bytes) to $Destination"
